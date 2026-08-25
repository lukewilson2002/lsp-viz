import { fileURLToPath } from 'node:url';
import { GraphStore, ROOT_NODE_ID } from '@lsp-viz/core';
import { describe, expect, it } from 'vitest';
import { createIndexer } from '../src/indexer.js';

const repoRoot = fileURLToPath(new URL('../../../fixtures/demo-repo', import.meta.url));

async function fullRunNodeIds(): Promise<string[]> {
  const store = new GraphStore(':memory:');
  try {
    await createIndexer({ repoRoot, store }).run('full');
    const ids = [ROOT_NODE_ID, ...store.getDescendants(ROOT_NODE_ID).map((n) => n.id)];
    return ids.sort();
  } finally {
    store.close();
  }
}

describe('determinism', () => {
  it('two full runs produce identical node id sets', async () => {
    const first = await fullRunNodeIds();
    const second = await fullRunNodeIds();
    expect(first.length).toBeGreaterThan(40); // containers + files + symbols
    expect(second).toEqual(first);
  });
});
