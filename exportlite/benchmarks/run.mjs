import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip, gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { createFixture } from "./fixture.mjs";
import { readZip } from "./read-zip.mjs";

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
      "compressions",
      "profile",
      "seed",
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
const profile = options.profile ?? "repeated";
if (!["repeated", "varied"].includes(profile))
  throw new Error("profile must be repeated or varied");
const seed = integer(options.seed ?? "20261017", "seed", 0);
if (seed > 4_294_967_295)
  throw new Error("seed must fit an unsigned 32-bit integer");
const repeats = integer(options.repeats ?? "3", "repeats");
const warmups = integer(options.warmups ?? "1", "warmups", 0);
const compressions = (options.compressions ?? "none").split(",");
if (
  compressions.some(
    (c) => !["none", "gzip-1", "gzip-default", "zip"].includes(c),
  )
)
  throw new Error(
    "compressions must contain none, gzip-1, gzip-default or zip",
  );
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
        "exportlite-before",
        "exportlite-gzip-512k",
        "object-stream-gzip-512k",
        "exportlite-gzip-slab64k",
        "object-stream-gzip-slab64k",
        "exportlite-gzip-slab256k",
        "object-stream-gzip-slab256k",
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
  return createFixture(path, rows, { width, profile, seed });
}
async function execute(
  method,
  dbPath,
  destination,
  firstRecordBytes,
  compression,
  expectedJsonBytes,
) {
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
      compression,
      String(expectedJsonBytes),
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
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${method} failed (${code}): ${stderr}`)),
    );
  });
  return { metrics: JSON.parse(stdout), outputPath };
}
// Validate completed large files outside the timed worker, without loading the
// full JSON into memory. Gunzip also verifies each compressed stream's trailer.
async function fingerprint(path, compression, method) {
  if (compression === "zip") {
    const { sha256, bytes } = await readZip(path, {
      name: method === "exportlite-query" ? "export.json" : "data.json",
    });
    return { sha256, bytes };
  }
  const hash = createHash("sha256");
  let bytes = 0;
  const stages = [createReadStream(path)];
  if (compression !== "none") stages.push(createGunzip());
  stages.push(
    new Writable({
      write(chunk, _encoding, callback) {
        bytes += chunk.length;
        hash.update(chunk);
        callback();
      },
    }),
  );
  await pipeline(stages);
  return { sha256: hash.digest("hex"), bytes };
}
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[half]
    : (sorted[half - 1] + sorted[half]) / 2;
};
const results = [];
const fixtures = [];
const cases = compressions.flatMap((compression) =>
  methods.map((method) => ({ method, compression })),
);
let sqliteVersion;
try {
  // Check semantic equivalence outside the timed runs, without retaining large exports.
  const verifyPath = join(temporary, "verify.sqlite");
  const verify = fixture(verifyPath, 257);
  const expectedDb = new Database(verifyPath, { readonly: true });
  const expected = expectedDb.prepare("SELECT * FROM data ORDER BY id").all();
  expectedDb.close();
  for (const { method, compression } of cases) {
    const { outputPath } = await execute(
      method,
      verifyPath,
      "file",
      verify.firstRecordBytes,
      compression,
      verify.expectedJsonBytes,
    );
    const encoded = await readFile(outputPath);
    assert.deepEqual(
      compression === "zip"
        ? JSON.parse(
            (
              await readZip(outputPath, {
                name:
                  method === "exportlite-query" ? "export.json" : "data.json",
                collect: true,
              })
            ).text,
          )
        : JSON.parse(
            (compression === "none" ? encoded : gunzipSync(encoded)).toString(
              "utf8",
            ),
          ),
      expected,
      `${method}/${compression}: output differs`,
    );
    await unlink(outputPath);
  }
  process.stderr.write(
    `Verified equivalent JSON from ${cases.length} method/compression combinations.\n`,
  );
  for (const rows of counts) {
    const dbPath = join(temporary, `${rows}.sqlite`);
    const info = fixture(dbPath, rows);
    fixtures.push({ rows, width, ...info.statistics });
    sqliteVersion = info.sqliteVersion;
    for (const destination of destinations) {
      const byCase = cases.map((configuration) => ({
        ...configuration,
        runs: [],
      }));
      const fingerprints = new Map();
      for (let iteration = -warmups; iteration < repeats; iteration++) {
        // Rotate order to reduce consistent first/last-position bias.
        const offset = (iteration + warmups) % byCase.length;
        const ordered = [...byCase.slice(offset), ...byCase.slice(0, offset)];
        for (const configuration of ordered) {
          const { method, compression, runs } = configuration;
          const { metrics, outputPath } = await execute(
            method,
            dbPath,
            destination,
            info.firstRecordBytes,
            compression,
            info.expectedJsonBytes,
          );
          assert.equal(metrics.rows, rows);
          if (destination === "file") {
            assert.equal((await stat(outputPath)).size, metrics.bytes);
            const actual = await fingerprint(outputPath, compression, method);
            assert.equal(actual.bytes, metrics.rawBytes);
            metrics.verifiedDecodedSha256 = actual.sha256;
            // CLI whitespace can differ. All Node methods produce identical
            // compact JSON, so compare their entire decoded byte streams.
            const group = method === "sqlite-cli" ? "cli" : "node";
            if (fingerprints.has(group))
              assert.deepEqual(actual, fingerprints.get(group));
            else fingerprints.set(group, actual);
            await unlink(outputPath);
          }
          if (iteration >= 0) runs.push(metrics);
        }
      }
      for (const { method, compression, runs } of byCase) {
        const durations = runs.map((r) => r.durationMs);
        const summary = {};
        for (const key of Object.keys(runs[0])) {
          if (typeof runs[0][key] === "number")
            summary[key] = median(runs.map((r) => r[key]));
          else if (runs[0][key] === null) summary[key] = null;
        }
        summary.minDurationMs = Math.min(...durations);
        summary.maxDurationMs = Math.max(...durations);
        results.push({
          method,
          compression,
          destination,
          rows,
          width,
          summary,
          runs,
        });
        process.stderr.write(
          `${rows.toLocaleString()} rows, width ${width}, ${destination}, ${method}/${compression}: ${summary.durationMs.toFixed(1)} ms median; ${(summary.bytes / 1_048_576).toFixed(2)} MiB output; RSS ${summary.peakRssMiB?.toFixed(1) ?? "not measured"} MiB\n`,
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
      zlib: process.versions.zlib,
      zipStream: JSON.parse(
        await readFile(
          join(root, "node_modules", "zip-stream", "package.json"),
          "utf8",
        ),
      ).version,
      sqliteCli: cliProbe.status === 0 ? cliProbe.stdout.trim() : null,
    },
    configuration: {
      counts,
      width,
      profile,
      seed,
      repeats,
      warmups,
      destinations,
      methods,
      compressions,
      outputBufferBytes: 65_536,
      internalTableBatchRows: 256,
      yieldEveryRows: 2048,
    },
    verification:
      "All method/compression combinations matched a 257-row parsed JSON fixture before timing. Every completed timed file was decompressed when necessary and hashed outside the worker; decoded Node output hashes and raw byte counts matched, and encoded sizes matched filesystem sizes.",
    fixtures,
    notes: [
      "No runtime SQLite CLI dependency; CLI is an optional benchmark baseline only.",
      "Each run uses a fresh Node process. Warmup processes prewarm OS caches, not the JIT of measured processes.",
      "Duration excludes process/driver startup and fixture creation; includes export planning and destination completion. CLI includes subprocess startup.",
      "File destination uses local temporary storage and awaits writes, without fsync. OS caches affect these results.",
      "null destination discards output bytes and samples memory at write callbacks. The serializers can still retain complete row arrays or JSON strings.",
      "Peak RSS is absolute process high-water RSS, including startup. Heap is sampled every 5 ms, at flush callbacks and after naive allocations; it is a lower bound.",
      "CLI child memory/GC/event-loop delay are not instrumented, so those values are null.",
      "Time to first record is when the sink's completed callbacks cover the first complete record, including batching latency.",
      "Event-loop delay is maximum lateness of a 1 ms interval (including the initial synchronous operation); OS scheduling makes short runs noisy. GC observations are runtime telemetry, not a complete allocation profile.",
      "CLI JSON uses different whitespace; decoded records are equivalent. MiB/s uses each implementation's actual byte count.",
      "sqlite-aggregate builds one full json_group_array(json_object(...)) value with count(*) for export statistics; its fixture table scan matches ExportLite's scan order, without a general ordering guarantee.",
      "exportlite uses fixed internal 256-row batches, one recursive export statement, and indexed rowid ranges. exportlite-query uses the public row-streaming query path. No custom SQL callback or extra connection is used.",
      "Batching bounds rows, not bytes or process RAM. Query/views/virtual/WITHOUT ROWID/shadowed-rowid fallbacks are covered by integration tests; these timed fixtures are ordinary rowid tables.",
      "naive-all fetches the entire result with statement.all(), then calls JSON.stringify() once on the whole array and submits that complete string to the same destination/ZIP pipeline. Memory is also sampled immediately after all() and stringify(). Its database fetch and JSON serialization do not stream or yield; ZIP output uses the same tuned archive writer as object-stream.",
      "ZIP runs exercise ExportLite's public zip:true option. The JS baseline uses the same zip-stream version, level 1, memLevel 9, 256 KiB zlib output buffer, ZIP64, one data.json entry and fixed timestamp. CRC-32, archive finalization and destination completion are included. Every ZIP file is independently read and its full decoded CRC-32, size and SHA-256 verified outside timing.",
      "Gzip compression stays entirely in this benchmark harness. Both exporters write to the same counting Transform, optional continuous createGzip({level:1}) or createGzip(), and counted file sink. Default gzip options are otherwise unchanged; no explicit flushes or per-batch compressors are used.",
      "Duration includes output/compressor setup, compressor finalization and file close. It excludes correctness/decompression/hash checks. bytes is actual encoded file size; rawBytes is the original UTF-8 JSON size. Compressed firstRecordMs is null because compressed byte offsets do not identify decoded record boundaries.",
      profile === "repeated"
        ? "These fixtures repeat the note payload across records. Their compression ratios are optimistic for varied/high-entropy real-world text."
        : "Varied fixtures use a seeded synthetic business/support-note generator with distinct references, amounts, dates, names, addresses, variable-length text and independently placed longer notes. Templates and categories still repeat as they would in structured business data; this is not a sampled production corpus.",
      "Fixture generation, size/cardinality profiling and validation happen outside timing. Network transfer and client decompression are not timed.",
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
