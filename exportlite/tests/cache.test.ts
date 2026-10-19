import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { exportQuery, exportTable } from "../src/index.js";

async function table(
  db: Parameters<typeof exportTable>[0],
  name = "data",
  columns?: readonly string[],
) {
  const options = columns
    ? { format: "json" as const, columns }
    : { format: "json" as const };
  const stream = await exportTable(db, name, options);
  const rows = await new Response(stream).json();
  await stream.result;
  return rows;
}

it("reuses a table plan but still sees data changes and distinct column projections", async () => {
  const db = new Database(":memory:");
  const prepared: string[] = [];
  const connection = {
    prepare(sql: string) {
      prepared.push(sql);
      return db.prepare(sql);
    },
  };
  try {
    db.exec(
      "CREATE TABLE data(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO data VALUES(1,'first')",
    );
    expect(await table(connection)).toEqual([{ id: 1, name: "first" }]);
    db.exec("UPDATE data SET name='changed'; INSERT INTO data VALUES(2,'new')");
    expect(await table(connection)).toEqual([
      { id: 1, name: "changed" },
      { id: 2, name: "new" },
    ]);
    expect(
      prepared.filter((sql) =>
        sql.startsWith("SELECT name FROM main.sqlite_schema"),
      ),
    ).toHaveLength(1);
    expect(
      prepared.filter((sql) => sql === "SELECT sqlite_version()"),
    ).toHaveLength(1);
    expect(await table(connection, "data", ["name"])).toEqual([
      { name: "changed" },
      { name: "new" },
    ]);
    expect(
      prepared.filter((sql) =>
        sql.startsWith("SELECT name FROM main.sqlite_schema"),
      ),
    ).toHaveLength(2);
  } finally {
    db.close();
  }
});

it("invalidates table metadata after external schema changes, including switching to a fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "exportlite-cache-schema-"));
  const writer = new Database(join(directory, "data.db"));
  writer.pragma("journal_mode=WAL");
  writer.exec(
    "CREATE TABLE data(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO data VALUES(1,'first')",
  );
  const reader = new Database(join(directory, "data.db"));
  try {
    expect(await table(reader)).toEqual([{ id: 1, name: "first" }]);
    writer.exec("ALTER TABLE data ADD COLUMN active INTEGER DEFAULT 1");
    expect(await table(reader)).toEqual([{ id: 1, name: "first", active: 1 }]);
    writer.exec(
      "DROP TABLE data; CREATE TABLE data(id TEXT PRIMARY KEY,note TEXT) WITHOUT ROWID; INSERT INTO data VALUES('b','new schema')",
    );
    expect(await table(reader)).toEqual([{ id: "b", note: "new schema" }]);
    writer.exec("ALTER TABLE data RENAME TO moved");
    await expect(table(reader)).rejects.toHaveProperty(
      "code",
      "INVALID_SCHEMA",
    );
    expect(await table(reader, "moved")).toEqual([
      { id: "b", note: "new schema" },
    ]);
  } finally {
    reader.close();
    writer.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("invalidates plans across rolled-back schema changes and preserves caller transactions", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      "CREATE TABLE data(id INTEGER PRIMARY KEY); INSERT INTO data VALUES(1)",
    );
    expect(await table(db)).toEqual([{ id: 1 }]);
    db.exec("BEGIN; ALTER TABLE data ADD COLUMN note TEXT DEFAULT 'temporary'");
    expect(await table(db)).toEqual([{ id: 1, note: "temporary" }]);
    expect(db.inTransaction).toBe(true);
    db.exec("ROLLBACK");
    expect(await table(db)).toEqual([{ id: 1 }]);
  } finally {
    db.close();
  }
});

it("keeps overlapping lazy streams independent and continues after cancellation", async () => {
  const db = new Database(":memory:");
  const prepared: string[] = [];
  const connection = {
    prepare(sql: string) {
      prepared.push(sql);
      return db.prepare(sql);
    },
  };
  try {
    db.exec("CREATE TABLE data(id INTEGER PRIMARY KEY,note TEXT)");
    const insert = db.prepare("INSERT INTO data VALUES(?,?)");
    db.transaction(() => {
      for (let id = 1; id <= 1024; id++) insert.run(id, "x".repeat(1024));
    })();
    const first = await exportTable(connection, "data", { format: "json" });
    const second = await exportTable(connection, "data", { format: "json" });
    const reader = first.getReader();
    try {
      expect((await reader.read()).done).toBe(false);
      expect(await new Response(second).json()).toHaveLength(1024);
      await second.result;
      await reader.cancel();
      await expect(first.result).rejects.toHaveProperty("code", "ABORTED");
      expect(await table(connection)).toHaveLength(1024);
      expect(
        prepared.filter((sql) =>
          sql.startsWith("SELECT name FROM main.sqlite_schema"),
        ),
      ).toHaveLength(1);
      db.exec("DROP TABLE data");
    } finally {
      await reader.cancel().catch(() => {});
    }
  } finally {
    db.close();
  }
});

it("holds no statement lease for a stream cancelled before consumption", async () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE data(id); INSERT INTO data VALUES(1)");
    const stream = await exportTable(db, "data", { format: "json" });
    await stream.cancel();
    await expect(stream.result).rejects.toHaveProperty("code", "ABORTED");
    expect(await table(db)).toEqual([{ id: 1 }]);
  } finally {
    db.close();
  }
});

it("supports another export after an output failure", async () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE data(id); INSERT INTO data VALUES(1)");
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("disk full"));
      },
    });
    await expect(
      exportTable(db, "data", { format: "json", output }),
    ).rejects.toHaveProperty("code", "OUTPUT_ERROR");
    expect(await table(db)).toEqual([{ id: 1 }]);
    db.exec("DROP TABLE data");
  } finally {
    db.close();
  }
});

it("bounds retained plans and rebuilds an evicted plan", async () => {
  const db = new Database(":memory:");
  let metadataPrepares = 0;
  const connection = {
    prepare(sql: string) {
      if (sql.startsWith("SELECT name FROM main.sqlite_schema"))
        metadataPrepares++;
      return db.prepare(sql);
    },
  };
  try {
    for (let i = 0; i < 18; i++)
      db.exec(`CREATE TABLE t${i}(id); INSERT INTO t${i} VALUES(${i})`);
    for (let i = 0; i < 18; i++)
      expect(await table(connection, `t${i}`)).toEqual([{ id: i }]);
    expect(metadataPrepares).toBe(18);
    expect(await table(connection, "t0")).toEqual([{ id: 0 }]);
    expect(metadataPrepares).toBe(19);
  } finally {
    db.close();
  }
});

it("does not cache a failed capability probe or missing table", async () => {
  const db = new Database(":memory:");
  let old = true;
  const connection = {
    prepare(sql: string) {
      return db.prepare(
        old ? sql.replace("sqlite_version()", "'3.44.0'") : sql,
      );
    },
  };
  try {
    await expect(table(connection)).rejects.toHaveProperty(
      "code",
      "UNSUPPORTED_SQLITE",
    );
    old = false;
    await expect(table(connection)).rejects.toHaveProperty(
      "code",
      "INVALID_SCHEMA",
    );
    db.exec("CREATE TABLE data(id); INSERT INTO data VALUES(1)");
    expect(await table(connection)).toEqual([{ id: 1 }]);
  } finally {
    db.close();
  }
});

it("refreshes custom query column metadata after main and temporary schema changes", async () => {
  const db = new Database(":memory:");
  const query = async () => {
    const stream = await exportQuery(db, {
      sql: "SELECT * FROM data",
      format: "json",
    });
    const result = await new Response(stream).json();
    await stream.result;
    return result;
  };
  try {
    db.exec("CREATE TABLE data(id); INSERT INTO data VALUES(1)");
    expect(await query()).toEqual([{ id: 1 }]);
    db.exec("ALTER TABLE data ADD COLUMN name TEXT DEFAULT 'main'");
    expect(await query()).toEqual([{ id: 1, name: "main" }]);
    db.exec(
      "CREATE TEMP TABLE data(note TEXT); INSERT INTO temp.data VALUES('temporary')",
    );
    expect(await query()).toEqual([{ note: "temporary" }]);
  } finally {
    db.close();
  }
});
