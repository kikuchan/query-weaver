import pgescape from 'pg-escape'

type EscapeFunction = (v: unknown) => string
export type FieldValues = Record<string, unknown>
export type WhereArg = string | FieldValues | QueryFragment | undefined | WhereArg[]

export function pgIdent(s: string) {
  // '.' is a special for us
  return s.split('.').map(x => pgescape.ident(x)).join('.');
}

// fallback function for when the EscapeFunction is not specified
export function pgString(s: unknown): string {
  if (s === null) return 'NULL';
  if (typeof s === 'boolean') return s ? 'true' : 'false';
  if (Array.isArray(s)) return pgescape.literal('{' + s.join(',') + '}');
  if (typeof s === 'object') return pgescape.literal(JSON.stringify(s));
  return pgescape.literal(String(s));
}

type QueryFragmentToStringOptions = { valueFn?: EscapeFunction, identFn?: EscapeFunction };

class QueryFragmentValue {
  #value: unknown;

  constructor (value: unknown) {
    this.#value = value;
  }

  toString(opts?: QueryFragmentToStringOptions) {
    return (opts?.valueFn ?? pgString)(this.#value);
  }

  toJSON () { return this.toString() }
}

class QueryFragmentIdent {
  #ident: string;

  constructor (ident: string) {
    this.#ident = ident;
  }

  toString(opts?: QueryFragmentToStringOptions) {
    return (opts?.identFn ?? pgIdent)(this.#ident);
  }

  toJSON () { return this.toString() }
}

// we exploits String constructor
class QueryFragmentString extends String {};

export type QueryFragment = QueryFragmentString | QueryFragmentValue | QueryFragmentIdent | QueryFragments
export function isQueryFragment(x: unknown): x is QueryFragment {
  return x instanceof QueryFragmentString || x instanceof QueryFragmentValue || x instanceof QueryFragmentIdent || x instanceof QueryFragments;
}

function sewTextsAndValues<T = unknown, R = unknown>(texts: TemplateStringsArray, values: R[], hook: (value: unknown) => T = ((x: unknown) => x as T)) {
  if (texts.length - 1 !== values.length) throw new Error("Invalid call of the function");
  return texts.flatMap((text, idx) => idx ? [hook(values[idx - 1]), new QueryFragmentString(text)] : [new QueryFragmentString(text)]);
}

const value = (x: unknown) => {
  if (isQueryFragment(x)) return x; // assume it's already wrapped
  return new QueryFragmentValue(x);
}

type QueryFragmentsOptions = {
    prefix?: string
    glue?: string
    suffix?: string
    empty?: string

    makeFragmentFn?: (x: unknown) => QueryFragment,
    wrapperFn?: (s: string, opts?: QueryFragmentToStringOptions) => string
}

const isTemplateStringsArray = (x: unknown): x is TemplateStringsArray => (typeof x === 'object' && x !== null && 'raw' in x);

class QueryFragments {
  #list: QueryFragment[] = [];
  #opts: Required<QueryFragmentsOptions>;

  constructor(...args: [] | [texts: TemplateStringsArray, values: unknown[], opts?: QueryFragmentsOptions] | [values: unknown[], opts?: QueryFragmentsOptions] | [opts?: QueryFragmentsOptions]) {
    this.#opts = { prefix: '', glue: '', suffix: '', empty: '', makeFragmentFn: value, wrapperFn: x => x };

    if (isTemplateStringsArray(args[0])) {
      const [texts, values, opts] = args as [texts: TemplateStringsArray, values: unknown[], opts?: QueryFragmentsOptions];
      this.#opts = { ... this.#opts, ... opts }
      this.#list = sewTextsAndValues(texts, values, this.#opts.makeFragmentFn);
    } else if (Array.isArray(args[0])) {
      const [values, opts] = args as [values: unknown[], opts?: QueryFragmentsOptions];
      this.#opts = { ... this.#opts, ... opts }
      this.#list = values.map(v => this.#opts.makeFragmentFn(v));
    } else {
      const [opts] = args as [opts?: QueryFragmentsOptions];
      this.#opts = { ... this.#opts, ... opts }
    }
  }

  setSewingPattern(prefix: string = '', glue: string = '', suffix: string = '', empty: string = '') {
    this.#opts = { ... this.#opts, prefix, glue, suffix, empty }
    return this;
  }

  push(v: QueryFragment | string | undefined) {
    if (typeof v === 'undefined') return this;
    if (typeof v === 'string') v = raw(v)
    this.#list.push(v);
    return this;
  }

  join(glue: string = '') {
    this.#opts.glue = glue;
    return this;
  }

  toString(opts?: QueryFragmentToStringOptions): string {
    if (this.#list.length === 0) return this.#opts.empty;
    return this.#opts.prefix + this.#opts.wrapperFn(this.#list.map(x => x.toString(opts)).join(this.#opts.glue), opts) + this.#opts.suffix;
  }

  toJSON () { return this.toString() }
}

export function sql(text: string): QueryFragmentString;
export function sql(texts: TemplateStringsArray, ...args: unknown[]): QueryFragments;
export function sql(texts: TemplateStringsArray | string, ... args: unknown[]) {
  if (typeof texts === 'string') return new QueryFragmentString(texts);
  return new QueryFragments(texts, args);
}

export const raw = sql; // just an alias
export const ident = (name: string) => new QueryFragmentIdent(name);

export function json(...args: [json: unknown] | [texts: TemplateStringsArray, ... args: unknown[]]) {
  if (isTemplateStringsArray(args[0])) {
    const [texts, ...values] = args;

    return new QueryFragments(texts, values, {
      wrapperFn: (x: string, opts?: QueryFragmentToStringOptions) => opts?.valueFn?.(x) ?? x, // make it string value
      makeFragmentFn: (x: unknown) => raw(JSON.stringify(x)), // no escape while in the JSON
    });
  }

  const [obj] = args;
  if (isQueryFragment(obj)) return obj; // assume it's already wrapped
  return sql`${JSON.stringify(obj)}`;
}

export function buildClauses(...args: WhereArg[]) {
  const clauses = new QueryFragments();

  const parse = function (val: WhereArg) {
    // 配列、もしくは、直接指定された場合
    if (val === undefined) return ;
    if (val === null) return ;
    if (typeof val === 'string') { clauses.push(raw(val)); return ; }
    if (isQueryFragment(val)) { clauses.push(val); return ; }
    if (Array.isArray(val)) { val.forEach(parse); return ; }

    // オブジェクトは、対応表として扱う
    // XXX: 仕様が分かりづらい... ?
    if (typeof val === 'object') {
      for (const key in val) {
        if (val[key] === undefined) continue;

        if (isQueryFragment(val[key])) {
          clauses.push(val[key] as QueryFragment); // XXX:
          continue;
        }

        if (val[key] === null) {
          clauses.push(sql`${ident(key)} IS NULL`);
          continue;
        }

        if (Array.isArray(val[key])) {
          clauses.push(sql`${ident(key)} = ANY (${val[key]})`);
          continue;
        }

        // それ以外
        clauses.push(sql`${ident(key)} = ${val[key]}`);
      }
    }
  }

  parse(args);

  return clauses;
}

export function OR(...fv: WhereArg[]) {
  return buildClauses(fv).setSewingPattern('((', ') OR (', '))', 'false');
}

export function AND(...fv: WhereArg[]) {
  return buildClauses(fv).setSewingPattern('((', ') AND (', '))', 'true');
}

export function WHERE(...fv: WhereArg[]) {
  return buildClauses(fv).setSewingPattern('WHERE ((', ') AND (', '))', '');
}

export function WHERE_OR(...fv: WhereArg[]) {
  return buildClauses(fv).setSewingPattern('WHERE ((', ') OR (', '))', '');
}

export function buildInsert(table: string, fv: FieldValues) {
  const keys = new QueryFragments();
  const holders = new QueryFragments();

  for (const key in fv) {
    const val = fv[key];

    if (val === undefined) continue;

    keys.push(ident(key));
    holders.push(value(val));
  }

  return sql`INSERT INTO ${ident(table)} (${ keys.join(', ') }) VALUES (${ holders.join(', ') })`;
}

export function buildUpdate(table: string, fv: FieldValues, where?: WhereArg) {
  const pairs = new QueryFragments();

  for (const k in fv) {
    const val = fv[k];
    if (val === undefined) continue;

    pairs.push(sql`${ident(k)} = ${val}`);
  }

  return sql`UPDATE ${ident(table)} SET ${pairs.join(', ')} ${WHERE(where)}`;
}

export function buildDelete(table: string, where?: WhereArg) {
  return sql`DELETE FROM ${ident(table)} ${WHERE(where)}`;
}


// aliases
export const or = OR;
export const and = AND;
export const where = WHERE;
export const WHERE_AND = WHERE;
export const where_and = WHERE;
export const where_or = WHERE_OR;

export default {
  sql, raw, ident, json,
  WHERE, WHERE_AND, WHERE_OR, AND, OR,
  where, where_and, where_or, and, or,
  buildInsert, buildUpdate, buildDelete
};
