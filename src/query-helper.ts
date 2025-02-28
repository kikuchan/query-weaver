import type pg from 'pg';
import type {
  QueryFragment,
  FieldValues,
  WhereArg,
  QueryTemplateStyle,
} from './query-weaver';
import {
  sql,
  buildInsert,
  buildUpdate,
  buildDelete,
  isQueryTemplateStyle,
} from './query-weaver';

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
};

type QueryableFunctionReturnType = Promise<QueryResult<QueryResultRow>>;
type QueryableFunctionWithoutThis = (
  queryConfig: QueryConfig,
) => QueryableFunctionReturnType;
type QueryableFunctionWithThis<T extends object> = (
  this: T,
  queryConfig: QueryConfig,
) => QueryableFunctionReturnType;

type QueryableWithThis<T extends object> = {
  query: QueryableFunctionWithThis<T>;
};

export type QueryableFunction<T extends object> =
  | QueryableFunctionWithoutThis
  | QueryableFunctionWithThis<T>;
export type Queryable<T extends object> = {
  query: QueryableFunction<T>;
};

type pgQueryResult<X, T extends QueryResultRow> = (X extends {
  query(...args: unknown[]): Promise<pg.QueryResult<T>>; // pg
}
  ? pg.QueryResult<T>
  : QueryResult<T>) & { rowCount: number };

type QueryHelperOptions = {
  beforeQuery?: <T extends QueryConfig>(ctx: T) => void;
  afterQuery?: <T extends QueryConfig, R extends QueryResultRow>(
    ctx: T,
    r: QueryResult<R>,
  ) => void;
  onError?: <T extends QueryConfig>(ctx: T, e: unknown) => void;
};

type QueryTemplateOrSimpleQuery =
  | QueryTemplateStyle
  | [query: string, values?: unknown[]]
  | [query: pg.QueryConfig<unknown[]>];

function pick<T extends { [X in string]: T[X] }, K extends string>(
  target: T,
  keys: K[],
): { [X in K]: T[X] } {
  return Object.fromEntries(keys.map((k) => [k, target[k]])) as {
    [X in K]: T[X];
  };
}

/**
 * Query Helper
 */
export class QueryHelper<X extends object = object> {
  #db: X;
  #opts: QueryHelperOptions & Partial<Queryable<X>>;
  #inTransaction: number = 0;

  constructor(db: X, opts: QueryHelperOptions & Partial<Queryable<X>> = {}) {
    this.#db = db;
    this.#opts = { ...opts };

    // set query function
    if (!this.#opts.query) {
      if (!('query' in db) || typeof db.query !== 'function') {
        throw new Error('Invalid or no query functionn is specified');
      }

      this.#opts.query = db.query as QueryableFunction<X>;
    }
  }

  #parseQueryTemplateStyle(args: QueryTemplateOrSimpleQuery): QueryConfig {
    if (isQueryTemplateStyle(args)) {
      const [texts, ...values] = args;
      return sql(texts, ...values);
    }

    const [query, values] = args;

    if (typeof query === 'object' && query && 'text' in query) {
      return { ...query, values: query.values ?? [] };
    }

    return { text: query, values: values ?? [] };
  }

  #exec(query: QueryConfig) {
    const queryFn = this.#opts.query;
    if (!queryFn) throw new Error('Missing query function');
    return queryFn.call(this.#db, query);
  }

  async #query<T extends QueryResultRow>(
    args: QueryTemplateOrSimpleQuery,
  ): Promise<pgQueryResult<X, T>> {
    const query = this.#parseQueryTemplateStyle(args);

    this.#opts?.beforeQuery?.(query);

    const results = await this.#exec(query).catch((e: unknown) => {
      this.#opts?.onError?.(query, e);
      throw e;
    });

    if (typeof results.rowCount !== 'number') {
      results.rowCount = results.rows?.length ?? 0;
    }

    this.#opts?.afterQuery?.(
      query,
      pick(results, ['command', 'rowCount', 'rows']),
    );

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
    fv: FieldValues,
    appendix?: string | QueryFragment,
  ) {
    const query = buildInsert(table, fv, appendix);
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
  ) {
    const query = buildDelete(table, where, appendix);
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
    return this.#query<[T]>(args).then(
      (x) => Object.values(x.rows?.[0] ?? {})?.[0] as T | undefined,
    );
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
  async begin<R>(callback: (conn: this) => Promise<R>) {
    try {
      if (!this.#inTransaction++) {
        await this.#exec({ text: 'BEGIN', values: [] });
      }

      const result = await callback(this);

      if (!--this.#inTransaction) {
        await this.#exec({ text: 'COMMIT', values: [] });
      }

      return result;
    } catch (e) {
      if (!--this.#inTransaction) {
        await this.#exec({ text: 'ROLLBACK', values: [] });
      }
      throw e;
    }
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
      if (
        '$queryRawUnsafe' in this &&
        typeof this.$queryRawUnsafe === 'function'
      ) {
        const rows: T[] = await this.$queryRawUnsafe(text, ...values);
        return {
          rows: rows,
          rowCount: rows.length,
        };
      }
      throw new Error('Invalid object');
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
        if (
          rows.length === 2 &&
          Array.isArray(rows[0]) &&
          typeof rows[1] === 'number'
        ) {
          return { rows: rows[0], rowCount: rows[1] };
        }

        return {
          rows,
          rowCount: rows.length,
        } as { rows: T[]; rowCount: number };
      }
      throw new Error('Invalid object');
    };
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

export type WithQueryHelper<T extends object = object> = Override<
  T,
  QueryHelper<T>
>;

/**
 * Returns a proxy object that overrides the queryable instance `db` by Query Helper utilities
 * @param db - Queryable object to be wrapped
 *
 * @example
 *   const db = withQueryHelper(new pg.Client());
 */
export function withQueryHelper<T extends Queryable<object>>(
  db: T,
  opts?: QueryHelperOptions & Partial<QueryableWithThis<T>>,
): WithQueryHelper<T>;
export function withQueryHelper<T extends object>(
  db: T,
  opts: QueryHelperOptions & QueryableWithThis<T>,
): WithQueryHelper<T>;
export function withQueryHelper<T extends object>(
  db: T,
  opts?: QueryHelperOptions & Partial<QueryableWithThis<T>>,
): WithQueryHelper<T> {
  const qh = new QueryHelper<T>(db, opts);
  const proxy: unknown = new Proxy(db, {
    get(db, key, receiver) {
      const target = key in qh ? qh : key in db ? db : undefined;
      const value = target && Reflect.get(target, key);

      if (value && value instanceof Function) {
        return function (this: unknown, ...args: unknown[]) {
          const result = value.apply(this === receiver ? target : this, args);
          return result === db ? proxy : result;
        };
      }

      return value === db ? proxy : value;
    },
  });

  return proxy as WithQueryHelper<T>;
}
