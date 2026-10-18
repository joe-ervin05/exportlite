import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const match = /^--([a-z]+)=(.*)$/.exec(arg);
    if (!match) throw new Error(`Use --option=value, got ${arg}`);
    return [match[1], match[2]];
  }),
);
for (const key of Object.keys(options)) {
  if (
    ![
      "rows",
      "width",
      "repeats",
      "warmups",
      "destinations",
      "out",
      "methods",
    ].includes(key)
  )
    throw new Error(`Unknown option --${key}`);
}
function integer(value, name, minimum = 1) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < minimum)
    throw new Error(`${name} must be an integer >=${minimum}`);
  return n;
}
const counts = (options.rows ?? "1000,100000,1000000")
  .split(",")
  .map((n) => integer(n, "rows"));
const width = integer(options.width ?? "32", "width", 0);
const repeats = integer(options.repeats ?? "3", "repeats");
const warmups = integer(options.warmups ?? "1", "warmups", 0);
const destinations = (options.destinations ?? "null,file").split(",");
if (destinations.some((d) => !["null", "file"].includes(d)))
  throw new Error("destinations must contain null or file");
const methods = (
  options.methods ?? "exportlite,object-stream,raw-stream,naive-all,sqlite-cli"
).split(",");
if (
  methods.some(
    (m) =>
      ![
        "exportlite",
        "object-stream",
        "raw-stream",
        "naive-all",
        "sqlite-cli",
        "sqlite-aggregate",
        "exportlite-query",
      ].includes(m),
  )
)
  throw new Error("Unknown method");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const worker = join(root, "benchmarks", "worker.mjs");
const temporary = await mkdtemp(join(tmpdir(), "exportlite-bench-"));
const sqliteBin = process.env.SQLITE_BIN ?? "sqlite3";
const cliProbe = spawnSync(sqliteBin, ["--version"], { encoding: "utf8" });
const skipped = [];
if (cliProbe.status !== 0 && methods.includes("sqlite-cli")) {
  methods.splice(methods.indexOf("sqlite-cli"), 1);
  skipped.push(
    `SQLite CLI unavailable: ${cliProbe.error?.message ?? cliProbe.stderr}`,
  );
}
function fixture(path, rows) {
  const db = new Database(path);
  db.exec(
    "CREATE TABLE data (id INTEGER PRIMARY KEY, name TEXT, note TEXT, active INTEGER)",
  );
  // Include Unicode, quotes, newlines and NULL with one width per case.
  const payload = '雪 "line"\n'.repeat(Math.ceil(width / 9)).slice(0, width);
  db.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < @rows)
    INSERT INTO data SELECT x, printf('user-%08d', x),
      CASE WHEN x % 7 = 0 THEN NULL ELSE @payload END, x % 2 FROM n`).run({
    rows,
    payload,
  });
  const firstRecordBytes = Buffer.byteLength(
    `[${JSON.stringify(db.prepare("SELECT * FROM data ORDER BY id LIMIT 1").get())}`,
  );
  const sqliteVersion = db.prepare("SELECT sqlite_version()").pluck().get();
  db.close();
  return { firstRecordBytes, sqliteVersion };
}
async function execute(method, dbPath, destination, firstRecordBytes) {
  const outputPath = join(temporary, "export.json");
  const child = spawn(
    process.execPath,
    [
      "--expose-gc",
      worker,
      method,
      dbPath,
      destination,
      outputPath,
      String(firstRecordBytes),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${method} failed (${code}): ${stderr}`)),
    );
  });
  return { metrics: JSON.parse(stdout), outputPath };
}
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[half]
    : (sorted[half - 1] + sorted[half]) / 2;
};
const results = [];
let sqliteVersion;
try {
  // Check semantic equivalence outside the timed runs, without retaining large exports.
  const verifyPath = join(temporary, "verify.sqlite");
  const verify = fixture(verifyPath, 257);
  const expectedDb = new Database(verifyPath, { readonly: true });
  const expected = expectedDb.prepare("SELECT * FROM data ORDER BY id").all();
  expectedDb.close();
  for (const method of methods) {
    const { outputPath } = await execute(
      method,
      verifyPath,
      "file",
      verify.firstRecordBytes,
    );
    assert.deepEqual(
      JSON.parse(await readFile(outputPath, "utf8")),
      expected,
      `${method}: output differs`,
    );
    await unlink(outputPath);
  }
  process.stderr.write(
    `Verified equivalent JSON from ${methods.length} implementations.\n`,
  );
  for (const rows of counts) {
    const dbPath = join(temporary, `${rows}.sqlite`);
    const info = fixture(dbPath, rows);
    sqliteVersion = info.sqliteVersion;
    for (const destination of destinations) {
      const byMethod = new Map(methods.map((method) => [method, []]));
      for (let iteration = -warmups; iteration < repeats; iteration++) {
        // Rotate order to reduce consistent first/last-position bias.
        const offset = (iteration + warmups) % methods.length;
        const ordered = [...methods.slice(offset), ...methods.slice(0, offset)];
        for (const method of ordered) {
          const { metrics, outputPath } = await execute(
            method,
            dbPath,
            destination,
            info.firstRecordBytes,
          );
          assert.equal(metrics.rows, rows);
          if (destination === "file") await unlink(outputPath);
          if (iteration >= 0) byMethod.get(method).push(metrics);
        }
      }
      for (const [method, runs] of byMethod) {
        const durations = runs.map((r) => r.durationMs);
        const summary = {};
        for (const key of Object.keys(runs[0])) {
          if (typeof runs[0][key] === "number")
            summary[key] = median(runs.map((r) => r[key]));
          else if (runs[0][key] === null) summary[key] = null;
        }
        summary.minDurationMs = Math.min(...durations);
        summary.maxDurationMs = Math.max(...durations);
        results.push({ method, destination, rows, width, summary, runs });
        process.stderr.write(
          `${rows.toLocaleString()} rows, width ${width}, ${destination}, ${method}: ${summary.durationMs.toFixed(1)} ms median; RSS ${summary.peakRssMiB?.toFixed(1) ?? "not measured"} MiB\n`,
        );
      }
    }
    await unlink(dbPath);
  }
  const driverPackage = JSON.parse(
    await readFile(
      join(root, "node_modules", "better-sqlite3", "package.json"),
      "utf8",
    ),
  );
  const report = {
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: platform(),
      release: release(),
      architecture: arch(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryGiB: totalmem() / 2 ** 30,
      driver: driverPackage.version,
      sqlite: sqliteVersion,
      sqliteCli: cliProbe.status === 0 ? cliProbe.stdout.trim() : null,
    },
    configuration: {
      counts,
      width,
      repeats,
      warmups,
      destinations,
      methods,
      outputBufferBytes: 65_536,
      internalTableBatchRows: 256,
      yieldEveryRows: 2048,
    },
    verification:
      "All implementations matched a 257-row parsed JSON fixture before timing.",
    notes: [
      "No runtime SQLite CLI dependency; CLI is an optional benchmark baseline only.",
      "Each run uses a fresh Node process. Warmup processes prewarm OS caches, not the JIT of measured processes.",
      "Duration excludes process/driver startup and fixture creation; includes export planning and destination completion. CLI includes subprocess startup.",
      "File destination uses local temporary storage and awaits writes, without fsync. OS caches affect these results.",
      "null destination discards bytes and never retains the export. It still samples memory at each write callback.",
      "Peak RSS is absolute process high-water RSS, including startup. Heap is sampled every 5 ms, at flush callbacks and after naive allocations; it is a lower bound.",
      "CLI child memory/GC/event-loop delay are not instrumented, so those values are null.",
      "Time to first record is when the sink's completed callbacks cover the first complete record, including batching latency.",
      "Event-loop delay is maximum lateness of a 1 ms interval (including the initial synchronous operation); OS scheduling makes short runs noisy. GC observations are runtime telemetry, not a complete allocation profile.",
      "CLI JSON uses different whitespace; decoded records are equivalent. MiB/s uses each implementation's actual byte count.",
      "sqlite-aggregate builds one full json_group_array(json_object(...)) value with count(*) for export statistics; its fixture table scan matches ExportLite's scan order, without a general ordering guarantee.",
      "exportlite uses fixed internal 256-row batches, one recursive export statement, and indexed rowid ranges. exportlite-query uses the public row-streaming query path. No custom SQL callback or extra connection is used.",
      "Batching bounds rows, not bytes or process RAM. Query/views/virtual/WITHOUT ROWID/shadowed-rowid fallbacks are covered by integration tests; these timed fixtures are ordinary rowid tables.",
    ],
    skipped,
    results,
  };
  const out = resolve(
    root,
    options.out ?? `benchmarks/results/width-${width}.json`,
  );
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`Saved ${out}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
