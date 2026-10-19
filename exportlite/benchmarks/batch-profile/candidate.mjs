// Screening candidate only; production adoption is gated on timings and tests.
export function boundarySql(tableName, columnNames, format = "json") {
  const quote = (name) => `"${name.replaceAll('"', '""')}"`;
  const table = `main.${quote(tableName)} AS "__exportlite_source"`;
  const columns = columnNames.map(quote).join(", ");
  const pairs = columnNames
    .map((name) => `'${name.replaceAll("'", "''")}', ${quote(name)}`)
    .join(", ");
  const object = `json_object(${pairs})`;
  const aggregate =
    format === "json"
      ? `json_group_array(${object})`
      : `group_concat(${object}, char(10))`;
  const first = '"__exportlite_batches"."first"';
  const last = '"__exportlite_batches"."last"';
  return `WITH RECURSIVE "__exportlite_batches"("first", "last") AS (
    SELECT
      (SELECT rowid FROM ${table} ORDER BY rowid LIMIT 1),
      (SELECT rowid FROM ${table} ORDER BY rowid LIMIT 1 OFFSET 255)
    UNION ALL
    SELECT
      (SELECT rowid FROM ${table} WHERE rowid > ${last} ORDER BY rowid LIMIT 1),
      (SELECT rowid FROM ${table} WHERE rowid > ${last} ORDER BY rowid LIMIT 1 OFFSET 255)
    FROM "__exportlite_batches" WHERE ${last} IS NOT NULL
  )
  SELECT (
    SELECT ${aggregate}
    FROM (SELECT ${columns} FROM ${table}
      WHERE rowid BETWEEN ${first} AND coalesce(${last}, 9223372036854775807)
      ORDER BY rowid)
  ), CASE WHEN ${last} IS NOT NULL THEN 256 ELSE
    (SELECT count(*) FROM ${table} WHERE rowid >= ${first}) END
  FROM "__exportlite_batches" WHERE ${first} IS NOT NULL`;
}
