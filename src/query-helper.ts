import type pg from 'pg';
import type { QueryFragment, FieldValues, WhereArg } from './query-weaver';
import { sql, buildInsert, buildUpdate, buildDelete } from './query-weaver';

type pgQueryResultCustom<R> = {
  rowCount: number;
  rows: R[];
  fields?: Partial<pg.FieldDef>[];
}
type pgQueryResult<R> = Omit<Partial<pg.QueryResult>, keyof pgQueryResultCustom<R>> & pgQueryResultCustom<R>;

export interface Queryable {
  query: <T extends pg.QueryResultRow>(query: { text: string, values?: unknown[] }) => Promise<pgQueryResult<T>> // & Record<string, any>>
}

type QueryHelperOptions = {
  placeHolderFn?: (v: unknown, values: unknown[]) => string

  beforeQuery?: (ctx: any) => any
  afterQuery?: (ctx: any) => any
}

type QueryTemplateArgs = [text: TemplateStringsArray, ...values: unknown[]];
type QueryTemplateAwareArgs = QueryTemplateArgs | [query: string | QueryFragment, values?: unknown[]]
const isQueryTemplateArgs = (args: unknown): args is QueryTemplateArgs => {
  if (!Array.isArray(args)) return false;
  if (typeof args?.[0] !== 'object' || args[0] === null || !('raw' in args[0])) return false;
  if (!Array.isArray(args[0])) return false;
  const [texts, ...values] = args;
  return texts.length - 1 === values.length;
}

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

  #parseTemplateArgs(args: QueryTemplateAwareArgs): [string | QueryFragment, unknown[]] {
    if (isQueryTemplateArgs(args)) {
      const [texts, ...values] = args;
      return [sql(texts, ...values), []];
    }

    const [query, values] = args;
    return [query, values ?? []]
  }

  async #query<T extends pg.QueryResultRow = any>(args: QueryTemplateAwareArgs) {
    const [query, values] = this.#parseTemplateArgs(args);

    const valueFn = (v: unknown) => (this.#opts?.placeHolderFn ?? ((v: unknown, values: unknown[]) => {
      // default function
      values.push(v);
      return `$${values.length}`;
    }))(v, values);

    const ctx = {
      text: query.toString({ valueFn }),
      values,
      embed: query.toString()
    };

    this.#opts?.beforeQuery?.(ctx);

    const result = await this.#db.query<T>(ctx);

    this.#opts?.afterQuery?.({ ... ctx, result });

    return result;
  }

  // ==================================================================================================
  // query executors

  async insert<T extends pg.QueryResultRow = any>(table: string, fv: FieldValues, followingSql?: string | QueryFragment) {
    const query = buildInsert(table, fv);
    if (followingSql) query.push('\n').push(followingSql)
    return await this.#query<T>([query]);
  }

  async update<T extends pg.QueryResultRow = any>(table: string, fv: FieldValues, where: WhereArg, followingSql?: string | QueryFragment) {
    const query = buildUpdate(table, fv, where);
    if (followingSql) query.push('\n').push(followingSql)
    return await this.#query<T>([query]);
  }

  async delete<T extends pg.QueryResultRow = any>(table: string, where: WhereArg, followingSql?: string | QueryFragment) {
    const query = buildDelete(table, where);
    if (followingSql) query.push('\n').push(followingSql)
    return await this.#query<T>([query]);
  }

  async query<T extends pg.QueryResultRow = any>(text: TemplateStringsArray, ...values: unknown[]): Promise<pgQueryResult<T>>;
  async query<T extends pg.QueryResultRow = any>(text: string, values?: unknown[]): Promise<pgQueryResult<T>>;
  async query<T extends pg.QueryResultRow = any>(query: QueryFragment, values?: unknown[]): Promise<pgQueryResult<T>>;
  async query<T extends pg.QueryResultRow = any>(...args: QueryTemplateAwareArgs) {
    return this.#query<T>(args);
  }

  async getRows<T extends pg.QueryResultRow = any>(...args: QueryTemplateAwareArgs) {
    return this.#query<T>(args).then(x => x.rows);
  }

  async getRow<T extends pg.QueryResultRow = any>(...args: QueryTemplateAwareArgs) {
    return this.#query<T>(args).then(x => x.rows?.[0]);
  }

  async getOne<T = unknown>(...args: QueryTemplateAwareArgs) {
    return this.#query(args).then(x => Object.values(x.rows?.[0])?.[0] as T)
  }

  async getCount(...args: QueryTemplateAwareArgs) {
    return this.#query(args).then(x => x.rowCount)
  }
  async exec(...args: QueryTemplateAwareArgs) {
    // same as getCount
    return this.#query(args).then(x => x.rowCount)
  }
};

/**
 * Returns a proxy object that overrides the queryable instance `db` by Query Helper utilities
 * @param db - Queryable object to be wrapped
 */
export function useQueryHelper<T extends Queryable>(db: T, opts?: QueryHelperOptions): Omit<T, keyof QueryHelper> & QueryHelper {
  const qh = new QueryHelper(db, opts);
  return new Proxy(db, {
    get(db, key, receiver) {
      const target = key in qh ? qh
                   : key in db ? db
                   : undefined

      const value = target && Reflect.get(target, key)

      if (value && value instanceof Function) {
        return function (this: unknown, ...args: unknown[]) {
          return value.apply(this === receiver ? target : this, args);
        };
      }

      return value;
    }
  }) as T & QueryHelper;
}
