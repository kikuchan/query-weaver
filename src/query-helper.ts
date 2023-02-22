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

export interface Queryable {
  query: <T extends QueryResultRow>(queryConfig: {
    text: string;
    values?: unknown[];
  }) => Promise<QueryResult<T>>;
}

type pgQueryResult<X extends Queryable, T extends QueryResultRow> = X extends {
  query(...args: unknown[]): Promise<pg.QueryResult<T>>;
}
  ? pg.QueryResult<T>
  : QueryResult<T>;

type QueryHelperOptions = {
  beforeQuery?: <T extends pg.QueryConfig<unknown[]>>(ctx: T) => void;
  afterQuery?: <T extends pg.QueryConfig<unknown[]>>(ctx: T) => void;
  onError?: <T extends pg.QueryConfig<unknown[]>>(ctx: T, e: Error) => void;
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
export class QueryHelper<X extends Queryable> {
  #db: X;
  #opts: QueryHelperOptions;

  constructor(db: X, opts: QueryHelperOptions = {}) {
    this.#db = db;
    this.#opts = opts;
  }

  #parseQueryTemplateStyle(
    args: QueryTemplateOrSimpleQuery
  ): pg.QueryConfig<unknown[]> {
    if (isQueryTemplateStyle(args)) {
      const [texts, ...values] = args;
      return sql(texts, ...values);
    }

    const [query, values] = args;

    if (typeof query === 'object' && query && 'text' in query) {
      return query;
    }

    return { text: query, values: values ?? [] };
  }

  async #query<T extends QueryResultRow>(
    args: QueryTemplateOrSimpleQuery
  ): Promise<pgQueryResult<X, T>> {
    const query = this.#parseQueryTemplateStyle(args);

    this.#opts?.beforeQuery?.(query);

    const results = await this.#db.query<T>(query).catch((e) => {
      this.#opts?.onError?.(query, e);
      throw e;
    });

    this.#opts?.afterQuery?.({
      ...query,
      results: hidePropertyExcludes(results, ['command', 'rowCount', 'rows']),
    });

    return results as pgQueryResult<X, T>;
  }

  // ==================================================================================================
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
export function withQueryHelper<T extends Queryable>(
  db: T,
  opts?: QueryHelperOptions
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
