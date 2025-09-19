import { beforeEach, describe, expect, it } from 'vitest';
import { buildInsert, buildUpsert, json, OR, sql, WHERE, withQueryHelper, type QueryResult } from '../src';

const queryable = {
  executed: [] as { text: string; values?: unknown[] }[],

  async query(cfg: { text: string; values?: unknown[] }): Promise<QueryResult<object>> {
    queryable.executed.push(cfg);
    return { rows: [{ text: cfg.text, values: cfg.values }], rowCount: 1 };
  },
};
const db = withQueryHelper(queryable);

beforeEach(() => {
  queryable.executed = [];
});

describe('sql tag basics', () => {
  it('embeds values and parameters', () => {
    const foo = 1;
    const bar = 'Bar';
    const query = sql`SELECT * FROM foobar WHERE foo = ${foo} AND bar = ${bar}`;

    expect(query.toString()).toBe("SELECT * FROM foobar WHERE foo = '1' AND bar = 'Bar'");
    expect(query.embed).toBe("SELECT * FROM foobar WHERE foo = '1' AND bar = 'Bar'");
    expect(query.text).toBe('SELECT * FROM foobar WHERE foo = $1 AND bar = $2');
    expect(query.values).toEqual([1, 'Bar']);
  });

  it('AND/OR helper composition', () => {
    const a = 1;
    const b = 'string';
    const c = null;
    const d = 5;
    const e = false;
    const query = String(sql`SELECT * FROM foobar ${WHERE({ a, b, c }, OR({ d, e }))}`);
    expect(query).toBe(
      "SELECT * FROM foobar WHERE ((a = '1') AND (b = 'string') AND (c IS NULL) AND (((d = '5') OR (e = false))))",
    );
  });
});

describe('json injector', () => {
  it('produces correct embedding and parameters', async () => {
    const id = 10;
    const obj = { b: 'string', c: [1, 2, 'X'], d: { e: null, f: undefined } };

    const row1 = await db.getRow(
      sql`SELECT * FROM jsonb_to_record(${json`{ "a": ${obj}, "b": ${id} }`}) AS (a jsonb, b int, c jsonb, d jsonb);`,
    );
    const row2 =
      await db.getRow`SELECT * FROM jsonb_to_record(${json`{ "a": ${obj}, "b": ${id} }`}) AS (a jsonb, b int, c jsonb, d jsonb);`;

    expect(row1).toEqual(row2);
  });
});

describe('WHERE builder', () => {
  it('handles strings, fragments, arrays, and objects', () => {
    const a = 1;
    const d = 5;
    const f = [1, 2, 3, 4, 5];
    const q = sql`SELECT * FROM foobar ${WHERE(
      {
        a: 10,
        b: 'string',
        c: sql`IS UNKNOWN`,
        d: sql`BETWEEN ${a} AND ${d}`,
      },
      'e IS NULL',
      sql`f = ANY (${f})`,
    )}`;
    expect(q.text).toBe(
      'SELECT * FROM foobar WHERE ((a = $1) AND (b = $2) AND (c IS UNKNOWN) AND (d BETWEEN $3 AND $4) AND (e IS NULL) AND (f = ANY ($5)))',
    );
    expect(q.embed).toBe(
      "SELECT * FROM foobar WHERE ((a = '10') AND (b = 'string') AND (c IS UNKNOWN) AND (d BETWEEN '1' AND '5') AND (e IS NULL) AND (f = ANY (ARRAY['1','2','3','4','5'])))",
    );
  });

  it('treats empty arrays as FALSE clauses', () => {
    const clause = WHERE({ tags: [] });

    expect(clause.text).toBe('WHERE ((FALSE))');
    expect(clause.values).toEqual([]);
  });
});

describe('builders', () => {
  it('ignores undefined on INSERT', () => {
    const q = buildInsert('test', { a: undefined, b: 10, c: '20' });
    expect(q.text).toBe('INSERT INTO test (b, c) VALUES ($1, $2)');
    expect(q.embed).toBe("INSERT INTO test (b, c) VALUES ('10', '20')");
  });

  it('generates DO NOTHING when upsert has no update targets', () => {
    const q = buildUpsert('users', { id: 1 }, ['id']);

    expect(q.text).toBe('INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING');
    expect(q.values).toEqual([1]);
  });
});

describe('comment and quote handling', () => {
  it('skips values inside comments and quoted blocks', () => {
    const v = 'test';
    const q = sql`SELECT * FROM (
    VALUES ('a')
         , (${v})
         /* /*
          *
          * -- nesting */
         , ${v}
          *
          */
         , ($hoge$ $fuge$ $moge$ ${v} ' $hoge$)
         -- , (${v})
         , ('-- ${v} \\'), (${v})
         /* , (${v}) */
         , (E'''/*\\''), (${v})
         , (${v})
  ) tmp`;

    expect(q.text).toBe(`SELECT * FROM (
    VALUES ('a')
         , ($1)
         /* /*
          *
          * -- nesting */
         , 
          *
          */
         , ($hoge$ $fuge$ $moge$  ' $hoge$)
         -- , ()
         , ('--  \\'), ($2)
         /* , () */
         , (E'''/*\\''), ($3)
         , ($4)
  ) tmp`);
  });
});

describe('transactions', () => {
  it('commits nested transactions', async () => {
    await db.begin(async () => {
      await db.query('DUMMY1');
      await db.begin(async () => {
        await db.query('DUMMY2');
      });
      await db.query('DUMMY3');
      return true;
    });

    expect(db.executed).toStrictEqual([
      { text: 'BEGIN', values: [] },
      { text: 'DUMMY1', values: [] },
      { text: 'DUMMY2', values: [] },
      { text: 'DUMMY3', values: [] },
      { text: 'COMMIT', values: [] },
    ]);
  });

  it('rolls back on error in nested transaction', async () => {
    await expect(
      db.begin(async () => {
        await db.query('DUMMY1');
        await db.begin(async () => {
          await db.query('DUMMY2');
          throw new Error('ERROR');
        });
        await db.query('DUMMY3');
        return true;
      }),
    ).rejects.toThrowError();

    expect(db.executed).toStrictEqual([
      { text: 'BEGIN', values: [] },
      { text: 'DUMMY1', values: [] },
      { text: 'DUMMY2', values: [] },
      { text: 'ROLLBACK', values: [] },
    ]);
  });
});
