import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { exportQuery } from "../src/index.js";

it("reuses successful capability checks, retries failures, and always exports fresh data", async () => {
  const db = new Database(":memory:");
  let unsupported = true;
  let versionChecks = 0;
  let jsonChecks = 0;
  const connection = {
    prepare(sql: string) {
      if (sql === "SELECT sqlite_version()") versionChecks++;
      if (sql === "SELECT json_object('ok', 1)") jsonChecks++;
      return db.prepare(
        unsupported ? sql.replace("sqlite_version()", "'3.44.0'") : sql,
      );
    },
  };
  const query = () =>
    exportQuery(connection, { sql: "SELECT * FROM data", format: "json" });
  try {
    db.exec("CREATE TABLE data(id); INSERT INTO data VALUES(1)");
    await expect(query()).rejects.toHaveProperty("code", "UNSUPPORTED_SQLITE");
    unsupported = false;
    const first = await query();
    expect(await new Response(first).json()).toEqual([{ id: 1 }]);
    await first.result;
    db.exec(
      "ALTER TABLE data ADD COLUMN name TEXT DEFAULT 'changed'; INSERT INTO data(id) VALUES(2)",
    );
    const second = await query();
    expect(await new Response(second).json()).toEqual([
      { id: 1, name: "changed" },
      { id: 2, name: "changed" },
    ]);
    await second.result;
    expect(versionChecks).toBe(2);
    expect(jsonChecks).toBe(1);
  } finally {
    db.close();
  }
});
