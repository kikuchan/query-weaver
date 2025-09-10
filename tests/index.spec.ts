import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

describe('package exports (ESM only)', () => {
  it('exposes ESM entry', async () => {
    const { sql, withQueryHelper } = await import('../src/index.ts');
    expect(typeof sql).eq('function');
    expect(typeof withQueryHelper).eq('function');
  });
});
