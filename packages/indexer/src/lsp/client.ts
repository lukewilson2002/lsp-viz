/**
 * LSP client wrapper around one spawned language-server child process.
 *
 * Language-agnostic: the command comes from `adapter.lspCommand`, framing from
 * vscode-jsonrpc, and types from vscode-languageserver-protocol. The client
 * survives crashes: when the child dies, every pending and subsequent request
 * rejects with {@link LspDeadError} (never hangs), and `restart()` brings up a
 * fresh child with a new generation.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import type { MessageConnection } from 'vscode-jsonrpc/node';
import {
  CallHierarchyOutgoingCallsRequest,
  CallHierarchyPrepareRequest,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DocumentSymbolRequest,
  ExitNotification,
  HoverRequest,
  InitializedNotification,
  InitializeRequest,
  ShutdownRequest,
  WorkspaceSymbolRequest,
} from 'vscode-languageserver-protocol';
import type {
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  DocumentSymbol,
  Hover,
  InitializeParams,
  Position,
  SymbolInformation,
} from 'vscode-languageserver-protocol';
import type { LanguageAdapter } from '../types.js';

/** A request failed because the server process died or was replaced. */
export class LspDeadError extends Error {
  constructor(message = 'language server process is not alive') {
    super(message);
    this.name = 'LspDeadError';
  }
}

export interface LspExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Which spawn generation exited. */
  generation: number;
  /** True when the exit was requested via dispose()/restart() (not a crash). */
  expected: boolean;
}

export interface LspClientOptions {
  /** Called whenever the child process exits — crash detection for the caller. */
  onExit?: (info: LspExitInfo) => void;
  /** Warm-up no-op request timeout in ms (default 5000). */
  warmupTimeoutMs?: number;
}

interface Session {
  child: ChildProcess;
  connection: MessageConnection;
  generation: number;
  alive: boolean;
  expectExit: boolean;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * Convert a `file://` URI to a repo-relative posix path, or null when the
 * target lies outside the repo (or is not a file URI at all).
 */
export function uriToRepoRelative(uri: string, repoRoot: string): string | null {
  if (!uri.startsWith('file:')) return null;
  let fsPath: string;
  try {
    fsPath = fileURLToPath(uri);
  } catch {
    return null;
  }
  const rel = path.relative(path.resolve(repoRoot), fsPath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

export class LspClient {
  private session: Session | null = null;
  private generationCounter = 0;
  private disposed = false;

  constructor(
    private readonly adapter: LanguageAdapter,
    private readonly repoRoot: string,
    private readonly options: LspClientOptions = {},
  ) {}

  /** True while the current child process is running. */
  get alive(): boolean {
    return this.session?.alive === true;
  }

  /** Pid of the current child process (tests use this to SIGKILL it). */
  get pid(): number | undefined {
    return this.session?.child.pid;
  }

  /** Monotonic spawn counter; bumps on every (re)start. */
  get generation(): number {
    return this.generationCounter;
  }

  /** Spawn + initialize + initialized + warm-up. No-op if already alive. */
  async start(): Promise<void> {
    if (this.disposed) throw new Error('LspClient has been disposed');
    if (this.session?.alive) return;

    const generation = ++this.generationCounter;
    const { command, args } = this.adapter.lspCommand(this.repoRoot);
    const child = spawn(command, [...args], {
      cwd: this.repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (!child.stdout || !child.stdin) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      throw new Error('language server did not expose stdio pipes');
    }
    // Drain stderr so the child never blocks on a full pipe.
    child.stderr?.on('data', () => {});

    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
    );
    const session: Session = { child, connection, generation, alive: true, expectExit: false };

    const markDead = (): void => {
      if (!session.alive) return;
      session.alive = false;
      try {
        // Rejects all pending requests on this connection.
        connection.dispose();
      } catch {
        // already disposed
      }
    };
    child.on('error', markDead);
    child.on('exit', (code, signal) => {
      const expected = session.expectExit;
      markDead();
      this.options.onExit?.({ code, signal, generation, expected });
    });
    connection.onClose(markDead);
    connection.onError(() => {});
    // Tolerate server-initiated traffic we don't care about.
    connection.onNotification(() => {});
    connection.onRequest(() => null);
    connection.listen();

    this.session = session;

    const rootUri = pathToFileURL(this.repoRoot).toString();
    const params: InitializeParams = {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.repoRoot) }],
      capabilities: {
        textDocument: {
          documentSymbol: {
            // IMPORTANT: we want DocumentSymbol[] with children, not flat SymbolInformation.
            hierarchicalDocumentSymbolSupport: true,
          },
          hover: { contentFormat: ['plaintext', 'markdown'] },
          callHierarchy: {},
        },
        workspace: { workspaceFolders: true, symbol: {} },
      },
      initializationOptions: {},
    };

    await this.request(session, (conn) => conn.sendRequest(InitializeRequest.type, params));
    await this.request(session, (conn) =>
      conn.sendNotification(InitializedNotification.type, {}),
    );

    // Warm-up: a no-op request awaited (bounded); some servers need a beat
    // before real traffic. Failures here are non-fatal — first-file retries in
    // the semantic phase cover slow starters.
    const warmup = this.request(session, (conn) =>
      conn.sendRequest(WorkspaceSymbolRequest.type, { query: '' }),
    ).then(
      () => undefined,
      () => undefined,
    );
    await Promise.race([warmup, delay(this.options.warmupTimeoutMs ?? 5000)]);
  }

  /** Kill the current child (if any) and bring up a fresh one. */
  async restart(): Promise<void> {
    await this.shutdownSession();
    await this.start();
  }

  async openDocument(relPath: string, text: string): Promise<void> {
    const session = this.currentSession();
    await this.request(session, (conn) =>
      conn.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: {
          uri: this.uriFor(relPath),
          languageId: this.adapter.id,
          version: 1,
          text,
        },
      }),
    );
  }

  async closeDocument(relPath: string): Promise<void> {
    const session = this.currentSession();
    await this.request(session, (conn) =>
      conn.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: { uri: this.uriFor(relPath) },
      }),
    );
  }

  async documentSymbols(relPath: string): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
    const session = this.currentSession();
    return this.request(session, (conn) =>
      conn.sendRequest(DocumentSymbolRequest.type, {
        textDocument: { uri: this.uriFor(relPath) },
      }),
    );
  }

  async hover(relPath: string, position: Position): Promise<Hover | null> {
    const session = this.currentSession();
    return this.request(session, (conn) =>
      conn.sendRequest(HoverRequest.type, {
        textDocument: { uri: this.uriFor(relPath) },
        position,
      }),
    );
  }

  async prepareCallHierarchy(
    relPath: string,
    position: Position,
  ): Promise<CallHierarchyItem[] | null> {
    const session = this.currentSession();
    return this.request(session, (conn) =>
      conn.sendRequest(CallHierarchyPrepareRequest.type, {
        textDocument: { uri: this.uriFor(relPath) },
        position,
      }),
    );
  }

  async outgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[] | null> {
    const session = this.currentSession();
    return this.request(session, (conn) =>
      conn.sendRequest(CallHierarchyOutgoingCallsRequest.type, { item }),
    );
  }

  /** Graceful shutdown (bounded), then hard kill. Client unusable afterwards. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.shutdownSession();
  }

  // ------------------------------------------------------------------ private

  private uriFor(relPath: string): string {
    return pathToFileURL(path.join(this.repoRoot, relPath)).toString();
  }

  private currentSession(): Session {
    const session = this.session;
    if (!session || !session.alive) throw new LspDeadError();
    return session;
  }

  /**
   * Run one request/notification against a captured session. Any rejection
   * that coincides with the process dying (or the session being replaced by a
   * restart — the generation check) surfaces as {@link LspDeadError}.
   */
  private async request<T>(
    session: Session,
    fn: (conn: MessageConnection) => Promise<T>,
  ): Promise<T> {
    if (!session.alive) throw new LspDeadError();
    try {
      return await fn(session.connection);
    } catch (error) {
      if (!session.alive || this.session !== session) throw new LspDeadError();
      throw error;
    }
  }

  private async shutdownSession(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (!session) return;
    session.expectExit = true;
    if (session.alive) {
      try {
        await Promise.race([
          (async () => {
            await session.connection.sendRequest(ShutdownRequest.type);
            await session.connection.sendNotification(ExitNotification.type);
          })(),
          delay(1000),
        ]);
      } catch {
        // The server is dying anyway; fall through to the hard kill.
      }
    }
    session.alive = false;
    try {
      session.connection.dispose();
    } catch {
      // already disposed
    }
    if (session.child.exitCode === null && session.child.signalCode === null) {
      try {
        session.child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}
