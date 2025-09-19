import { StringReader } from '@kikuchan/string-reader';
import { quoteIdent, quoteLiteral } from './quote.ts';

type Context = {
  inLineComment?: boolean;
  inBlockComment?: number;
  inSingleQuote?: boolean;
  inEscapedSingleQuote?: boolean;
  dollarQuoted?: string;
};

type EscapeFunction = (v: unknown, context?: Context) => string;
export type FieldValues = Record<string, unknown>;
export type WhereArg = string | FieldValues | QueryFragment | undefined | WhereArg[];

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
  if (Array.isArray(s)) return 'ARRAY[' + s.map((e) => pgString(e)).join(',') + ']';
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
      if (!r.search(ctx.dollarQuoted)) break;
      ctx.dollarQuoted = undefined;
    } else if (ctx.inEscapedSingleQuote) {
      if (!r.skipUntil(/[\\']/)) break;
      if (r.match("''")) continue; // ignore double single-quote
      if (r.match(/\\./)) continue; // skip the escaped string

      // must be the ending of the single-quote
      if (!r.match("'")) break;
      ctx.inEscapedSingleQuote = false;
    } else if (ctx.inSingleQuote) {
      if (!r.skipUntil("'")) break;
      if (r.match("''")) continue; // ignore double single-quote

      // must be the ending of the single-quote
      if (!r.match("'")) break;
      ctx.inSingleQuote = false;
    } else if (ctx.inBlockComment) {
      if (!r.skipUntil(/\/\*|\*\//)) break;
      if (r.match('/*', () => ++ctx!.inBlockComment!)) continue;

      // must be the ending of the block comment
      if (!r.match('*/')) break;
      ctx.inBlockComment--;
    } else if (ctx.inLineComment) {
      if (!r.search(/\r\n|\r|\n/)) break;
      ctx.inLineComment = false;
    } else {
      if (!r.skipUntil(/[-$E'/]/)) break;

      if (r.match(/\$[a-zA-Z0-9_]*\$/, (m) => (ctx.dollarQuoted = m[0]))) continue;
      if (r.match("E'", () => (ctx.inEscapedSingleQuote = true))) continue;
      if (r.match("'", () => (ctx.inSingleQuote = true))) continue;
      if (r.match('--', () => (ctx.inLineComment = true))) continue;
      if (r.match('/*', () => (ctx.inBlockComment = 1))) continue;

      // not a known token
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
        enumerable: false,
        get: () => {
          return this.#compile(() => '?');
        },
      },

      statement: {
        enumerable: false,
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

class QueryFragmentRawString extends QueryFragmentBase {
  #string: string;

  constructor(s: unknown) {
    super();
    this.#string = String(s);
  }

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

export type QueryTemplateStyle = [text: TemplateStringsArray, ...values: unknown[]];
export const isQueryTemplateStyle = (args: unknown): args is QueryTemplateStyle => {
  if (!Array.isArray(args)) return false;
  if (typeof args?.[0] !== 'object' || args[0] === null || !('raw' in args[0])) return false;
  if (!Array.isArray(args[0])) return false;
  const [texts, ...values] = args;
  return texts.length - 1 === values.length;
};

function sewTemplateTextsAndValues<T = unknown, R = unknown>(texts: T[], values: R[]) {
  if (texts.length - 1 !== values.length) throw new Error('Invalid call of the function');
  return texts.flatMap((text, idx) => (idx ? [values[idx - 1], text] : [text]));
}

export class QueryFragments extends QueryFragmentBase {
  #list: QueryFragment[] = [];
  #opts: Required<QueryFragmentsOptions>;

  constructor(
    ...args: [] | [values: (QueryFragment | undefined)[], opts?: QueryFragmentsOptions] | [opts?: QueryFragmentsOptions]
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
      const [values, opts] = args as [values: (QueryFragment | undefined)[], opts?: QueryFragmentsOptions];
      this.#opts = { ...this.#opts, ...opts };
      this.push(...values);
    } else {
      const [opts] = args as [opts?: QueryFragmentsOptions];
      this.#opts = { ...this.#opts, ...opts };
    }
  }

  setSewingPattern(prefix: string = '', glue: string = '', suffix: string = '', empty: string = '') {
    this.#opts = { ...this.#opts, prefix, glue, suffix, empty };
    return this;
  }

  push(...args: (QueryFragment | string | undefined)[]) {
    this.#list.push(...(args.map(makeRaw).filter((x) => x !== undefined) as QueryFragment[]));
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
    return this.#opts.prefix + this.#opts.wrapperFn(children, opts) + this.#opts.suffix;
  }
}

/**
 * SQL template tag
 */
export function sql(
  ...args: [texts: TemplateStringsArray, ...values: unknown[]] | [...values: unknown[]]
): QueryFragments {
  let fragments: (QueryFragment | undefined)[];
  if (isQueryTemplateStyle(args)) {
    // sql`...` comes here
    const [texts, ...values] = args as [texts: TemplateStringsArray, values: unknown[]];
    // template string looks like a single QueryFragment for user
    fragments = [new QueryFragments(sewTemplateTextsAndValues(texts.map(makeRaw), values.map(makeValue)))];
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
export function json(...args: [...json: unknown[]] | [texts: TemplateStringsArray, ...args: unknown[]]) {
  let fragments: (QueryFragment | undefined)[];
  const wrapperFn = (x: string, opts?: QueryFragmentToStringOptions) => (opts?.valueFn || pgString)(x, opts?.context);
  if (isQueryTemplateStyle(args)) {
    const [texts, ...values] = args;
    fragments = [
      new QueryFragments(sewTemplateTextsAndValues(texts.map(makeRaw), values.map(makeJsonValue)), {
        wrapperFn,
      }),
    ];
  } else {
    // normal function call
    fragments = args.map((x) => new QueryFragments([makeJsonValue(x)], { wrapperFn }));
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
          const arrayValues = val[key] as unknown[];
          if (arrayValues.length === 0) {
            clauses.push(sql`FALSE`);
            continue;
          }
          clauses.push(sql`${makeIdent(key)} = ANY (${arrayValues})`);
          continue;
        }

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

type ExtractedFieldRows = { keys?: string[]; rows: unknown[][] };

function extractFieldRows(input: FieldValues[] | FieldValues | (FieldValues | unknown[])[]): ExtractedFieldRows {
  const list = (Array.isArray(input) ? input : [input]) as (FieldValues | unknown[])[];
  if (list.length === 0) {
    throw new Error('Invalid call of the function');
  }

  const first = list[0];

  if (Array.isArray(first)) {
    const rows = list.map((row) => {
      if (!Array.isArray(row)) {
        throw new Error('All rows must be arrays');
      }
      return row;
    });
    const sig = rows[0]?.length ?? 0;
    if (rows.some((row) => row.length !== sig)) {
      throw new Error('All arrays must have the same length');
    }
    return { rows };
  }

  if (!first || typeof first !== 'object') {
    throw new Error('Invalid call of the function');
  }

  const normalizedObjects = list.map((fv) => {
    if (!fv || typeof fv !== 'object' || Array.isArray(fv)) {
      throw new Error('Invalid call of the function');
    }
    return Object.fromEntries(Object.entries(fv).filter(([, v]) => v !== undefined)) as FieldValues;
  });

  const keys = Object.keys(normalizedObjects[0]);

  const rows = normalizedObjects.map((row) => {
    const rowKeys = Object.keys(row);
    if (rowKeys.length !== keys.length) {
      throw new Error('All objects must have the same keys');
    }

    const values = keys.map((key) => {
      if (!Object.prototype.hasOwnProperty.call(row, key)) {
        throw new Error('All objects must have the same keys');
      }
      return row[key];
    });

    return values;
  });

  const sig = rows[0]?.length ?? 0;
  if (rows.some((row) => row.length !== sig)) {
    throw new Error('All arrays must have the same length');
  }

  return { keys, rows };
}

function buildKeyValues(input: FieldValues[] | FieldValues | (FieldValues | unknown[])[]) {
  const { keys, rows } = extractFieldRows(input);
  const fields = keys ? sql(...keys.map(makeIdent)).setSewingPattern('(', ', ', ')') : undefined;
  const values = sql(...rows.map((v) => sql(...v).join(', '))).setSewingPattern('(', '), (', ')');

  return { keys, fields, VALUES: sql`VALUES ${values}` };
}

export function buildKeys(fvs: FieldValues[] | FieldValues): QueryFragments {
  const { fields } = buildKeyValues(fvs);
  if (!fields) {
    throw new Error('buildKeys: FieldValues must be objects');
  }
  return fields;
}

export function buildValues(fvs: (FieldValues | unknown[])[]) {
  return buildKeyValues(fvs).VALUES;
}

export function buildInsert(table: string, fvs: FieldValues[] | FieldValues, appendix?: string | QueryFragment) {
  const { fields, VALUES } = buildKeyValues(fvs);
  if (!fields) {
    throw new Error('buildInsert: FieldValues must be objects');
  }

  return sql`INSERT INTO ${makeIdent(table)} ${fields} ${VALUES}`.append(appendix).join(' ');
}

export function buildUpdate(table: string, fv: FieldValues, where?: WhereArg, appendix?: string | QueryFragment) {
  const pairs = new QueryFragments();

  for (const k in fv) {
    const val = fv[k];
    if (val === undefined) continue;

    pairs.push(sql`${makeIdent(k)} = ${val}`);
  }

  return sql`UPDATE ${makeIdent(table)} SET ${pairs.join(', ')} ${WHERE(where)}`.append(appendix).join(' ');
}

export function buildDelete(table: string, where?: WhereArg, appendix?: string | QueryFragment) {
  return sql`DELETE FROM ${makeIdent(table)} ${WHERE(where)}`.append(appendix).join(' ');
}

export function buildUpsert(
  table: string,
  fvs: FieldValues[] | FieldValues,
  onConflictKeys: string[],
  appendix?: string | QueryFragment,
) {
  const { keys, fields, VALUES } = buildKeyValues(fvs);
  if (!keys || !fields) {
    throw new Error('buildUpsert: FieldValues must be objects');
  }

  const ON_CONFLICT = sql(...onConflictKeys.map(makeIdent)).setSewingPattern('ON CONFLICT (', ', ', ')');
  const mutableKeys = keys.filter((x) => !onConflictKeys.includes(x));

  const CONFLICT_ACTION =
    mutableKeys.length === 0
      ? sql`DO NOTHING`
      : sql(...mutableKeys.map((k) => sql`${ident(k)} = EXCLUDED.${ident(k)}`)).setSewingPattern('DO UPDATE SET ', ', ');

  return sql`INSERT INTO ${makeIdent(table)} ${fields} ${VALUES} ${ON_CONFLICT} ${CONFLICT_ACTION}`
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
