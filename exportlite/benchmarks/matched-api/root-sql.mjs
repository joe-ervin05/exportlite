import assert from "node:assert/strict";
import { planBatchedTable } from "./build/engine-entry.mjs";

export function rootJsonSql(sql) {
  const begin = sql.indexOf("json_group_array(") + "json_group_array(".length;
  const end = sql.lastIndexOf(") AS data");
  assert(begin > 0 && end > begin);
  return `SELECT ${sql.slice(begin, end).trim()} ${sql.slice(end + ") AS data".length)}`;
}

export function batchedJsonSql(db, aggregateSql, fullFlat = false) {
  // Reuse the actual package planner. The benchmark adapter changes only the
  // root JSON projection and limits the original fixture to this case's roots.
  const nested = aggregateSql.includes("'posts'");
  const columns = nested ? ["id", "name"] : ["name"];
  const planned = planBatchedTable(db, {
    table: "users",
    columnNames: ["id", "name"],
    columns,
    format: "json",
  });
  assert(planned);
  if (fullFlat) {
    assert(!nested);
    return planned.source;
  }
  const rootSelect = rootJsonSql(aggregateSql);
  const expression = rootSelect
    .slice("SELECT ".length, rootSelect.lastIndexOf("\n  FROM "))
    .trim();
  let sql = planned.source;
  const replace = (before, after) => {
    assert.equal(
      sql.split(before).length,
      2,
      `Expected one occurrence of ${before}`,
    );
    sql = sql.replace(before, after);
  };
  replace(
    `json_group_array(json_object(${columns.map((column) => `'${column}', "${column}"`).join(", ")}))`,
    `json_group_array(${expression})`,
  );
  if (sql.includes('("first", "last")')) {
    sql = sql.replaceAll(
      `FROM main."users" AS "__exportlite_source" ORDER BY "rowid" LIMIT 1`,
      `FROM main."users" AS "__exportlite_source" WHERE "rowid"<=@roots ORDER BY "rowid" LIMIT 1`,
    );
    sql = sql.replaceAll(
      `WHERE "rowid" > "__exportlite_batches"."last"`,
      `WHERE "rowid"<=@roots AND "rowid" > "__exportlite_batches"."last"`,
    );
    replace(
      `coalesce("__exportlite_batches"."last", 9223372036854775807)`,
      `coalesce("__exportlite_batches"."last", @roots)`,
    );
    replace(`WHERE "rowid" >=`, `WHERE "rowid"<=@roots AND "rowid" >=`);
  } else {
    replace(
      `FROM main."users" AS "__exportlite_source" ORDER BY "rowid" LIMIT 256`,
      `FROM main."users" AS "__exportlite_source" WHERE "rowid"<=@roots ORDER BY "rowid" LIMIT 256`,
    );
    replace(
      `WHERE "rowid" > json_extract`,
      `WHERE "rowid"<=@roots AND "rowid" > json_extract`,
    );
  }
  replace(`ORDER BY "rowid")\n  )`, `ORDER BY "rowid") AS u\n  )`);
  return sql;
}
