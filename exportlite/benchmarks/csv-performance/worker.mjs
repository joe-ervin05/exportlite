import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { setImmediate as tick } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(`${root}exportlite/package.json`);
const median = (a) => [...a].sort((a, b) => a - b)[Math.floor(a.length / 2)];
assert.equal(
  process.argv[2],
  "worker",
  "Run benchmarks/csv-performance/run.mjs",
);
if (process.argv[2] === "worker") {
  const [fixtureText, method, compression] = process.argv.slice(3);
  const fixture = JSON.parse(fixtureText);
  const Database = require("better-sqlite3");
  const db = new Database(fixture.path, { readonly: true });
  const build = process.env.EXPORTLITE_BUILD ?? `${root}exportlite/dist`;
  const api = method.startsWith("manual")
    ? undefined
    : await import(pathToFileURL(join(build, "index.mjs")));
  const zip = compression === "zip";
  const ZipStream =
    zip && method.startsWith("manual")
      ? (await import(pathToFileURL(require.resolve("zip-stream")))).default
      : undefined;
  const hasModes = fixture.columns.some((c) => c.mode);
  const names = fixture.columns.map((c) => c.key);
  const sql = `SELECT ${names.map((n) => `"${n}"`).join(",")} FROM data ORDER BY id`;
  let orm, table, adapter;
  if (fixture.drizzle && api) {
    const { drizzle } = require("drizzle-orm/better-sqlite3");
    const schema = require("drizzle-orm/sqlite-core");
    table = schema.sqliteTable(
      "data",
      Object.fromEntries(
        fixture.columns.map((c) => [
          c.key,
          c.primary
            ? schema.integer(c.key).primaryKey()
            : c.type === "integer"
              ? schema.integer(c.key, c.mode ? { mode: c.mode } : undefined)
              : schema.text(c.key, c.mode ? { mode: c.mode } : undefined),
        ]),
      ),
    );
    orm = drizzle(db);
    adapter = await import(pathToFileURL(join(build, "drizzle.mjs")));
  }
  const columns =
    api &&
    Object.fromEntries(
      fixture.columns.map((c) => {
        let value =
          c.type === "integer"
            ? api.integer(c.key, c.mode ? { mode: c.mode } : undefined)
            : api.text(c.key);
        if (c.primary) value = value.primaryKey();
        return [c.key, value];
      }),
    );
  const quote = (v) =>
    v === null
      ? ""
      : typeof v === "string"
        ? `"${v.replaceAll('"', '""')}"`
        : String(v);
  const encoders = fixture.columns.map((c) =>
    c.mode === "boolean"
      ? (v) => (v === null ? "" : v ? '"true"' : '"false"')
      : c.mode === "json"
        ? (v) => (v === null ? "" : quote(JSON.stringify(JSON.parse(v))))
        : quote,
  );
  const normalized = (v, c) =>
    v === null
      ? null
      : c.mode === "boolean"
        ? v
          ? "true"
          : "false"
        : c.mode === "json"
          ? JSON.stringify(JSON.parse(v))
          : v;
  async function generate(sink) {
    const statement = db.prepare(sql);
    let parts = [],
      size = 0;
    async function flush() {
      if (!size) return;
      const bytes = Buffer.from(parts.join(""));
      parts = [];
      size = 0;
      await new Promise((resolve, reject) => {
        let callbackDone = false,
          drained = false,
          writing = true;
        const cleanup = () => {
          sink.off("error", fail);
          sink.off("drain", onDrain);
        };
        const complete = () => {
          if (!writing && callbackDone && drained) {
            cleanup();
            resolve();
          }
        };
        const fail = (e) => {
          cleanup();
          reject(e);
        };
        const onDrain = () => {
          drained = true;
          complete();
        };
        sink.once("error", fail);
        sink.once("drain", onDrain);
        drained = sink.write(bytes, (e) => {
          if (e) return;
          callbackDone = true;
          complete();
        });
        writing = false;
        complete();
      });
    }
    const append = (s) => {
      parts.push(s);
      size += Buffer.byteLength(s);
      return size >= 65536 ? flush() : undefined;
    };
    append(`${names.map(quote).join(",")}\r\n`);
    let count = 0;
    for (const row of statement.iterate()) {
      const record =
        method === "manual-tuned"
          ? names.length === 4
            ? `${encoders[0](row.id)},${encoders[1](row.name)},${encoders[2](row.note)},${encoders[3](row.active)}\r\n`
            : `${names.map((key, index) => encoders[index](row[key])).join(",")}\r\n`
          : names.length === 4 && !hasModes
            ? `${quote(row.id)},${quote(row.name)},${quote(row.note)},${quote(row.active)}\r\n`
            : names.length === 4
              ? `${quote(normalized(row.id, fixture.columns[0]))},${quote(normalized(row.name, fixture.columns[1]))},${quote(normalized(row.note, fixture.columns[2]))},${quote(normalized(row.active, fixture.columns[3]))}\r\n`
              : `${fixture.columns.map((c) => quote(normalized(row[c.key], c))).join(",")}\r\n`;
      const wait = append(record);
      if (wait) await wait;
      if (++count % 2048 === 0) await tick();
    }
    await flush();
    const done = finished(sink, { readable: false, cleanup: true });
    sink.end();
    await done;
  }
  async function consume(verify) {
    let bytes = 0;
    const digest = verify ? createHash("sha256") : undefined;
    const sink = new Writable({
      highWaterMark: 65536,
      write(chunk, _e, cb) {
        bytes += chunk.length;
        digest?.update(chunk);
        cb();
      },
    });
    if (api) {
      const options = { format: "csv", zip, output: sink, end: true };
      let result;
      if (fixture.drizzle)
        result =
          method === "table"
            ? await adapter.exportTable(orm, table, options)
            : await adapter.exportQuery(
                orm,
                orm.select().from(table).orderBy(table.id),
                options,
              );
      else
        result =
          method === "table"
            ? await api.exportTable(db, "data", { ...options, columns })
            : await api.exportQuery(db, { ...options, columns, sql });
      assert.equal(result.rowsExported, fixture.rows);
      assert.equal(result.bytesWritten, bytes);
    } else if (zip) {
      const input = new PassThrough({ highWaterMark: 65536 });
      const archive = new ZipStream({
        forceZip64: true,
        zlib: { level: 1, memLevel: 9, chunkSize: 262144 },
      });
      const done = pipeline(archive, sink);
      done.catch(() => {});
      archive.entry(
        input,
        { name: "data.csv", date: new Date("1980-01-01T00:00:00Z") },
        (e) => (e ? archive.destroy(e) : archive.finalize()),
      );
      try {
        await generate(input);
        await done;
      } catch (e) {
        input.destroy();
        archive.destroy(e);
        await done.catch(() => {});
        throw e;
      }
    } else await generate(sink);
    return { bytes, ...(digest ? { sha256: digest.digest("hex") } : {}) };
  }
  try {
    const verified = await consume(true);
    for (let i = 0; i < 2; i++) await consume(false);
    const samplesMs = [],
      cpuMs = [];
    for (let i = 0; i < 3; i++) {
      const cpu = process.cpuUsage();
      const t = performance.now();
      for (let j = 0; j < fixture.iterations; j++) await consume(false);
      samplesMs.push((performance.now() - t) / fixture.iterations);
      const used = process.cpuUsage(cpu);
      cpuMs.push((used.user + used.system) / 1000 / fixture.iterations);
    }
    console.log(
      JSON.stringify({
        fixture: fixture.name,
        method,
        compression,
        ...verified,
        samplesMs,
        medianMs: median(samplesMs),
        cpuSamplesMs: cpuMs,
        medianCpuMs: median(cpuMs),
        peakRssMiB: process.resourceUsage().maxRSS / 1024,
      }),
    );
  } finally {
    db.close();
  }
}
