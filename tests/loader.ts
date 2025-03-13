import { test, expect } from 'vitest';

test('exported CJS functions', () => {
  const { sql, withQueryHelper } = require('..');

  expect(typeof sql).eq('function');
  expect(typeof withQueryHelper).eq('function');
});

test('exported ESM functions', async () => {
  const { sql, withQueryHelper } = await import('..');

  expect(typeof sql).eq('function');
  expect(typeof withQueryHelper).eq('function');
});
