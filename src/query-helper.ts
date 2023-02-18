import type pg from 'pg';
import type { QueryFragment, FieldValues, WhereArg } from './query-weaver';
import { sql, buildInsert, buildUpdate, buildDelete } from './query-weaver';

// pg (almost) compatible types to relief and reduce their requirements
type pgQueryResultCustom<R> = {
  rowCount: number;
  rows: R[];
  fields?: Partial<pg.FieldDef>[];
};
type pgQueryResult<R> = Omit<Partial<pg.QueryResult>, keyof pgQueryResultCustom<R>> & pgQueryResultCustom<R>;

export interface Queryable {
  query: <T extends pg.QueryResultRow>(queryConfig: { text: string; values?: unknown[] }) => Promise<pgQueryResult<T>>;
}

type QueryHelperOptions = {
  placeHolderFn?: (v: unknown, values: unknown[]) => string;

  beforeQuery?: <T extends pg.QueryConfig<unknown[]>>(ctx: T) => void;
  afterQuery?: <T extends pg.QueryConfig<unknown[]>>(ctx: T) => void;
  onError?: <T extends pg.QueryConfig<unknown[]>>(ctx: T, e: Error) => void;
};

type QueryTemplateArgs = [text: TemplateStringsArray, ...values: unknown[]];
type QueryTemplateOrSimpleQuery =
  | QueryTemplateArgs
  | [query: string, values?: unknown[]]
  | [query: pg.QueryConfig<unknown[]>];

const isQueryTemplateArgs = (args: unknown): args is QueryTemplateArgs => {
  if (!Array.isArray(args)) return false;
  if (typeof args?.[0] !== 'object' || args[0] === null || !('raw' in args[0])) return false;
  if (!Array.isArray(args[0])) return false;
  const [texts, ...values] = args;
  return texts.length - 1 === values.length;
};

/**
 * Query Helper
 */
export class QueryHelper {
  #db: Queryable;
  #opts: QueryHelperOptions;

  constructor(db: Queryable, opts: QueryHelperOptions = {}) {
    this.#db = db;
    this.#opts = opts;
  }

  #parseQueryTemplateArgs(args: QueryTemplateOrSimpleQuery): pg.QueryConfig<unknown[]> {
    if (isQueryTemplateArgs(args)) {
      const [texts, ...values] = args;
      return sql(texts, ...values);
    }

    const [query, values] = args;

    if (typeof query === 'object' && query && 'text' in query) {
      return query;
    }

    return { text: query, values: values ?? [] };
  }

  async #query<T extends pg.QueryResultRow>(args: QueryTemplateOrSimpleQuery) {
    const query = this.#parseQueryTemplateArgs(args);

    this.#opts?.beforeQuery?.(query);

    const result = await this.#db.query<T>(query).catch((e) => {
      this.#opts?.onError?.(query, e);
      throw e;
    });

    this.#opts?.afterQuery?.({ ...query, result });

    return result;
  }

  // ==================================================================================================
  // query executors

  async insert<T extends pg.QueryResultRow>(table: string, fv: FieldValues, followingSql?: string | QueryFragment) {
    const query = buildInsert(table, fv);
    if (followingSql) query.push('\n').push(followingSql);
    return await this.#query<T>([query]);
  }

  async update<T extends pg.QueryResultRow>(
    table: string,
    fv: FieldValues,
    where: WhereArg,
    followingSql?: string | QueryFragment
  ) {
    const query = buildUpdate(table, fv, where);
    if (followingSql) query.push('\n').push(followingSql);
    return await this.#query<T>([query]);
  }

  async delete<T extends pg.QueryResultRow>(table: string, where: WhereArg, followingSql?: string | QueryFragment) {
    const query = buildDelete(table, where);
    if (followingSql) query.push('\n').push(followingSql);
    return await this.#query<T>([query]);
  }

  async query<T extends pg.QueryResultRow>(...args: QueryTemplateOrSimpleQuery) {
    return this.#query<T>(args);
  }

  async getRows<T extends pg.QueryResultRow>(...args: QueryTemplateOrSimpleQuery) {
    return this.#query<T>(args).then((x) => x.rows);
  }

  async getRow<T extends pg.QueryResultRow>(...args: QueryTemplateOrSimpleQuery) {
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

/**
 * Returns a proxy object that overrides the queryable instance `db` by Query Helper utilities
 * @param db - Queryable object to be wrapped
 */
export function useQueryHelper<T extends Queryable>(
  db: T,
  opts?: QueryHelperOptions
): Omit<T, keyof QueryHelper> & QueryHelper {
  const qh = new QueryHelper(db, opts);
  return new Proxy(db, {
    get(db, key, receiver) {
      const target = key in qh ? qh : key in db ? db : undefined;

      const value = target && Reflect.get(target, key);

      if (value && value instanceof Function) {
        return function(this: unknown, ...args: unknown[]) {
          return value.apply(this === receiver ? target : this, args);
        };
      }

      return value;
    },
  }) as T & QueryHelper;
}
