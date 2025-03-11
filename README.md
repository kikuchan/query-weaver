# Query Weaver

Compose SQL statements safely by leveraging template string literals.

## Install

```sh
$ npm install query-weaver
```

## Basic Usage

### As an SQL Builder

<!-- prettier-ignore -->
```ts
import { sql } from 'query-weaver';

const foo = 1, bar = 'Bar';
const query = sql`SELECT * FROM foobar WHERE foo = ${foo} AND bar = ${bar}`;
console.log(query);
// QueryFragments { text: [Getter], values: [Getter], embed: [Getter] }

console.log(JSON.stringify(query, null, 2));
// {
//   "text": "SELECT * FROM foobar WHERE foo = $1 AND bar = $2",
//   "values": [
//     1,
//     "Bar"
//   ],
//   "embed": "SELECT * FROM foobar WHERE foo = '1' AND bar = 'Bar'"
// }
```

The query is executed using **placeholders** in the database, which makes string-value concatenation safe. You can also obtain an embedded string version of the query so that you can easily debug it by copying and pasting.

### Inject a Query Helper

<!-- prettier-ignore -->
```ts
import { withQueryHelper } from 'query-weaver';
import pg from 'pg';

const db = withQueryHelper(new pg.Pool());

const foo = 1, bar = 'Bar';
const { rows } =
  await db.query`SELECT * FROM foobar WHERE foo = ${foo} AND bar = ${bar}`;

console.log(rows);
// [ { foo: 1, bar: 'Bar' } ]

db.end();
```

The `withQueryHelper` utility wraps the original object with a Query Helper, providing utility functions as if they were built into the original object. Essentially, these are shorthand functions that bridge the original `query` and the Query Weaver functions, with the most notable features being debugging and transaction support.

## Utilities

### WHERE Builder

`WHERE_AND` / `WHERE_OR` / `AND` / `OR` / `WHERE` (`WHERE_AND` alias)

<!-- prettier-ignore -->
```ts
import { sql, WHERE, OR } from 'query-weaver';

const a = 1, b = 'string', c = null, d = 5, e = false, f = [1, 2, 3, 4, 5];
console.log(String(sql`SELECT * FROM foobar ${WHERE({ a, b, c }, OR({ d, e }))}`));
// SELECT * FROM foobar WHERE ((a = '1') AND (b = 'string') AND (c IS NULL) AND (((d = '5') OR (e = false))))

const q = sql`SELECT * FROM foobar ${WHERE(
  {
    a: 10,
    b: 'string',
    c: sql`IS UNKNOWN`,
    d: sql`BETWEEN ${a} AND ${d}`,
  },
  'e IS NULL',
  sql`f = ANY (${f})`
)}`;
console.log(q.text);
// SELECT * FROM foobar WHERE ((a = $1) AND (b = $2) AND (c IS UNKNOWN) AND (d BETWEEN $3 AND $4) AND (e IS NULL) AND (f = ANY ($5)))

console.log(q.embed);
// SELECT * FROM foobar WHERE ((a = '10') AND (b = 'string') AND (c IS UNKNOWN) AND (d BETWEEN '1' AND '5') AND (e IS NULL) AND (f = ANY (ARRAY['1','2','3','4','5'])))
```

### JSON Builder

`json`

```js
import pg from 'pg';
import { withQueryHelper, json } from 'query-weaver';

const db = withQueryHelper(new pg.Pool());

const id = 10;
const obj = { b: 'string', c: [1, 2, 'X'], d: { e: null, f: undefined } };

const row =
  await db.getRow`SELECT * FROM jsonb_to_record(${json`{"a": ${obj}, "b": ${id}}`}) AS (a jsonb, b int);`;

console.log(row);
// {
//   a: { b: 'string', c: [ 1, 2, 'X' ], d: { e: null } },
//   b: 10,
// }

db.end();
```

### VALUES Builder

`buildValues` / `sql.values`

```js
sql.values([[1, 2, 3], ...]);            // => VALUES (1, 2, 3), (...), ...
sql.values([{ a: 1, b: 2, c: 3 }, ...]); // => VALUES (1, 2, 3), (...), ...
```

### Key Builder

`buildKeys` / `sql.keys`

```js
sql.keys({ a: 1, b: 2, c: 3 });        // => (a, b, c)
sql.keys([{ a: 1, b: 2, c: 3 }, ...]); // => (a, b, c)
```

### Raw Builder

`raw`

```ts
import { sql, raw } from 'query-weaver';

console.log(JSON.stringify(sql`SELECT * FROM foobar WHERE ${raw("bar LIKE '%something%'")}`));
// {"text":"SELECT * FROM foobar WHERE bar LIKE '%something%'","values":[],"embed":"SELECT * FROM foobar WHERE bar LIKE '%something%'"}
```

### INSERT Builder and Helper

`buildInsert` / `sql.insert` builder, and `insert` helper

```js
sql.insert(tableName, { ...fieldValuePairs }); // => sql`INSERT INTO ...`
db.insert(tableName, { ...fieldValuePairs });  // => db.query`INSERT INTO ...`

// Bulk insert
sql.insert(tableName, [{ ...fieldValuePairs }, ...]); // => sql`INSERT INTO ... VALUES (...), (...), ...`
db.insert(tableName, [{ ...fieldValuePairs }, ...]);  // => db.query`INSERT INTO ... VALUES (...), (...), ...`
```

### UPDATE Builder and Helper

`buildUpdate` / `sql.update` builder, and `update` helper

```js
sql.update(tableName, { ...fieldValuePairs }, { ...whereCondition }); // => sql`UPDATE ...`
db.update(tableName, { ...fieldValuePairs }, { ...whereCondition });  // => db.query`UPDATE ...`
```

### DELETE Builder and Helper

`buildDelete` / `sql.delete` builder, and `delete` helper

```js
sql.delete(tableName, { ...whereCondition }); // => sql`DELETE FROM ...`
db.delete(tableName, { ...whereCondition });  // => db.query`DELETE FROM ...`
```

### Transaction Helper

`begin` helper

```js
db.begin(() => {
    db.delete(...);
    db.insert(...);
});
```

If an error occurs, the transaction is safely rolled back.
**NOTE:** Transactions can be nested, but only the outermost transaction is effective.

## Low-level APIs

An object created by the `sql` keyword behaves like a simple object with the following properties: `text`, `values`, and `embed`.

In addition, the object provides the following APIs:

- `append(...)` / `push(...)`
  - Appends a **raw SQL string** or an object created by `sql` to the query.
- `join(glue = ', ')` / `prefix(prefix)` / `suffix(suffix)` / `empty(empty)`
  - Sets the glue, prefix, suffix, or empty string for `toString()`, respectively.
- `setSewingPattern(prefix, glue, suffix, empty)`
  - Sets the sewing pattern for `toString()` all at once.
- `toString(opts?)`
  - Constructs the SQL string using the sewing pattern and any provided `opts` settings.

To create a query object, you can use:

- `` sql`template string with ${value}` `` / `` json`{"a": "b", "c": ${value}}` ``
  - Creates a query object with values that are automatically escaped.
- `sql(value, ...)` / `json(value)`
  - Creates a query object from values that are automatically escaped.

These APIs can be used, for example, to construct an `IN` clause as follows:

```ts
import { sql } from 'query-weaver';

console.log(sql`SELECT * FROM foobar WHERE foo IN (${sql(1, 2, 3).join()})`.embed);
// SELECT * FROM foobar WHERE foo IN ('1', '2', '3')

const a = [1, 2, 3];
console.log(sql`SELECT * FROM foobar WHERE foo IN (${sql(...a).join()})`.text);
// SELECT * FROM foobar WHERE foo IN ($1, $2, $3)
```

### Caveats

- Only `sql` and `json` accept a template string literal.
- The actual SQL statement executed on the database may sometimes differ between `[.text, .values]` and `.embed` due to differences in serialization functions.

### DEBUG

You can easily access the statements and results when using the Query Helper. For example, the following code records the session:

<!-- prettier-ignore -->
```js
import zlib from 'node:zlib'

const db = withQueryHelper(new pg.Pool(), {
  onError: (ctx, error) => console.error(JSON.stringify({ error: zlib.gzipSync(JSON.stringify({ ...ctx, error })).toString('base64') })),
  beforeQuery: (ctx) => console.log(JSON.stringify({ query: zlib.gzipSync(JSON.stringify(ctx)).toString('base64') })),
  afterQuery: (ctx, result) => console.log(JSON.stringify({ result: zlib.gzipSync(JSON.stringify({ ...ctx, result })).toString('base64') })),
});
```

After running this, you will see output similar to the following in the console:

<!-- prettier-ignore -->
```json
{"query":"H4sIAAAAAAACA6tWKkmtKFGyUgp29XF1DlHQUnAL8vdVSMvPT0osUgj3cA1yBXEUbBVUDJV0lMoSc0pTi5Wsog1jdZRSc5NSU4jRqm6oDtRblFpcmgO0qlopOT83NzEPoRUkmV/unF+aB5Q2BHNAdlQrAbWDBYAGAhU7Acna2NpaABybVha0AAAA"}
```

You can extract the contents by executing the following command:

<!-- prettier-ignore -->
```sh
% echo '... base64part' | base64 -d | zcat | jq -r .

# Or, if you're using X11, select the base64 part and then:
% xclip -o | base64 -d | zcat | jq -r .
```

<!-- prettier-ignore -->
```json
{
  "text": "SELECT * FROM foobar WHERE foo = $1",
  "values": [
    1
  ],
  "embed": "SELECT * FROM foobar WHERE foo = '1'",
  "result": {
    "command": "SELECT",
    "rowCount": 1,
    "rows": [
      {
        "foo": 1,
        "bar": "Bar"
      }
    ]
  }
}
```

It is very handy to replay the session as follows:

```sh
% xclip -o | base64 -d | zcat | jq -r .embed | psql
 foo | bar
-----+-----
   1 | Bar
(1 row)

# Or, you can create a shell script named `xclip-query` and then run:
% xclip-query .embed | psql
```

### Query Helper with a Custom `query` Function

The underlying `query` function, which is used to perform queries, can be replaced by using the `query` option. This allows you to use Prisma, TypeORM, or even raw SQLite object with Query Helper. For example:

<!-- prettier-ignore -->
```js
const db = withQueryHelper(new PrismaClient(), {
  query: QueryHelper.prisma,
});

console.log(await db.query`...`);
```

<!-- prettier-ignore -->
```js
const db = withQueryHelper(new DataSource({ ... }), {
  query: QueryHelper.typeorm,
});

console.log(await db.query`...`);
```

<!-- prettier-ignore -->
```js
import { DatabaseSync } from 'node:sqlite';

const db = withQueryHelper(new DatabaseSync(), {
  query: QueryHelper.sqlite,
});

console.log(await db.query`...`);
```

<!-- prettier-ignore -->
```ts
import { withQueryHelper } from 'query-weaver';

const queryable = async function (this: object, { text, values }: QueryConfig) {
  return {
    rows: [this], // `this` will be the object you passed to the constructor
    rowCount: 1,
  }
}

const db = withQueryHelper({ some: 'Hello, object' }, {
  query: queryable,
});

console.log(await db.getRow`HELLO QUERY`);
// { some: 'Hello, object' }
```

That's it!
Now you can use Query Weaver interfaces on the objects.
