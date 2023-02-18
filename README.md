# Query Weaver

Compose SQL statements safely by leveraging template string literals

## Usage

### As a SQL Builder
```js
import { sql } from 'query-weaver';
import pg from 'pg';

const foo = 1, bar = 'Bar';
const query = sql`SELECT * FROM foobar WHERE foo = ${ foo } AND bar = ${ bar }`;

console.log(query.toString())
// SELECT * FROM foobar WHERE foo = '1' AND bar = 'Bar'

const db = new pg.Pool();
const { rows } = await db.query(query);

console.log(rows)
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
```js
import { useQueryHelper } from 'query-weaver';
import pg from 'pg';

const db = useQueryHelper(new pg.Pool());

const foo = 1, bar = 'Bar';
const { rows } = await db.query`SELECT * FROM foobar WHERE foo = ${ foo } AND bar = ${ bar }`;

console.log(rows);
// [ { foo: 1, bar: 'Bar' } ]

db.end(); // this call will be proxied to the original pg.Pool() instance
```

Almost the same as above, but you can directly pass the template string to the `query` function.


### WHERE builder
```js
import { sql, WHERE, OR } from 'query-weaver';

const a = 1, b = "string", c = null, d = 5, e = false;
console.log(String(sql`SELECT * FROM foobar ${WHERE({ a, b, c }, OR({ d, e }))}`));
// SELECT * FROM foobar WHERE ((a = '1') AND (b = 'string') AND (c IS NULL) AND (((d = '5') OR (e = false))))

const q = sql`SELECT * FROM foobar ${WHERE(
  {
    a: 10,
    b: 'string',
    c: sql`IS UNKNOWN`,
    d: sql`BETWEEN ${a} AND ${d}`
  },
  "e IS NULL"
  sql`f IN (${f})`,
)}`
console.log(q.text);
// SELECT * FROM foobar WHERE ((a = $1) AND (b = $2) AND (c IS UNKNOWN) AND (d BETWEEN $3 AND $4) AND (e IS NULL) AND (f IN ($5)))

console.log(q.embed);
// SELECT * FROM foobar WHERE ((a = '10') AND (b = 'string') AND (c IS UNKNOWN) AND (d BETWEEN '1' AND '5') AND (e IS NULL) AND (f IN (ARRAY['1','2','3','4','5'])))
```


### JSON builder
```js
import pg from 'pg';
import { useQueryHelper, json } from 'query-weaver';

const db = useQueryHelper(new pg.Pool());

const id = 10;
const obj = { b: 'string', c: [1, 2, 'X'], d: { e: null, f: undefined } }

const row = await db.getRow`SELECT * FROM jsonb_to_record(${json`{ "a": ${ obj }, "b": ${id} }`}) AS (a jsonb, b int);`

console.log(row);
// {
//   a: { b: 'string', c: [ 1, 2, 'X' ], d: { e: null } },
//   b: 10,
// }

db.end();
```

### Simple INSERT helper and executor
`buildInsert` (or `sql.insert`) and `insert` executor

```js
sql.insert(tableName, { ... fieldValuePairs });  // => sql`INSERT INTO ...`
db.insert(tableName, { ... fieldValuePairs });   // => db.query`INSERT INTO ...`

// bulk insert
sql.insert(tableName, [{ ... fieldValuePairs }, ... ]);  // => sql`INSERT INTO ... VALUES (...), (...), ...`
db.insert(tableName, [{ ... fieldValuePairs }, ... ]);   // => db.query`INSERT INTO ... VALUES (...), (...), ...`
```

### Simple UPDATE helper and executor
`buildUpdate` (or `sql.update`) and `update`
```js
sql.update(tableName, { ... fieldValuePairs }, { ... whereCondition });  // => sql`UPDATE ...`
db.update(tableName, { ... fieldValuePairs }, { ... whereCondition });   // => db.query`UPDATE ...`
```

### Simple DELETE helper and executor
`buildDelete` (or `sql.delete`) and `delete`
```js
sql.delete(tableName, { ... whereCondition });  // => sql`DELETE FROM ...`
db.delete(tableName, { ... whereCondition });   // => db.query`DELETE FROM ...`
```
