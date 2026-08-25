import { describe, expect, it } from 'vitest';
import { edgeId, nodeId, repoHash } from '../src/ids.js';

describe('ids', () => {
  it('is deterministic', () => {
    expect(nodeId('src/a.ts', 'function', 'foo', null)).toBe(
      nodeId('src/a.ts', 'function', 'foo', null),
    );
    expect(edgeId('calls', 'x', 'y')).toBe(edgeId('calls', 'x', 'y'));
  });

  it('distinguishes container names', () => {
    expect(nodeId('src/a.ts', 'method', 'run', 'Foo')).not.toBe(
      nodeId('src/a.ts', 'method', 'run', 'Bar'),
    );
  });

  it('distinguishes kinds and paths', () => {
    expect(nodeId('src/a.ts', 'function', 'foo')).not.toBe(nodeId('src/a.ts', 'class', 'foo'));
    expect(nodeId('src/a.ts', 'function', 'foo')).not.toBe(nodeId('src/b.ts', 'function', 'foo'));
  });

  it('does not collide when fields contain the separator-ish content', () => {
    expect(nodeId('a b', 'function', 'c')).not.toBe(nodeId('a', 'b function', 'c'));
  });

  it('produces 16-char hex ids', () => {
    expect(repoHash('/tmp/x')).toMatch(/^[0-9a-f]{16}$/);
  });
});
