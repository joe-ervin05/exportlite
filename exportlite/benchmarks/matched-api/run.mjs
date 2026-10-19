import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureFixture } from "./reference/setup.mjs";
import { validateStreamingEdges } from "./validate.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.replace(/^--/, "").split("=");
    return [key, value.join("=")];
  }),
);
assert.equal(
  process.version,
  "v26.12.0",
  "Use the same Node 26.12.0 as the original chart",
);
const sizes = (options.sizes ?? "1,10,100,1000,10000,100000,1000000")
  .split(",")
  .map(Number);
const depths = (options.depths ?? "0,1,2").split(",").map(Number);
const repeats = Number(options.repeats ?? 3);
assert(
  sizes.every((n) => [1, 10, 100, 1000, 10000, 100000, 1000000].includes(n)),
);
assert(depths.every((n) => [0, 1, 2].includes(n)));
assert(Number.isInteger(repeats) && repeats > 0);
const out = resolve(options.out ?? join(root, "../results/matched-api"));
const database = resolve(options.db ?? join(root, "work/fixture.db"));
await mkdir(out, { recursive: true });
await mkdir(join(out, "raw"), { recursive: true });
const fixture = ensureFixture(database);
await validateStreamingEdges();
const hash = createHash("sha256");
for await (const chunk of createReadStream(database)) hash.update(chunk);
const sources = {};
for (const name of [
  "worker.mjs",
  "run.mjs",
  "engine-entry.ts",
  "root-sql.mjs",
  "validate.mjs",
  "build/engine-entry.mjs",
  "reference/queries.mjs",
  "reference/schema.mjs",
  "reference/summary.json",
  "../../dist/index.mjs",
])
  sources[name] = createHash("sha256")
    .update(await readFile(join(root, name)))
    .digest("hex");
const config = {
  sizes,
  depths,
  repeats,
  fixture,
  fixtureSha256: hash.digest("hex"),
  node: process.version,
  sources,
  versionsChecked: {
    date: "2026-10-17",
    betterSqlite3: "13.0.3",
    drizzle: "0.45.4",
    zipStream: "7.0.5",
  },
  description:
    "Original seven-million-record fixture; prepared queries; JSON generation and UTF-8 response-body encoding, without network/compression/file output",
};
const fingerprint = createHash("sha256")
  .update(JSON.stringify(config))
  .digest("hex");
await writeFile(
  join(out, "configuration.json"),
  `${JSON.stringify({ ...config, fingerprint }, null, 2)}\n`,
);
const methods = ["sqlite", "exportlite", "manual", "drizzle"];
const jobs = [];
for (const roots of [...sizes].reverse())
  for (const depth of [...depths].reverse()) {
    const selected = [...methods];
    if (roots === 1_000_000) selected.push("exportlite-rows");
    if (roots === 1_000_000 && depth === 0)
      selected.push("public-table-256", "public-web-table");
    for (let repeat = 0; repeat < repeats; repeat++)
      for (let index = 0; index < selected.length; index++)
        jobs.push({
          roots,
          depth,
          repeat: repeat + 1,
          method: selected[(index + repeat) % selected.length],
        });
  }
const results = [];
const started = performance.now();
for (const job of jobs) {
  const filename = join(
    out,
    "raw",
    `n${job.roots}-d${job.depth}-${job.method}-r${job.repeat}.json`,
  );
  const existing =
    options.resume === "1" &&
    (await stat(filename).then(
      () => true,
      () => false,
    ));
  if (!existing) {
    await new Promise((accept, reject) => {
      const child = spawn(
        process.execPath,
        [
          join(root, "worker.mjs"),
          `--db=${database}`,
          `--roots=${job.roots}`,
          `--depth=${job.depth}`,
          `--method=${job.method}`,
          `--out=${filename}`,
          `--fingerprint=${fingerprint}`,
        ],
        {
          stdio: "inherit",
          timeout: 600_000,
        },
      );
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        code === 0
          ? accept()
          : reject(
              new Error(
                `Worker failed: ${JSON.stringify(job)} (${signal ?? code})`,
              ),
            ),
      );
    });
  }
  const result = JSON.parse(await readFile(filename, "utf8"));
  assert.equal(
    result.fingerprint,
    fingerprint,
    "Do not mix runs from different sources/configurations",
  );
  assert.equal(result.environment.node, process.version);
  results.push({ ...result, repeat: job.repeat });
  await writeFile(
    join(out, "progress.json"),
    `${JSON.stringify({ completed: results.length, total: jobs.length, elapsedSeconds: (performance.now() - started) / 1000, last: job }, null, 2)}\n`,
  );
  console.log(
    `${results.length}/${jobs.length} n=${job.roots} depth=${job.depth} ${job.method} r${job.repeat}: ${result.totalMs.toFixed(3)} ms`,
  );
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}
const cases = [];
for (const roots of sizes)
  for (const depth of depths) {
    const selected = results.filter(
      (r) => r.roots === roots && r.depth === depth,
    );
    assert.equal(new Set(selected.map((r) => r.sha256)).size, 1);
    assert.equal(new Set(selected.map((r) => r.bytes)).size, 1);
    const methods = {};
    for (const method of new Set(selected.map((r) => r.method))) {
      const rows = selected.filter((r) => r.method === method);
      const ordered = [...rows].sort((a, b) => a.totalMs - b.totalMs);
      const middle = Math.floor(ordered.length / 2);
      const paired =
        ordered.length % 2
          ? [ordered[middle]]
          : [ordered[middle - 1], ordered[middle]];
      methods[method] = {
        totalMs: median(rows.map((r) => r.totalMs)),
        generationMs:
          method === "public-web-table"
            ? null
            : paired.reduce((sum, row) => sum + row.generationMs, 0) /
              paired.length,
        encodingMs:
          method === "public-web-table"
            ? null
            : paired.reduce((sum, row) => sum + row.encodingMs, 0) /
              paired.length,
        minMs: Math.min(...rows.map((r) => r.totalMs)),
        maxMs: Math.max(...rows.map((r) => r.totalMs)),
        peakRssMiB: median(rows.map((r) => r.peakRssMiB)),
        processes: rows.length,
      };
    }
    cases.push({
      roots,
      depth,
      totalRecords: selected[0].totalRecords,
      bytes: selected[0].bytes,
      sha256: selected[0].sha256,
      methods,
    });
  }
const summary = {
  configuration: config,
  fingerprint,
  environment: results[0].environment,
  workers: results.length,
  cases,
};
await writeFile(
  join(out, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
const columns = [
  "roots",
  "depth",
  "totalRecords",
  "bytes",
  "method",
  "generationMs",
  "encodingMs",
  "totalMs",
  "minMs",
  "maxMs",
  "peakRssMiB",
  "processes",
];
const csv = [columns.join(",")];
for (const row of cases)
  for (const [method, stats] of Object.entries(row.methods)) {
    const record = { ...row, method, ...stats };
    csv.push(columns.map((key) => record[key] ?? "").join(","));
  }
await writeFile(join(out, "results.csv"), `${csv.join("\n")}\n`);
console.log(
  `Complete: ${cases.length} cases, ${results.length} fresh workers; all outputs match the original SHA-256 digests.`,
);
