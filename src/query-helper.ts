import type pg from 'pg';
import type { FieldValues, QueryFragment, QueryTemplateStyle, WhereArg } from './query-weaver.ts';
import {
  DELETE_ALL_WITHOUT_FORCE_ERROR,
  UPDATE_ALL_WITHOUT_FORCE_ERROR,
  buildDelete,
  buildInsert,
  buildUpdate,
  buildUpsert,
  ident,
  isQueryTemplateStyle,
  isWhereEmpty,
  sql,
} from './query-weaver.ts';

export type QueryResultRow = pg.QueryResultRow;

// pg (almost) compatible types to relief and reduce their requirements
export type QueryResult<T extends QueryResultRow> = {
  rowCount?: number | null;
  rows: T[];
  fields?: Partial<pg.FieldDef>[];
};

export type QueryConfig = {
  text: string;
  values: unknown[];
  embed?: string;

  sql?: string;
  statement?: string;
};

type QueryableFunctionReturnType = Promise<QueryResult<QueryResultRow>>;
type QueryableFunctionWithoutThis = (queryConfig: QueryConfig) => QueryableFunctionReturnType;
type QueryableFunctionWithThis<T extends object> = (this: T, queryConfig: QueryConfig) => QueryableFunctionReturnType;

type QueryableWithThis<T extends object> = {
  query: QueryableFunctionWithThis<T>;
};

export type QueryableFunction<T extends object> = QueryableFunctionWithoutThis | QueryableFunctionWithThis<T>;
export type Queryable<T extends object> = {
  query: QueryableFunction<T>;
};

type pgQueryResult<X, T extends QueryResultRow> = (X extends {
  query(...args: unknown[]): Promise<pg.QueryResult<T>>; // pg
}
  ? pg.QueryResult<T>
  : QueryResult<T>) & { rowCount: number };

export type QueryHelperOptions<X extends object, Y extends object> = {
  beforeQuery?: (ctx: Readonly<QueryConfig>) => void;
  afterQuery?: <R extends QueryResultRow>(ctx: Readonly<QueryConfig>, r: QueryResult<R>) => void;
  onError?: (ctx: Readonly<QueryConfig>, e: unknown) => void;

  connect?: (obj: X) => Promise<Y>;
  release?: (conn: Y) => Promise<void> | void;
};

type QueryTemplateOrSimpleQuery =
  | QueryTemplateStyle
  | [query: string, values?: unknown[]]
  | [query: pg.QueryConfig<unknown[]>];

function pick<T extends { [X in string]: T[X] }, K extends string>(target: T, keys: K[]): { [X in K]: T[X] } {
  return Object.fromEntries(keys.map((k) => [k, target[k]])) as {
    [X in K]: T[X];
  };
}

export type QueryHelperBeginOption = {
  transaction?: boolean;
  role?: string;
};

/**
 * Query Helper
 */
export class QueryHelper<X extends object = object, Y extends object = object> {
  #db: X;

  #opts: QueryHelperOptions<X, Y> & Partial<Queryable<X>>;
  #nested: boolean;

  constructor(db: X, opts: QueryHelperOptions<X, Y> & Partial<Queryable<X>> = {}, nested = false) {
    this.#db = db;
    this.#opts = { ...opts };
    this.#nested = nested;

    if (!this.#opts.connect && !this.#opts.release) {
      if (
        'connect' in this.#db &&
        typeof this.#db.connect === 'function' &&
        'totalCount' in this.#db &&
        'idleCount' in this.#db
      ) {
        // XXX: heuristic: it looks like a pg.Pool instance
        this.#opts.connect = () => (this.#db as { connect: () => Promise<Y> }).connect();
        this.#opts.release = (y: Y) => (y as { release: () => void }).release();
      }
    }
  }

  #parseQueryTemplateStyle(args: QueryTemplateOrSimpleQuery): QueryConfig {
    if (isQueryTemplateStyle(args)) {
      const [texts, ...values] = args;
      return sql(texts, ...values);
    }

    const [query, values] = args;

    if (typeof query === 'object' && query && 'text' in query) {
      return {
        text: query.text,
        values: query.values || [],
        embed: 'embed' in query && typeof query.embed === 'string' ? query.embed : undefined,
        sql: 'sql' in query && typeof query.sql === 'string' ? query.sql : undefined,
        statement: 'statement' in query && typeof query.statement === 'string' ? query.statement : undefined,
      };
    }

    return { text: query, values: values ?? [] };
  }

  async #exec(query: QueryConfig) {
    const queryFn = this.#opts.query ?? ('query' in this.#db && typeof this.#db.query === 'function' && this.#db.query);
    if (!queryFn) throw new Error('Query function is not configured on the object.');
    return await queryFn.call(this.#db, query);
  }

  async #query<T extends QueryResultRow>(args: QueryTemplateOrSimpleQuery): Promise<pgQueryResult<X, T>> {
    const query = this.#parseQueryTemplateStyle(args);

    this.#opts?.beforeQuery?.(query as Readonly<QueryConfig>);
    const results = await this.#exec(query).catch((e: unknown) => {
      this.#opts?.onError?.(query as Readonly<QueryConfig>, e);
      throw e;
    });

    if (typeof results.rowCount !== 'number') {
      results.rowCount = results.rows?.length ?? 0;
    }

    this.#opts?.afterQuery?.(query as Readonly<QueryConfig>, pick(results, ['command', 'rowCount', 'rows']));

    return results as pgQueryResult<X, T>;
  }

  // ======================================================================
  // query executors

  /**
   * INSERT builder
   *
   * @example
   *   await db.insert('table', { name: 'myname' }, 'RETURNING *');
   */
  async insert<T extends QueryResultRow>(
    table: string,
    fvs: FieldValues | FieldValues[],
    appendix?: string | QueryFragment,
  ) {
    const query = buildInsert(table, fvs, appendix);
    return await this.#query<T>([query]);
  }

  /**
   * UPDATE builder
   *
   * @example
   *   await db.update('table', { name: 'myname' }, { id: 'root' }, 'RETURNING *');
   */
  async update<T extends QueryResultRow>(
    table: string,
    fv: FieldValues,
    where: WhereArg,
    appendix?: string | QueryFragment,
  ) {
    if (isWhereEmpty(where)) {
      throw new Error(UPDATE_ALL_WITHOUT_FORCE_ERROR);
    }

    const query = buildUpdate(table, fv, where, appendix);
    return await this.#query<T>([query]);
  }

  /**
   * DELETE builder
   *
   * @example
   *   await db.delete('table', { id: 'root' }, 'RETURNING *');
   */
  async delete<T extends QueryResultRow>(
    table: string,
    where: WhereArg,
    appendix?: string | QueryFragment,
  ): Promise<QueryResult<T>> {
    if (isWhereEmpty(where)) {
      throw new Error(DELETE_ALL_WITHOUT_FORCE_ERROR);
    }

    const query = buildDelete(table, where, appendix);
    return await this.#query<T>([query]);
  }

  /**
   * Upsert (INSERT ... ON CONFLICT) builder
   *
   * @example
   *   await db.upsert('table', { id: '1' name: 'myname' }, ['id'], 'RETURNING *');
   */
  async upsert<T extends QueryResultRow>(
    table: string,
    fvs: FieldValues | FieldValues[],
    onConflictKeys: string[],
    appendix?: string | QueryFragment,
  ) {
    const query = buildUpsert(table, fvs, onConflictKeys, appendix);
    return await this.#query<T>([query]);
  }

  /**
   * Execute query with query-weaver
   *
   * It's equivalent to ```db.query(sql`...`)```
   *
   * @example
   *   const { rows } = await db.query`SELECT * FROM table WHERE id = ${id}`
   */
  async query<T extends QueryResultRow>(...args: QueryTemplateOrSimpleQuery) {
    return this.#query<T>(args);
  }

  /**
   * Get rows directly
   *
   * @example
   *   const rows = await db.getRows`SELECT * FROM table WHERE id = ${id}`
   *     => [{ id: 10, name: '...' }, ...]
   */
  async getRows<T extends QueryResultRow>(...args: QueryTemplateOrSimpleQuery) {
    return this.#query<T>(args).then((x) => x.rows);
  }

  /**
   * Get a single row directly
   *
   * @example
   *   const row = await db.getRow`SELECT * FROM table WHERE id = ${id}`
   *     => { id: 10, name: '...' }
   */
  async getRow<T extends QueryResultRow>(...args: QueryTemplateOrSimpleQuery) {
    return this.#query<T>(args).then((x) => x.rows?.[0] as T | undefined);
  }

  /**
   * Get a single value directly
   *
   * @example
   *   const value = await db.getRow`SELECT 10`
   *     => 10
   */
  async getOne<T = unknown>(...args: QueryTemplateOrSimpleQuery) {
    return this.#query<[T]>(args).then((x) => Object.values(x.rows?.[0] ?? {})?.[0] as T | undefined);
  }

  /**
   * Get rowCount directly
   *
   * @example
   *   const numRows = await db.getCount`SELECT * FROM table`
   *     => 10
   */
  async getCount(...args: QueryTemplateOrSimpleQuery) {
    return this.#query(args).then((x) => x.rowCount);
  }

  /**
   * Execute a single statement
   * (It's equivalent to getCount)
   *
   * @example
   *   const result = await db.exec`INSERT INTO ...`
   *     => 1
   */
  async exec(...args: QueryTemplateOrSimpleQuery) {
    // same as getCount
    return this.#query(args).then((x) => x.rowCount);
  }

  async #begin(opts: QueryHelperBeginOption) {
    if (this.#nested) return this as unknown as QueryHelper<Y, Y>;

    const conn = new QueryHelper<Y, Y>(
      (await this.#opts.connect?.(this.#db)) ?? (this.#db as unknown as Y),
      this.#opts as QueryHelperOptions<Y, Y> & Partial<Queryable<Y>>,
      true,
    );

    if (opts.role) {
      await conn.#exec(this.#parseQueryTemplateStyle([sql`SET ROLE ${ident(opts.role)}`]));
    }
    if (opts.transaction !== false) {
      await conn.#exec({ text: 'BEGIN', values: [] });
    }

    return conn;
  }

  async #commit(conn: QueryHelper<Y, Y>, opts: QueryHelperBeginOption, commit = true) {
    if (this.#nested) return;

    try {
      if (opts.transaction !== false) {
        await conn.#exec({ text: commit ? 'COMMIT' : 'ROLLBACK', values: [] });
      }
      if (opts.role) {
        await conn.#exec({ text: 'SET ROLE NONE', values: [] });
      }
    } finally {
      await this.#opts.release?.(conn.#db);
    }
  }

  async #rollback(conn: QueryHelper<Y, Y>, opts: QueryHelperBeginOption) {
    return this.#commit(conn, opts, false);
  }

  /**
   * BEGIN the transaction
   *
   * @example
   *   await db.begin(() => {
   *     await db.insert(...);
   *     await db.update(...);
   *     return true;
   *   });
   */
  async begin<R>(callback: (conn: WithQueryHelper<Y, Y>) => Promise<R>): Promise<R>;
  async begin<R>(opts: QueryHelperBeginOption, callback: (conn: WithQueryHelper<Y, Y>) => Promise<R>): Promise<R>;
  async begin<R>(
    opts: QueryHelperBeginOption | ((conn: WithQueryHelper<Y, Y>) => Promise<R>),
    callback?: (conn: WithQueryHelper<Y, Y>) => Promise<R>,
  ) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    const conn: QueryHelper<Y, Y> = await this.#begin(opts);

    let result;
    try {
      result = await callback!(conn.wrap());
    } catch (error) {
      await this.#rollback(conn, opts);
      throw error;
    }

    await this.#commit(conn, opts);

    return result;
  }

  // ======================================================================
  // query adapters

  /**
   * Prisma adapter: NB; It only supports a query that returns rows
   */
  public static get prisma() {
    return async function <T extends QueryResultRow>(
      this: object,
      { text, values }: QueryConfig,
    ): Promise<QueryResult<T>> {
      if ('$queryRawUnsafe' in this && typeof this.$queryRawUnsafe === 'function') {
        const rows: T[] = await this.$queryRawUnsafe(text, ...values);
        return {
          rows: rows,
          rowCount: rows.length,
        };
      }
      throw new Error('Prisma adapter requires a $queryRawUnsafe function.');
    };
  }

  /**
   * TypeORM adapter
   */
  public static get typeorm() {
    return async function <T extends QueryResultRow>(
      this: object,
      { text, values }: QueryConfig,
    ): Promise<QueryResult<T>> {
      if ('query' in this && typeof this.query === 'function') {
        const rows: unknown[] = await this.query(text, values);

        // returns with row count
        if (rows.length === 2 && Array.isArray(rows[0]) && typeof rows[1] === 'number') {
          return { rows: rows[0], rowCount: rows[1] };
        }

        return {
          rows,
          rowCount: rows.length,
        } as { rows: T[]; rowCount: number };
      }
      throw new Error('TypeORM adapter requires a query function.');
    };
  }

  public static get sqlite() {
    return async function <T extends QueryResultRow>(this: object, config: QueryConfig) {
      if ('prepare' in this && typeof this.prepare === 'function') {
        const stmt = this.prepare(config.sql || config.text);
        const rows: T[] = stmt.all(...(config.values as string[]));

        return { rows, rowCount: rows.length };
      }
      throw new Error('SQLite adapter requires a prepare function.');
    };
  }

  wrap() {
    const proxy: unknown = new Proxy(this.#db, {
      get: (db, key, receiver) => {
        const target = key in this ? this : key in db ? db : undefined;
        const value = target && Reflect.get(target, key);

        if (value && value instanceof Function) {
          return function (this: unknown, ...args: unknown[]) {
            const invocationTarget = this === receiver || this === proxy || this == null ? target : this;
            const result = value.apply(invocationTarget, args);
            return result === db ? proxy : result;
          };
        }

        return value === db ? proxy : value;
      },
    });

    return proxy as WithQueryHelper<X, Y>;
  }
}

type Overwrite<T, Q> = Omit<T, keyof Q> & Q;
type MethodChainRewrite<T, Q> = {
  [K in keyof T]: T[K] extends (...args: infer R) => T
    ? (...args: R) => Override<T, Q>
    : T[K] extends T
      ? Override<T, Q>
      : T[K];
};
type Override<T, Q> = Overwrite<MethodChainRewrite<T, Q>, Q>;

export type WithQueryHelper<X extends object = object, Y extends object = object> = Override<X, QueryHelper<X, Y>>;

/**
 * Returns a proxy object that overrides the queryable instance `db` by Query Helper utilities
 * @param db - Queryable object to be wrapped
 *
 * @example
 *   const db = withQueryHelper(new pg.Client());
 */
export function withQueryHelper<X extends Queryable<object>, Y extends object>(
  db: X,
  opts?: QueryHelperOptions<X, Y> & Partial<QueryableWithThis<X>>,
): WithQueryHelper<X, Y>;
export function withQueryHelper<X extends object, Y extends object>(
  db: X,
  opts: QueryHelperOptions<X, Y> & QueryableWithThis<X>,
): WithQueryHelper<X, Y>;
export function withQueryHelper<X extends object, Y extends object>(
  db: X,
  opts?: QueryHelperOptions<X, Y> & Partial<QueryableWithThis<X>>,
): WithQueryHelper<X, Y> {
  return new QueryHelper<X, Y>(db, opts).wrap();
}
