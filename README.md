# Query Weaver

Compose SQL statements safely by leveraging template string literals

## Install

```sh
$ npm install query-weaver
```

## Usage

### As a SQL Builder

<!-- prettier-ignore -->
```js
import { sql } from 'query-weaver';
import pg from 'pg';

const foo = 1, bar = 'Bar';
const query = sql`SELECT * FROM foobar WHERE foo = ${foo} AND bar = ${bar}`;

console.log(query.toString());
// SELECT * FROM foobar WHERE foo = '1' AND bar = 'Bar'

const db = new pg.Pool();
const { rows } = await db.query(query);

console.log(rows);
// [ { foo: 1, bar: 'Bar' } ]

console.log(JSON.stringify(query, null, 2));
// {
//   "text": "SELECT * FROM foobar WHERE foo = $1 AND bar = $2",
//   "values": [
//     1,
//     "Bar"
//   ],
//   "embed": "SELECT * FROM foobar WHERE foo = '1' AND bar = 'Bar'"
// }

db.end();
```

As you can see, the query is executed using **placeholder** on the database. This makes string-value concatenation safe.
You can also get a string embed version of the query, so that you can debug the query easily.

### As a Query Helper (with `node-postgres` for example)

<!-- prettier-ignore -->
```js
import { withQueryHelper } from 'query-weaver';
import pg from 'pg';

const db = withQueryHelper(new pg.Pool());

const foo = 1, bar = 'Bar';
const { rows } =
  await db.query`SELECT * FROM foobar WHERE foo = ${foo} AND bar = ${bar}`;

console.log(rows);
// [ { foo: 1, bar: 'Bar' } ]

db.end(); // this call will be proxied to the original pg.Pool() instance
```

Almost the same as above, but you can directly pass the template string to the `query` function.

### WHERE builder

`WHERE_AND` / `WHERE_OR` / `AND` / `OR` / `WHERE` (`WHERE_AND` alias)

<!-- prettier-ignore -->
```js
import { sql, WHERE, OR } from 'query-weaver';

const a = 1, b = 'string', c = null, d = 5, e = false, f = [1, 2, 3, 4, 5];
console.log(
  String(sql`SELECT * FROM foobar ${WHERE({ a, b, c }, OR({ d, e }))}`)
);
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

### JSON builder

```js
import pg from 'pg';
import { withQueryHelper, json } from 'query-weaver';

const db = withQueryHelper(new pg.Pool());

const id = 10;
const obj = { b: 'string', c: [1, 2, 'X'], d: { e: null, f: undefined } };

const row =
  await db.getRow`SELECT * FROM jsonb_to_record(${json`{ 'a': ${obj}, 'b': ${id} }`}) AS (a jsonb, b int);`;

console.log(row);
// {
//   a: { b: 'string', c: [ 1, 2, 'X' ], d: { e: null } },
//   b: 10,
// }

db.end();
```

### VALUES builder

`buildValues` / `sql.values`

```js
sql.values([[1, 2, 3], ...]);              // => VALUES (1, 2, 3), (...), ...
sql.values([{ a: 1, b: 2, c: 3 }], ...]);  // => VALUES (1, 2, 3), (...), ...
```

### Key builder

`buildKeys` / `sql.keys`

```js
sql.keys({ a: 1, b: 2, c: 3 });         // => (a, b, c)
sql.keys([{ a: 1, b: 2, c: 3 }, ...]);  // => (a, b, c)
```

### Raw builder

`raw`

```js
console.log(sql`SELECT * FROM foobar WHERE ${raw("bar LIKE '%something%'")}`);
```

### Simple INSERT builder and executor

`buildInsert` / `sql.insert` builder, and `insert` executor

```js
sql.insert(tableName, { ... fieldValuePairs });  // => sql`INSERT INTO ...`
db.insert(tableName, { ... fieldValuePairs });   // => db.query`INSERT INTO ...`

// bulk insert
sql.insert(tableName, [{ ... fieldValuePairs }, ... ]);  // => sql`INSERT INTO ... VALUES (...), (...), ...`
db.insert(tableName, [{ ... fieldValuePairs }, ... ]);   // => db.query`INSERT INTO ... VALUES (...), (...), ...`
```

### Simple UPDATE builder and executor

`buildUpdate` / `sql.update` builder, and `update` executor

```js
sql.update(tableName, { ...fieldValuePairs }, { ...whereCondition }); // => sql`UPDATE ...`
db.update(tableName, { ...fieldValuePairs }, { ...whereCondition }); // => db.query`UPDATE ...`
```

### Simple DELETE builder and executor

`buildDelete` / `sql.delete` builder, and `delete` executor

```js
sql.delete(tableName, { ...whereCondition }); // => sql`DELETE FROM ...`
db.delete(tableName, { ...whereCondition }); // => db.query`DELETE FROM ...`
```

### API

As you can see, an object built and constructed by `sql` keyword behave like a simple object with the following properties;
`text`, `values`, and `embed`.

Furthermore, the object also comes up with the following APIs;

- `append(...)` / `push(...)`
  - append a **raw SQL string** or an object created by `sql`, to the query
- `join(glue = ', ')` / `prefix(prefix)` / `suffix(suffix)` / `empty(empty)`
  - set glue/prefix/suffix/empty string for toString(), respectively
- `setSewingPattern(prefix, glue, suffix, empty)`
  - set sewing pattern for toString() at once
- `toString(opts?)`
  - constructs SQL string (by using sewing pattern and `opts` settings)

To create the object;

- `` sql`template string with ${value}` `` / `` json`{"a": "b", "c": ${value}}` ``
  - creates a query object with values that will be automatically escaped
- `sql(value, ...)` / `json(value)`
  - creates a query object from only values that will be automatically escaped

These APIs can be used, for example, to construct `IN` clause;

```js
console.log(
  sql`SELECT * FROM foobar WHERE foo IN (${sql(1, 2, 3).join()})`.embed,
);
// SELECT * FROM foobar WHERE foo IN ('1', '2', '3')

const a = [1, 2, 3];
console.log(sql`SELECT * FROM foobar WHERE foo IN (${sql(...a).join()})`.text);
// SELECT * FROM foobar WHERE foo IN ($1, $2, $3)
```

### Caveats

- Only `sql` and `json` accepts a template string literal.
- The actual SQL statement executed on the database may differ between `[.text, .values]` and `.embed`, due to differences in serialize functions. If you really want to get the exact same statement, you can try this for example:

```js
import pgUtil from 'pg/lib/utils.js';
import pgEscape from 'pg-escape';

console.log(sql`SELECT ${[1, 2, 3, 4, 5]}`.embed);
// SELECT ARRAY['1','2','3','4','5']

console.log(sql`SELECT ${pgUtil.prepareValue([1, 2, 3, 4, 5])}`.embed);
// SELECT '{"1","2","3","4","5"}'

// or, pass a custom serialize function
console.log(
  sql`SELECT ${[1, 2, 3, 4, 5]}`.toString({
    valueFn: (x) => pgEscape.literal(JSON.stringify(x)),
  }),
);
// SELECT '[1,2,3,4,5]'
```

### DEBUG

You can get access to the statements and results when using the Query Helper.
I use the following code to record the session;

<!-- prettier-ignore -->
```js
import zlib from 'node:zlib'

const db = withQueryHelper(new pg.Pool(), {
  onError: (ctx, error) => console.error(JSON.stringify({ error: zlib.gzipSync(JSON.stringify({ ... ctx, error })).toString('base64') })),
  beforeQuery: (ctx) => console.log(JSON.stringify({ query: zlib.gzipSync(JSON.stringify(ctx)).toString('base64') })),
  afterQuery: (ctx) => console.log(JSON.stringify({ result: zlib.gzipSync(JSON.stringify(ctx)).toString('base64') })),
});
```

After that, you'll see something like this on the console;

<!-- prettier-ignore -->
```json
{"query":"H4sIAAAAAAAAA6tWKkmtKFGyUgp29XF1DlHQUnAL8vdVSMvPT0osUgj3cA1yBXEUbBVUDJV0lMoSc0pTi5Wsog1jdZRSc5NSU4jRqm6oDtRblFpcmlMC1FytlJyfm5uYh9ALks0vd84vzQM6xRDMAVlSrQTUDxYAmghU7AQka2NrawEDVej4tQAAAA=="}
```

Now you can extract the contents by executing the following command;

<!-- prettier-ignore -->
```sh
% echo '... base64part' | base64 -d | zcat | jq -r .

# or if you're using X11, select base64 part and then;
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
  "results": {
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

It is very handy to replay the session like this;

```sh
% xclip -o | base64 -d | zcat | jq -r .embed | psql
 foo | bar
-----+-----
   1 | Bar
(1 row)

# Or, you can make a shell-script named `xclip-query` then
% xclip-query .embed | psql
```

### Query Helper with custom `query` handler

The final underlying `query` function can be changed by using `query` option.
So you can use Prisma, TypeORM, or whatever you want if you write a query handler for them.

Here are examples for using it;

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
```ts
const queryable = async function (this: object, { text, values}: QueryConfig) {
  return {
    rows: [this], // `this` would be the object you passed to the constructor
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
Now you can use Query Weaver interfaces on them.
