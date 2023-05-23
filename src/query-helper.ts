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
  rowCount: number;
  rows: T[];
  fields?: Partial<pg.FieldDef>[];
};

export type QueryConfig = {
  text: string;
  values: unknown[];
};

export type QueryableFunction<T extends object> = (
  this: T,
  queryConfig: QueryConfig
) => Promise<QueryResult<QueryResultRow>>;

export type Queryable<T extends object> = {
  query: QueryableFunction<T>;
};

type pgQueryResult<X, T extends QueryResultRow> = X extends {
  query(...args: unknown[]): Promise<pg.QueryResult<T>>; // pg
}
  ? pg.QueryResult<T>
  : QueryResult<T>;

type QueryHelperOptions<X extends object> = {
  beforeQuery?: <T extends QueryConfig>(ctx: T) => void;
  afterQuery?: <T extends QueryConfig>(ctx: T) => void;
  onError?: <T extends QueryConfig>(ctx: T, e: unknown) => void;

  query?: QueryableFunction<X>;
};

type QueryTemplateOrSimpleQuery =
  | QueryTemplateStyle
  | [query: string, values?: unknown[]]
  | [query: pg.QueryConfig<unknown[]>];

function hidePropertyExcludes(target: object, keys: string[]) {
  target = { ...target };
  Object.defineProperties(
    target,
    Object.fromEntries(
      Object.keys(target).map((k) => [
        k,
        keys.includes(k) ? {} : { enumerable: false },
      ])
    )
  );
  return target;
}

/**
 * Query Helper
 */
export class QueryHelper<X extends object> {
  #db: X;
  #opts: QueryHelperOptions<X>;

  constructor(db: X, opts: QueryHelperOptions<X> = {}) {
    this.#db = db;
    this.#opts = { ...opts };

    // set query function
    if (!this.#opts.query) {
      if ('query' in db && typeof db.query === 'function') {
        // default
        this.#opts.query = db.query as QueryableFunction<X>;
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
      return { ...query, values: query.values ?? [] };
    }

    return { text: query, values: values ?? [] };
  }

  async #query<T extends QueryResultRow>(
    args: QueryTemplateOrSimpleQuery
  ): Promise<pgQueryResult<X, T>> {
    const query = this.#parseQueryTemplateStyle(args);

    this.#opts?.beforeQuery?.(query);

    const queryFn = this.#opts.query;
    if (!queryFn) throw new Error('Missing query function');
    const results = await queryFn.call(this.#db, query).catch((e: unknown) => {
      this.#opts?.onError?.(query, e);
      throw e;
    });

    this.#opts?.afterQuery?.({
      ...query,
      results: hidePropertyExcludes(results, ['command', 'rowCount', 'rows']),
    });

    return results as pgQueryResult<X, T>;
  }

  // ======================================================================
  // query executors

  async insert<T extends QueryResultRow>(
    table: string,
    fv: FieldValues,
    appendix?: string | QueryFragment
  ) {
    const query = buildInsert(table, fv, appendix);
    return await this.#query<T>([query]);
  }

  async update<T extends QueryResultRow>(
    table: string,
    fv: FieldValues,
    where: WhereArg,
    appendix?: string | QueryFragment
  ) {
    const query = buildUpdate(table, fv, where, appendix);
    return await this.#query<T>([query]);
  }

  async delete<T extends QueryResultRow>(
    table: string,
    where: WhereArg,
    appendix?: string | QueryFragment
  ) {
    const query = buildDelete(table, where, appendix);
    return await this.#query<T>([query]);
  }

  async query<T extends QueryResultRow>(...args: QueryTemplateOrSimpleQuery) {
    return this.#query<T>(args);
  }

  async getRows<T extends QueryResultRow>(...args: QueryTemplateOrSimpleQuery) {
    return this.#query<T>(args).then((x) => x.rows);
  }

  async getRow<T extends QueryResultRow>(...args: QueryTemplateOrSimpleQuery) {
    return this.#query<T>(args).then((x) => x.rows?.[0]);
  }

  async getOne<T = unknown>(...args: QueryTemplateOrSimpleQuery) {
    return this.#query(args).then((x) => Object.values(x.rows?.[0])?.[0] as T);
  }

  async getCount(...args: QueryTemplateOrSimpleQuery) {
    return this.#query(args).then((x) => x.rowCount);
  }

  async exec(...args: QueryTemplateOrSimpleQuery) {
    // same as getCount
    return this.#query(args).then((x) => x.rowCount);
  }

  // ======================================================================
  // query adapters

  // Prisma adapter: NB; It only supports a query return rows
  public static get prisma() {
    return async function <T extends QueryResultRow> (
      this: object,
      { text, values }: QueryConfig
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

  // TypeORM adapter
  public static get typeorm() {
    return async function <T extends QueryResultRow> (
      this: object,
      { text, values }: QueryConfig
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

/**
 * Returns a proxy object that overrides the queryable instance `db` by Query Helper utilities
 * @param db - Queryable object to be wrapped
 */
export function withQueryHelper<T extends Queryable<T>>(
  db: T,
  opts?: QueryHelperOptions<T>
): Override<T, QueryHelper<T>>;
export function withQueryHelper<T extends object>(
  db: T,
  opts: Overwrite<QueryHelperOptions<T>, Queryable<T>>
): Override<T, QueryHelper<T>>;
export function withQueryHelper<T extends object>(
  db: T,
  opts?: QueryHelperOptions<T>
): Override<T, QueryHelper<T>> {
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

  return proxy as Override<T, QueryHelper<T>>;
}
