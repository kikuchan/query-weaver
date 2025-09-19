import { describe, expect, it } from 'vitest';
import type { QueryResult } from '../src/query-helper.ts';
import { QueryHelper, withQueryHelper } from '../src/query-helper.ts';

describe('QueryHelper error messages', () => {
  it('throws when query function is missing', () => {
    expect(() => new QueryHelper({} as object)).toThrowError('No valid query function provided.');
  });

  it('throws when prisma adapter lacks $queryRawUnsafe', async () => {
    await expect(QueryHelper.prisma.call({}, { text: 'SELECT 1', values: [] })).rejects.toThrowError(
      'Prisma adapter requires a $queryRawUnsafe function.',
    );
  });

  it('throws when typeorm adapter lacks query function', async () => {
    await expect(QueryHelper.typeorm.call({}, { text: 'SELECT 1', values: [] })).rejects.toThrowError(
      'TypeORM adapter requires a query function.',
    );
  });

  it('throws when sqlite adapter lacks prepare function', async () => {
    await expect(QueryHelper.sqlite.call({}, { text: 'SELECT 1', values: [] })).rejects.toThrowError(
      'SQLite adapter requires a prepare function.',
    );
  });
});

describe('withQueryHelper bindings', () => {
  it('preserves method context when destructured', async () => {
    const queryable = {
      async query(config: { text: string; values: unknown[] }): Promise<QueryResult<object>> {
        return { rows: [{ text: config.text, values: config.values }], rowCount: 1 };
      },
    };

    const { insert } = withQueryHelper(queryable);

    await expect(insert('users', { id: 1 })).resolves.toMatchObject({ rowCount: 1 });
  });
});

describe('QueryHelper transactions', () => {
  it('restores transaction state when COMMIT fails', async () => {
    const calls: string[] = [];
    let shouldFailCommit = true;

    const helper = new QueryHelper({
      async query({ text }: { text: string; values: unknown[] }): Promise<QueryResult<object>> {
        calls.push(text);
        if (text === 'COMMIT' && shouldFailCommit) {
          shouldFailCommit = false;
          throw new Error('COMMIT failed');
        }
        return { rows: [], rowCount: 0 };
      },
    });

    await expect(helper.begin(async () => null)).rejects.toThrowError('COMMIT failed');

    await expect(helper.begin(async () => 'ok')).resolves.toBe('ok');

    expect(calls).toStrictEqual(['BEGIN', 'COMMIT', 'ROLLBACK', 'BEGIN', 'COMMIT']);
  });

  it('does not issue ROLLBACK when BEGIN fails', async () => {
    const calls: string[] = [];
    let shouldFailBegin = true;

    const helper = new QueryHelper({
      async query({ text }: { text: string; values: unknown[] }): Promise<QueryResult<object>> {
        calls.push(text);
        if (text === 'BEGIN' && shouldFailBegin) {
          shouldFailBegin = false;
          throw new Error('BEGIN failed');
        }
        return { rows: [], rowCount: 0 };
      },
    });

    await expect(helper.begin(async () => null)).rejects.toThrowError('BEGIN failed');

    await expect(helper.begin(async () => 'ok')).resolves.toBe('ok');

    expect(calls).toStrictEqual(['BEGIN', 'BEGIN', 'COMMIT']);
  });
});
