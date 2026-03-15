import { describe, expect, it } from 'vitest';
import type { QueryResult } from '../src/query-helper.ts';
import { QueryHelper, withQueryHelper } from '../src/query-helper.ts';

describe('QueryHelper error messages', () => {
  it('throws when query function is missing', async () => {
    await expect(() => new QueryHelper({}).query('X')).rejects.toThrowError(
      'Query function is not configured on the object.',
    );
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

    expect(calls).toStrictEqual(['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
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

  it('issues ROLLBACK on error', async () => {
    const calls: string[] = [];

    const helper = new QueryHelper({
      async query({ text }: { text: string; values: unknown[] }): Promise<QueryResult<object>> {
        calls.push(text);
        return { rows: [], rowCount: 0 };
      },
    });

    await expect(
      helper.begin(async (conn) => {
        await conn.query('ok');
        await conn.begin(async (conn) => {
          await conn.query('nest-ok');
          throw new Error('error');
        });
        await conn.query('never');
      }),
    ).rejects.toThrow();

    await helper.query('ok');

    expect(calls).toStrictEqual(['BEGIN', 'ok', 'nest-ok', 'ROLLBACK', 'ok']);
  });

  it('handles concurrent nested queries properly', async () => {
    if (!process.env.PGHOST) return;

    const pg = await import('pg');
    const db = withQueryHelper(new pg.Pool(), {
      // connect: (x) => x.connect(),
      // release: (x) => x.release(),
    });

    const result: any = await db.begin(async (conn) => [
      await conn.getOne('SELECT txid_current()'),

      await db.getOne('SELECT txid_current()'),
      await db.getOne('SELECT txid_current()'),

      await conn.getOne('SELECT txid_current()'),

      await conn.begin(async (conn) => [
        await db.getOne('SELECT txid_current()'),
        await db.getOne('SELECT txid_current()'),
        await conn.getOne('SELECT txid_current()'),
        await conn.getOne('SELECT txid_current()'),
      ]),
    ]);
    /*
      [
        '46538',
        '46539',
        '46540',
        '46538',
        [ '46541', '46542', '46538', '46538' ]
      ]
    */

    expect(result[0]).not.toBe(result[1]);
    expect(result[0]).not.toBe(result[2]);
    expect(result[0]).toBe(result[3]);
    expect(result[0]).not.toBe(result[4][0]);
    expect(result[0]).not.toBe(result[4][1]);
    expect(result[0]).toBe(result[4][2]);
    expect(result[0]).toBe(result[4][3]);

    expect(result[1]).not.toBe(result[2]);
    expect(result[4][0]).not.toBe(result[4][1]);
  });

  it('issues SET ROLE and restores to NONE', async () => {
    const calls: string[] = [];

    const helper = new QueryHelper({
      async query({ text }: { text: string; values: unknown[] }): Promise<QueryResult<object>> {
        calls.push(text);
        return { rows: [], rowCount: 0 };
      },
    });

    await helper.begin(
      {
        role: 'guest',
      },
      async (conn) => {
        await conn.query('HELLO');
      },
    );

    expect(calls).toStrictEqual(['SET ROLE guest', 'BEGIN', 'HELLO', 'COMMIT', 'SET ROLE NONE']);
  });

  it('issues SET ROLE and restores to NONE without transaction', async () => {
    // reset
    const calls: string[] = [];

    const helper = new QueryHelper({
      async query({ text }: { text: string; values: unknown[] }): Promise<QueryResult<object>> {
        calls.push(text);
        return { rows: [], rowCount: 0 };
      },
    });

    await helper.begin(
      {
        role: 'guest',
        transaction: false,
      },
      async (conn) => {
        await conn.query('HELLO');
      },
    );

    expect(calls).toStrictEqual(['SET ROLE guest', 'HELLO', 'SET ROLE NONE']);
  });
});
