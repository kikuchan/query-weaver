import { quoteIdent, quoteLiteral } from './quote';
import { StringReader } from './string-reader';

type Context = {
  inLineComment?: boolean;
  inBlockComment?: number;
  inSingleQuote?: boolean;
  inEscapedSingleQuote?: boolean;
  dollarQuoted?: string;
};

type EscapeFunction = (v: unknown, context?: Context) => string;
export type FieldValues = Record<string, unknown>;
export type WhereArg =
  | string
  | FieldValues
  | QueryFragment
  | undefined
  | WhereArg[];

export function pgIdent(s: string, _ctx?: Context) {
  // '.' is a special for us
  return s
    .split('.')
    .map((x) => quoteIdent(x))
    .join('.');
}

// fallback function for when the EscapeFunction is not specified
export function pgString(s: unknown, _ctx?: Context): string {
  if (s === null) return 'NULL';
  if (typeof s === 'boolean') return s ? 'true' : 'false';
  if (Array.isArray(s))
    return 'ARRAY[' + s.map((e) => pgString(e)).join(',') + ']';
  if (typeof s === 'object') {
    if ('toJSON' in s && typeof s.toJSON === 'function') {
      return quoteLiteral(s.toJSON());
    }
    return quoteLiteral(s.toString());
  }
  return quoteLiteral(String(s));
}

function pgContextHandler(ctx: Context, src: string): void {
  const r = new StringReader(src);

  while (!r.eof()) {
    if (ctx.dollarQuoted) {
      if (!r.skipUntil(ctx.dollarQuoted)) break;

      r.skip(ctx.dollarQuoted.length);
      ctx.dollarQuoted = undefined;
    } else if (ctx.inEscapedSingleQuote) {
      if (!r.skipUntil(/[\\']/)) break;
      if (r.match("''")) continue; // ignore double single-quote
      if (r.match('\\')) {
        r.skip(); // just skip the escaped letter
        continue;
      }

      // must be the ending single-quote
      r.skip();
      ctx.inEscapedSingleQuote = false;
    } else if (ctx.inSingleQuote) {
      if (!r.skipUntil("'")) break;
      if (r.match("''")) continue; // ignore double single-quote

      // must be the ending single-quote
      r.skip();
      ctx.inSingleQuote = false;
    } else if (ctx.inBlockComment) {
      if (!r.skipUntil(/\/\*|\*\//)) break;
      if (r.match('/*', () => ctx!.inBlockComment!++)) continue;

      r.skip(2);
      ctx.inBlockComment--;
    } else if (ctx.inLineComment) {
      if (!r.skipUntil('\n')) break;

      r.skip();
      ctx.inLineComment = false;
    } else {
      if (!r.skipUntil(/[-$E'/]/)) break;

      if (r.match(/\$[a-zA-Z]*\$/, (m) => (ctx.dollarQuoted = m[0]))) continue;
      if (r.match("E'", () => (ctx.inEscapedSingleQuote = true))) continue;
      if (r.match("'", () => (ctx.inSingleQuote = true))) continue;
      if (r.match('--', () => (ctx.inLineComment = true))) continue;
      if (r.match('/*', () => (ctx.inBlockComment = 1))) continue;

      r.skip();
    }
  }
}

function shouldIgnoreValue(ctx?: Context) {
  if (!ctx) return false;

  return !!(
    ctx.dollarQuoted ||
    ctx.inLineComment ||
    ctx.inBlockComment ||
    ctx.inSingleQuote ||
    ctx.inEscapedSingleQuote
  );
}

type QueryFragmentToStringOptions = {
  valueFn?: EscapeFunction;
  identFn?: EscapeFunction;
  context: Context;
  contextHandler?: (ctx: Context, s: string) => void;
};

export interface QueryFragment {
  text: string;
  values?: unknown[];
  embed?: string;
  sql?: string;

  toString(opts?: QueryFragmentToStringOptions): string;
}

abstract class QueryFragmentBase implements QueryFragment {
  text: string = '';
  values: unknown[] = [];
  sql: string = '';
  statement: string = '';
  embed: string = '';

  #compile(valueFn: (x: unknown) => string) {
    return this.toString({
      valueFn: (x, context) => {
        if (shouldIgnoreValue(context)) return '';
        return valueFn(x);
      },
      context: {},
      contextHandler: pgContextHandler,
    });
  }

  constructor() {
    Object.defineProperties(this, {
      text: {
        enumerable: true,
        get: () => {
          let idx = 1;
          return this.#compile(() => '$' + idx++);
        },
      },

      values: {
        enumerable: true,
        get: () => {
          const values: unknown[] = [];
          this.#compile((x) => (values.push(x), ''));
          return values;
        },
      },

      sql: {
        enumerable: true,
        get: () => {
          return this.#compile(() => '?');
        },
      },

      statement: {
        enumerable: true,
        get: () => {
          let idx = 1;
          return this.#compile(() => ':' + idx++);
        },
      },

      embed: {
        enumerable: true,
        get: () => {
          return this.#compile((x) => pgString(x));
        },
      },
    });
  }

  abstract toString(opts?: QueryFragmentToStringOptions): string;
}

class QueryFragmentValue extends QueryFragmentBase {
  #value: unknown;

  constructor(value: unknown) {
    super();
    this.#value = value;
  }

  toString(opts?: QueryFragmentToStringOptions) {
    return (opts?.valueFn ?? pgString)(this.#value, opts?.context);
  }
}

class QueryFragmentIdent extends QueryFragmentBase {
  #ident: string;

  constructor(ident: string) {
    super();
    this.#ident = ident;
  }

  toString(opts?: QueryFragmentToStringOptions) {
    return (opts?.identFn ?? pgIdent)(this.#ident, opts?.context);
  }
}

// we exploits String constructor
class QueryFragmentRawString extends QueryFragmentBase {
  #string: string;

  constructor(s: unknown) {
    super();
    this.#string = String(s);
  }

  /* toString(_?: QueryFragmentToStringOptions) { */
  toString(opts?: QueryFragmentToStringOptions) {
    if (opts?.context && opts?.contextHandler) {
      opts.contextHandler(opts.context, this.#string);
    }
    return this.#string;
  }
}

export function isQueryFragment(x: unknown): x is QueryFragment {
  return x instanceof QueryFragmentBase;
}

function makeIdent(name: string) {
  return new QueryFragmentIdent(name);
}

function makeValue(x: unknown): QueryFragment | undefined {
  if (typeof x === 'undefined' || isQueryFragment(x)) return x;
  return new QueryFragmentValue(x);
}

function makeRaw(text: unknown | unknown[]): QueryFragment | undefined {
  if (typeof text === 'undefined' || isQueryFragment(text)) return text;
  if (Array.isArray(text)) return new QueryFragments(text.map(makeRaw));
  return new QueryFragmentRawString(text);
}

function makeJsonValue(x: unknown) {
  if (typeof x === 'undefined' || isQueryFragment(x)) return x;
  return makeRaw(JSON.stringify(x));
}

type QueryFragmentsOptions = {
  prefix?: string;
  glue?: string;
  suffix?: string;
  empty?: string;

  wrapperFn?: (s: string, opts?: QueryFragmentToStringOptions) => string;
};

export type QueryTemplateStyle = [
  text: TemplateStringsArray,
  ...values: unknown[],
];
export const isQueryTemplateStyle = (
  args: unknown,
): args is QueryTemplateStyle => {
  if (!Array.isArray(args)) return false;
  if (typeof args?.[0] !== 'object' || args[0] === null || !('raw' in args[0]))
    return false;
  if (!Array.isArray(args[0])) return false;
  const [texts, ...values] = args;
  return texts.length - 1 === values.length;
};

function sewTemplateTextsAndValues<T = unknown, R = unknown>(
  texts: T[],
  values: R[],
) {
  if (texts.length - 1 !== values.length)
    throw new Error('Invalid call of the function');
  return texts.flatMap((text, idx) => (idx ? [values[idx - 1], text] : [text]));
}

export class QueryFragments extends QueryFragmentBase {
  #list: QueryFragment[] = [];
  #opts: Required<QueryFragmentsOptions>;

  constructor(
    ...args:
      | []
      | [values: (QueryFragment | undefined)[], opts?: QueryFragmentsOptions]
      | [opts?: QueryFragmentsOptions]
  ) {
    super();
    this.#opts = {
      prefix: '',
      glue: '',
      suffix: '',
      empty: '',
      wrapperFn: (x) => x,
    };

    if (Array.isArray(args[0])) {
      const [values, opts] = args as [
        values: (QueryFragment | undefined)[],
        opts?: QueryFragmentsOptions,
      ];
      this.#opts = { ...this.#opts, ...opts };
      this.push(...values);
    } else {
      const [opts] = args as [opts?: QueryFragmentsOptions];
      this.#opts = { ...this.#opts, ...opts };
    }
  }

  setSewingPattern(
    prefix: string = '',
    glue: string = '',
    suffix: string = '',
    empty: string = '',
  ) {
    this.#opts = { ...this.#opts, prefix, glue, suffix, empty };
    return this;
  }

  push(...args: (QueryFragment | string | undefined)[]) {
    this.#list.push(
      ...(args.map(makeRaw).filter((x) => x !== undefined) as QueryFragment[]),
    );
    return this;
  }

  // alias
  append(...args: (QueryFragment | string | undefined)[]) {
    return this.push(...args);
  }

  join(glue: string = ', ') {
    this.#opts.glue = glue;
    return this;
  }

  prefix(prefix: string = ' ') {
    this.#opts.prefix = prefix;
    return this;
  }

  suffix(suffix: string = ' ') {
    this.#opts.suffix = suffix;
    return this;
  }

  empty(empty: string = '') {
    this.#opts.empty = empty;
    return this;
  }

  toString(opts?: QueryFragmentToStringOptions): string {
    const children = this.#list
      .map((x) => x.toString(opts))
      .filter((x) => x)
      .join(this.#opts.glue);
    if (!children) return this.#opts.empty;
    return (
      this.#opts.prefix +
      this.#opts.wrapperFn(children, opts) +
      this.#opts.suffix
    );
  }
}

/**
 * SQL template tag
 */
export function sql(
  ...args:
    | [texts: TemplateStringsArray, ...values: unknown[]]
    | [...values: unknown[]]
): QueryFragments {
  let fragments: (QueryFragment | undefined)[];
  if (isQueryTemplateStyle(args)) {
    // sql`...` comes here
    const [texts, ...values] = args as [
      texts: TemplateStringsArray,
      values: unknown[],
    ];
    // template string looks like a single QueryFragment for user
    fragments = [
      new QueryFragments(
        sewTemplateTextsAndValues(texts.map(makeRaw), values.map(makeValue)),
      ),
    ];
  } else {
    // normal function call
    fragments = args.map(makeValue);
  }

  return new QueryFragments(fragments);
}

/**
 * Example:
 *   SELECT * FROM ${ident('test.table')}
 *     => SELECT * FROM "test"."table"
 */
export const ident = makeIdent;

/**
 * Raw string injection
 */
export function raw(...args: unknown[]) {
  return new QueryFragments(args.map(makeRaw));
}

/**
 * JSON injector
 *
 * Example 1:
 *   json({ obj: 'abc' )
 *     => '{"obj": "abc"}'
 *
 * Example 2:
 *   json｀{"obj": ${ 'abc' }}｀
 *     => '{"obj": "abc"}'
 */
export function json(
  ...args:
    | [...json: unknown[]]
    | [texts: TemplateStringsArray, ...args: unknown[]]
) {
  let fragments: (QueryFragment | undefined)[];
  const wrapperFn = (x: string, opts?: QueryFragmentToStringOptions) =>
    (opts?.valueFn || pgString)(x, opts?.context);
  if (isQueryTemplateStyle(args)) {
    const [texts, ...values] = args;
    fragments = [
      new QueryFragments(
        sewTemplateTextsAndValues(
          texts.map(makeRaw),
          values.map(makeJsonValue),
        ),
        { wrapperFn },
      ),
    ];
  } else {
    // normal function call
    fragments = args.map(
      (x) => new QueryFragments([makeJsonValue(x)], { wrapperFn }),
    );
  }

  return new QueryFragments(fragments);
}

export function buildClauses(...args: WhereArg[]) {
  const clauses = new QueryFragments();

  const parse = (val: WhereArg) => {
    if (val === undefined) return;
    if (val === null) return;

    if (typeof val === 'string') {
      clauses.push(makeRaw(val));
      return;
    }

    if (isQueryFragment(val)) {
      clauses.push(val);
      return;
    }

    if (Array.isArray(val)) {
      val.forEach(parse);
      return;
    }

    if (typeof val === 'object') {
      for (const key in val) {
        if (val[key] === undefined) continue;

        if (isQueryFragment(val[key])) {
          clauses.push(sql`${makeIdent(key)} ${val[key]}`);
          continue;
        }

        if (val[key] === null) {
          clauses.push(sql`${makeIdent(key)} IS NULL`);
          continue;
        }

        if (Array.isArray(val[key])) {
          clauses.push(sql`${makeIdent(key)} = ANY (${val[key]})`);
          continue;
        }

        // それ以外
        clauses.push(sql`${makeIdent(key)} = ${val[key]}`);
      }
      return;
    }
  };

  parse(args);

  return clauses;
}

export function OR(...fv: WhereArg[]) {
  return buildClauses(fv).setSewingPattern('((', ') OR (', '))', '');
}

export function AND(...fv: WhereArg[]) {
  return buildClauses(fv).setSewingPattern('((', ') AND (', '))', '');
}

export function WHERE(...fv: WhereArg[]) {
  return buildClauses(fv).setSewingPattern('WHERE ((', ') AND (', '))', '');
}

export function WHERE_OR(...fv: WhereArg[]) {
  return buildClauses(fv).setSewingPattern('WHERE ((', ') OR (', '))', '');
}

export function UNION_ALL(...fv: unknown[]) {
  return raw(...fv).join(' UNION ALL ');
}

export function UNION(...fv: unknown[]) {
  return raw(...fv).join(' UNION ');
}

export function LIMIT(limit: number | string | null | undefined) {
  if (limit == null) return sql``;
  limit = Number(limit);
  return limit > 0 ? sql`LIMIT ${limit}` : sql``;
}

export function OFFSET(offset: number | string | null | undefined) {
  if (offset == null) return sql``;
  offset = Number(offset);
  return offset >= 0 ? sql`OFFSET ${offset}` : sql``;
}

export function buildValues(fvs: (FieldValues | unknown[])[]) {
  if (!Array.isArray(fvs)) {
    if (typeof fvs !== 'object')
      throw new Error('buildValues: The argument must be an array');
    fvs = [fvs];
  }
  if (fvs.length === 0)
    throw new Error('buildValues: Array must contain elements at least one');

  const array = fvs.map((x) => (typeof x === 'object' ? Object.values(x) : x));

  const sig = array[0].length;
  if (array.some((arg) => arg.length !== sig)) {
    throw new Error('buildValues: Array must all be the same length');
  }

  const values = sql(
    ...array.map((v) => sql(...v).join(', ')),
  ).setSewingPattern('(', '), (', ')');
  return sql`VALUES ${values}`;
}

export function buildKeys(fvs: FieldValues[] | FieldValues) {
  if (!Array.isArray(fvs)) fvs = [fvs];
  if (fvs.length == 0 || !fvs[0] || typeof fvs[0] !== 'object')
    throw new Error('Invalid call of the function');

  fvs = fvs.map((fv) =>
    Object.fromEntries(Object.entries(fv).filter(([_, v]) => v !== undefined)),
  );

  const ks = Object.keys(fvs[0]);
  const sig = ks.join();
  if (fvs.some((fv) => Object.keys(fv).join() !== sig)) {
    throw new Error('buildKeys: All objects must have the same keys');
  }

  return sql(...ks.map(makeIdent)).setSewingPattern('(', ', ', ')');
}

export function buildInsert(
  table: string,
  fvs: FieldValues[] | FieldValues,
  appendix?: string | QueryFragment,
) {
  if (!Array.isArray(fvs)) fvs = [fvs];

  const keys = buildKeys(fvs);
  const values = buildValues(fvs.map(Object.values));

  return sql`INSERT INTO ${makeIdent(table)} ${keys} ${values}`
    .append(appendix)
    .join(' ');
}

export function buildUpdate(
  table: string,
  fv: FieldValues,
  where?: WhereArg,
  appendix?: string | QueryFragment,
) {
  const pairs = new QueryFragments();

  for (const k in fv) {
    const val = fv[k];
    if (val === undefined) continue;

    pairs.push(sql`${makeIdent(k)} = ${val}`);
  }

  return sql`UPDATE ${makeIdent(table)} SET ${pairs.join(', ')} ${WHERE(where)}`
    .append(appendix)
    .join(' ');
}

export function buildDelete(
  table: string,
  where?: WhereArg,
  appendix?: string | QueryFragment,
) {
  return sql`DELETE FROM ${makeIdent(table)} ${WHERE(where)}`
    .append(appendix)
    .join(' ');
}

// aliases
export const or = OR;
export const and = AND;
export const where = WHERE;
export const WHERE_AND = WHERE;
export const where_and = WHERE;
export const where_or = WHERE_OR;

// expose via `sql`
sql.raw = raw;
sql.ident = ident;
sql.json = json;
sql.WHERE = WHERE;
sql.WHERE_AND = WHERE_AND;
sql.WHERE_OR = WHERE_OR;
sql.AND = AND;
sql.OR = OR;
sql.where = where;
sql.where_and = where_and;
sql.where_or = where_or;
sql.and = and;
sql.or = or;
sql.insert = buildInsert;
sql.update = buildUpdate;
sql.delete = buildDelete;
sql.keys = buildKeys;
sql.values = buildValues;
sql.UNION_ALL = UNION_ALL;
sql.UNION = UNION;
sql.LIMIT = LIMIT;
sql.OFFSET = OFFSET;

export default {
  sql,
  raw,
  ident,
  json,
  WHERE,
  WHERE_AND,
  WHERE_OR,
  AND,
  OR,
  where,
  where_and,
  where_or,
  and,
  or,
  buildInsert,
  buildUpdate,
  buildDelete,
  buildValues,
  UNION_ALL,
  UNION,
  LIMIT,
  OFFSET,
};
