/**
 * Unit tests for the modifier recovery that runs on every hover signature.
 *
 * The shapes here are real tsserver hover text, paired with the real source
 * lines they were produced from — see withSourceModifiers for why the two have
 * to be reconciled at all.
 */

import type { GraphNode } from '@lsp-viz/core';
import { describe, expect, it } from 'vitest';
import { typescriptAdapter } from '../src/adapters/typescript.js';
import { withSourceModifiers } from '../src/semantic.js';

const MODIFIERS = typescriptAdapter.declarationModifiers ?? [];

/** A node whose range/selectionRange bracket `name` within `source`. */
function nodeOver(source: string, name: string): GraphNode {
  const lines = source.split('\n');
  // Whole-identifier match: a bare indexOf for a name like `f` happily finds
  // the one inside `default`, which silently moves the declaration gap.
  const at = new RegExp(`\\b${name}\\b`);
  const line = lines.findIndex((l) => at.test(l));
  if (line === -1) throw new Error(`test setup: ${name} not found in source`);
  const character = (lines[line] as string).search(at);
  return {
    id: 'n1',
    kind: 'function',
    name,
    path: 'a.ts',
    language: 'typescript',
    range: { start: { line, character: 0 }, end: { line: lines.length - 1, character: 0 } },
    selectionRange: {
      start: { line, character },
      end: { line, character: character + name.length },
    },
  } as GraphNode;
}

function run(source: string, name: string, signature: string): string {
  return withSourceModifiers(signature, nodeOver(source, name), source.split('\n'), MODIFIERS);
}

describe('withSourceModifiers', () => {
  it('restores the modifiers tsserver drops from a function hover', () => {
    expect(run('export async function f(): Promise<void> {}', 'f', 'function f(): Promise<void>')).toBe(
      'export async function f(): Promise<void>',
    );
  });

  it('restores a lone export', () => {
    expect(run('export function f(): void {}', 'f', 'function f(): void')).toBe(
      'export function f(): void',
    );
  });

  it('restores export default in written order', () => {
    expect(run('export default async function f() {}', 'f', 'function f(): Promise<void>')).toBe(
      'export default async function f(): Promise<void>',
    );
  });

  it('places modifiers after a (method) annotation, not before it', () => {
    expect(run('\tasync getThing(id: number) {}', 'getThing', '(method) C.getThing(id: number): Promise<T>')).toBe(
      '(method) async C.getThing(id: number): Promise<T>',
    );
  });

  it('leaves a declaration that has no modifiers untouched', () => {
    const sig = 'function f(): void';
    expect(run('function f(): void {}', 'f', sig)).toBe(sig);
  });

  it('does not restate a modifier the hover already carries', () => {
    const sig = '(property) C.x: readonly string[]';
    expect(run('\treadonly x: readonly string[];', 'x', sig)).toBe(sig);
  });

  it('declines to guess when the gap holds something it does not understand', () => {
    // A decorator is not a modifier; recovering `async` past it would mean
    // reordering the declaration, so nothing is recovered.
    const sig = '(method) C.f(): void';
    expect(run('\t@Injectable() async f() {}', 'f', sig)).toBe(sig);
  });

  it('is a no-op without a range or selectionRange', () => {
    const sig = 'function f(): void';
    const bare = { id: 'n', kind: 'function', name: 'f', path: 'a.ts', language: 'typescript' } as GraphNode;
    expect(withSourceModifiers(sig, bare, ['export async function f() {}'], MODIFIERS)).toBe(sig);
  });

  it('is a no-op when the adapter declares no modifiers', () => {
    const sig = 'function f(): void';
    const src = 'export async function f() {}';
    expect(withSourceModifiers(sig, nodeOver(src, 'f'), src.split('\n'), [])).toBe(sig);
  });
});
