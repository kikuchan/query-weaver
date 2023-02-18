import { sql, useQueryHelper, json, WHERE, AND, OR } from "query-weaver";

const queryable = {
  async query(cfg: { text: string; values?: unknown[] }): Promise<any> {
    return { rows: [{ text: cfg.text, values: cfg.values }], rowCount: 1 };
  },
};
const db = useQueryHelper(queryable); // mock

test("doc 1", async () => {
  const foo = 1,
    bar = "Bar";
  const query = sql`SELECT * FROM foobar WHERE foo = ${foo} AND bar = ${bar}`;
  expect(query.toString()).toBe(
    "SELECT * FROM foobar WHERE foo = '1' AND bar = 'Bar'"
  );
  expect(query.embed).toBe(
    "SELECT * FROM foobar WHERE foo = '1' AND bar = 'Bar'"
  );
  expect(query.text).toBe("SELECT * FROM foobar WHERE foo = $1 AND bar = $2");
  expect(query.values).toEqual([1, "Bar"]);
});

test("and, or", async () => {
  const a = 1,
    b = "string",
    c = null,
    d = 5,
    e = false;
  const query = String(
    sql`SELECT * FROM foobar ${WHERE({ a, b, c }, OR({ d, e }))}`
  );
  expect(query).toBe(
    "SELECT * FROM foobar WHERE ((a = '1') AND (b = 'string') AND (c IS NULL) AND (((d = '5') OR (e = false))))"
  );
});

test("check1", async () => {
  const id = 10;
  const obj = { b: "string", c: [1, 2, "X"], d: { e: null, f: undefined } };

  const row1 = await db.getRow(
    sql`SELECT * FROM jsonb_to_record(${json`{ "a": ${obj}, "b": ${id} }`}) AS (a jsonb, b int, c jsonb, d jsonb);`
  );
  const row2 =
    await db.getRow`SELECT * FROM jsonb_to_record(${json`{ "a": ${obj}, "b": ${id} }`}) AS (a jsonb, b int, c jsonb, d jsonb);`;

  expect(row1).toEqual(row2);
});
