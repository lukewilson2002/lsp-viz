/**
 * Structural phase: tree-sitter based. Builds the containment tree (workspace
 * root → packages → directories → files) and file-level `imports` edges from
 * the adapter's import/export queries. Fast and sequential — this layer alone
 * makes the graph browsable (L1–L3).
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { GraphEdge, GraphNode, GraphStore } from '@lsp-viz/core';
import { ROOT_NODE_ID, edgeId, nodeId } from '@lsp-viz/core';
import { captureAll, getLanguage, withTree } from './treesitter.js';
import type {
  IndexProgressEvent,
  LanguageAdapter,
  ResolveContext,
  WorkspacePackage,
} from './types.js';

export interface StructuralContext {
  repoRoot: string;
  store: GraphStore;
  adapter: LanguageAdapter;
  packages: readonly WorkspacePackage[];
  /** Files (repo-relative, posix) to process in this phase. */
  files: readonly string[];
  /** Every known source file in the repo — import targets must be members. */
  allFiles: ReadonlySet<string>;
  /** Progress reporting across adapters: total files and already-done offset. */
  filesTotal: number;
  filesDoneBase: number;
  emit: (e: IndexProgressEvent) => void;
  isCancelled: () => boolean;
}

interface Container {
  id: string;
  /** Repo-relative dir path ('' for the workspace root / root package). */
  dir: string;
}

export function fileNodeId(relPath: string): string {
  return nodeId(relPath, 'file', path.posix.basename(relPath));
}

/** The package owning a file: longest matching dir prefix (dir '' matches all). */
function owningPackage(
  relPath: string,
  packages: readonly WorkspacePackage[],
): WorkspacePackage | null {
  let best: WorkspacePackage | null = null;
  for (const pkg of packages) {
    if (pkg.dir !== '' && relPath !== pkg.dir && !relPath.startsWith(`${pkg.dir}/`)) continue;
    if (best === null || pkg.dir.length > best.dir.length) best = pkg;
  }
  return best;
}

/**
 * Ensure the directory chain between a base container and the file's dir
 * exists, returning the file's direct parent container. Newly needed directory
 * nodes are appended to `newNodes`.
 */
function ensureDirChain(
  base: Container,
  fileRelPath: string,
  language: string,
  known: Map<string, Container>,
  newNodes: GraphNode[],
): Container {
  const dir = path.posix.dirname(fileRelPath);
  if (dir === '.' || dir === base.dir) return base;

  const relToBase = base.dir === '' ? dir : dir.slice(base.dir.length + 1);
  let parent = base;
  let current = base.dir;
  for (const segment of relToBase.split('/')) {
    current = current === '' ? segment : `${current}/${segment}`;
    let container = known.get(current);
    if (!container) {
      container = { id: nodeId(current, 'directory', segment), dir: current };
      known.set(current, container);
      newNodes.push({
        id: container.id,
        kind: 'directory',
        name: segment,
        path: current,
        parentId: parent.id,
        language,
      });
    }
    parent = container;
  }
  return parent;
}

/** Deduplicate while preserving first-seen order. */
function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

export async function runStructuralPhase(ctx: StructuralContext): Promise<{ filesProcessed: number }> {
  const { repoRoot, store, adapter, packages, files, allFiles, emit, isCancelled } = ctx;
  const containerLanguage = '';

  // --- root workspace node -------------------------------------------------
  const rootNode: GraphNode = {
    id: ROOT_NODE_ID,
    kind: 'workspace',
    name: path.basename(path.resolve(repoRoot)),
    path: '',
    parentId: null,
    language: containerLanguage,
  };

  // --- package nodes -------------------------------------------------------
  const packageContainers = new Map<string, Container>(); // pkg.dir -> container
  const containerNodes: GraphNode[] = [rootNode];
  for (const pkg of packages) {
    const id = nodeId(pkg.dir, 'package', pkg.name);
    packageContainers.set(pkg.dir, { id, dir: pkg.dir });
    containerNodes.push({
      id,
      kind: 'package',
      name: pkg.name,
      path: pkg.dir,
      parentId: ROOT_NODE_ID,
      language: containerLanguage,
    });
  }
  const rootContainer: Container = { id: ROOT_NODE_ID, dir: '' };

  // --- directory chains ----------------------------------------------------
  const dirContainers = new Map<string, Container>(); // dir path -> container
  const parentOfFile = new Map<string, string>(); // file path -> parent node id
  for (const file of files) {
    const pkg = owningPackage(file, packages);
    const base = pkg ? packageContainers.get(pkg.dir) ?? rootContainer : rootContainer;
    const parent = ensureDirChain(base, file, containerLanguage, dirContainers, containerNodes);
    parentOfFile.set(file, parent.id);
  }
  store.upsertNodes(containerNodes);

  // --- per-file processing -------------------------------------------------
  const resolveCtx: ResolveContext = {
    repoRoot,
    packages,
    fileExists: (relPath) => allFiles.has(relPath),
  };
  // Entry declarations often point at build output the walk never sees
  // (dist/index.js); remap those onto their walked source files so entry
  // badges survive on realistic repos.
  const entryPaths = new Set<string>();
  for (const pkg of packages) {
    for (const entry of pkg.entryPaths) {
      if (allFiles.has(entry)) {
        entryPaths.add(entry);
        continue;
      }
      const mapped = adapter.resolveEntrySource?.(entry, pkg, resolveCtx);
      if (mapped !== null && mapped !== undefined) entryPaths.add(mapped);
    }
  }

  let filesProcessed = 0;
  for (const file of files) {
    if (isCancelled()) break;

    try {
      const absPath = path.join(repoRoot, file);
      const stat = statSync(absPath);
      const source = readFileSync(absPath, 'utf8');
      const language = await getLanguage(adapter.grammarWasmPath(file));

      const { specifiers, exportedNames } = withTree(language, source, (tree) => ({
        specifiers: captureAll(language, adapter.importQuery, tree).map((c) => c.node.text),
        exportedNames: uniqueInOrder(
          captureAll(language, adapter.exportQuery, tree).map((c) => c.node.text),
        ),
      }));

      // Resolve import specifiers; count import statements per target file.
      const importCounts = new Map<string, number>();
      for (const specifier of specifiers) {
        const target = adapter.resolveImport(specifier, file, resolveCtx);
        if (target === null || target === file) continue;
        importCounts.set(target, (importCounts.get(target) ?? 0) + 1);
      }

      const fileId = fileNodeId(file);
      const fileNode: GraphNode = {
        id: fileId,
        kind: 'file',
        name: path.posix.basename(file),
        path: file,
        parentId: parentOfFile.get(file) ?? ROOT_NODE_ID,
        language: adapter.id,
        attrs: {
          loc: source.split('\n').length,
          exportCount: exportedNames.length,
          exportedNames: exportedNames.slice(0, 5),
          ...(entryPaths.has(file) ? { entry: true } : {}),
        },
      };
      store.upsertNodes([fileNode]);

      const edges: GraphEdge[] = [];
      for (const [target, count] of importCounts) {
        const toId = fileNodeId(target);
        edges.push({
          id: edgeId('imports', fileId, toId),
          kind: 'imports',
          from: fileId,
          to: toId,
          count,
          sourcePath: file,
        });
      }
      if (edges.length > 0) store.upsertEdges(edges);

      store.upsertFileRecord({
        path: file,
        mtimeMs: Math.floor(stat.mtimeMs),
        size: stat.size,
        structuralDone: true,
        semanticDone: false,
      });
    } catch (error) {
      // Unreadable/unparsable file: log and move on — never abort the phase.
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[indexer] structural: skipping ${file}: ${message}`);
    }

    filesProcessed += 1;
    emit({
      type: 'progress',
      phase: 'structural',
      filesDone: ctx.filesDoneBase + filesProcessed,
      filesTotal: ctx.filesTotal,
      currentFile: file,
    });
  }

  return { filesProcessed };
}
