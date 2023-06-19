import pgescape from 'pg-escape';

type EscapeFunction = (v: unknown) => string;
export type FieldValues = Record<string, unknown>;
export type WhereArg =
  | string
  | FieldValues
  | QueryFragment
  | undefined
  | WhereArg[];

export function pgIdent(s: string) {
  // '.' is a special for us
  return s
    .split('.')
    .map((x) => pgescape.ident(x))
    .join('.');
}

// fallback function for when the EscapeFunction is not specified
export function pgString(s: unknown): string {
  if (s === null) return 'NULL';
  if (typeof s === 'boolean') return s ? 'true' : 'false';
  if (Array.isArray(s)) return 'ARRAY[' + s.map(pgString).join(',') + ']';
  if (typeof s === 'object') {
    if ('toJSON' in s && typeof s.toJSON === 'function')
      return pgescape.literal(s.toJSON());
    return pgescape.literal(s.toString());
  }
  return pgescape.literal(String(s));
}

type QueryFragmentToStringOptions = {
  valueFn?: EscapeFunction;
  identFn?: EscapeFunction;
};

export interface QueryFragment {
  text: string;
  values?: unknown[];
  embed?: string;
  sql?: string;

  toString(opts?: QueryFragmentToStringOptions): string;
}

abstract class QueryFragmentBase implements QueryFragment {
  // XXX: entries for defineProperties
  text: string = '';
  values: unknown[] = [];
  embed?: string = '';

  get compiled() {
    const values = [] as unknown[];
    const text = this.toString({
      valueFn: (x: unknown) => {
        values.push(x);
        return '$' + values.length;
      },
    });
    const embed = this.toString();

    return {
      text,
      values,
      embed,
    };
  }

  constructor() {
    Object.defineProperties(this, {
      text: {
        enumerable: true,
        get() {
          return this.compiled.text;
        },
      },
      values: {
        enumerable: true,
        get() {
          return this.compiled.values;
        },
      },
      embed: {
        enumerable: true,
        get() {
          return this.compiled.embed;
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
    return (opts?.valueFn ?? pgString)(this.#value);
  }
}

class QueryFragmentIdent extends QueryFragmentBase {
  #ident: string;

  constructor(ident: string) {
    super();
    this.#ident = ident;
  }

  toString(opts?: QueryFragmentToStringOptions) {
    return (opts?.identFn ?? pgIdent)(this.#ident);
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
  toString() {
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
  ...values: unknown[]
];
export const isQueryTemplateStyle = (
  args: unknown
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
  values: R[]
) {
  if (texts.length - 1 !== values.length)
    throw new Error('Invalid call of the function');
  return texts.flatMap((text, idx) => (idx ? [values[idx - 1], text] : [text]));
}

class QueryFragments extends QueryFragmentBase {
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
        opts?: QueryFragmentsOptions
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
    empty: string = ''
  ) {
    this.#opts = { ...this.#opts, prefix, glue, suffix, empty };
    return this;
  }

  push(...args: (QueryFragment | string | undefined)[]) {
    this.#list.push(
      ...(args.map(makeRaw).filter((x) => x !== undefined) as QueryFragment[])
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
    if (this.#list.length === 0) return this.#opts.empty;
    return (
      this.#opts.prefix +
      this.#opts.wrapperFn(
        this.#list.map((x) => x.toString(opts)).join(this.#opts.glue),
        opts
      ) +
      this.#opts.suffix
    );
  }
}

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
      values: unknown[]
    ];
    // template string looks like a single QueryFragment for user
    fragments = [
      new QueryFragments(
        sewTemplateTextsAndValues(texts.map(makeRaw), values.map(makeValue))
      ),
    ];
  } else {
    // normal function call
    fragments = args.map(makeValue);
  }

  return new QueryFragments(fragments);
}

export const ident = makeIdent;

export function raw(...args: unknown[]) {
  return new QueryFragments(args.map(makeRaw));
}

export function json(
  ...args:
    | [...json: unknown[]]
    | [texts: TemplateStringsArray, ...args: unknown[]]
) {
  let fragments: (QueryFragment | undefined)[];
  const wrapperFn = (x: string, opts?: QueryFragmentToStringOptions) =>
    (opts?.valueFn || pgString)(x);
  if (isQueryTemplateStyle(args)) {
    const [texts, ...values] = args;
    fragments = [
      new QueryFragments(
        sewTemplateTextsAndValues(
          texts.map(makeRaw),
          values.map(makeJsonValue)
        ),
        { wrapperFn }
      ),
    ];
  } else {
    // normal function call
    fragments = args.map(
      (x) => new QueryFragments([makeJsonValue(x)], { wrapperFn })
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
    ...array.map((v) => sql(...v).join(', '))
  ).setSewingPattern('(', '), (', ')');
  return sql`VALUES ${values}`;
}

export function buildKeys(fvs: FieldValues[] | FieldValues) {
  if (!Array.isArray(fvs)) fvs = [fvs];
  if (fvs.length == 0 || !fvs[0] || typeof fvs[0] !== 'object')
    throw new Error('Invalid call of the function');

  const ks = Object.keys(fvs[0]);
  const sig = ks.join();
  if (fvs.some((fv) => Object.keys(fv).join() !== sig)) {
    throw new Error('buildKeys: All objects must have the same key');
  }

  return sql(...ks.map(makeIdent)).setSewingPattern('(', ', ', ')');
}

export function buildInsert(
  table: string,
  fvs: FieldValues[] | FieldValues,
  appendix?: string | QueryFragment
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
  appendix?: string | QueryFragment
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
  appendix?: string | QueryFragment
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
};
