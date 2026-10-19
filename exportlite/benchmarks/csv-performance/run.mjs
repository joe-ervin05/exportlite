import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFixtures } from "./fixtures.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const median = (a) => [...a].sort((a, b) => a - b)[Math.floor(a.length / 2)];
const hash = (b) => createHash("sha256").update(b).digest("hex");
const directory =
  process.env.CSV_BENCH_DIR ?? join(root, "outputs/csv-performance");
const fixtures = (await createFixtures(join(directory, "fixtures"))).filter(
  (f) =>
    !process.env.BENCH_FIXTURES ||
    process.env.BENCH_FIXTURES.split(",").includes(f.name),
);
assert(fixtures.length, "No matching CSV fixtures");
const rounds = Number(process.env.BENCH_ROUNDS ?? 5);
assert(Number.isInteger(rounds) && rounds > 0);
const output = process.env.BENCH_OUT ?? join(directory, "comparison");
await mkdir(output, { recursive: true });
const builds = {
  after: process.env.EXPORTLITE_AFTER ?? `${root}exportlite/dist`,
};
if (process.env.EXPORTLITE_BEFORE)
  builds.before = resolve(process.env.EXPORTLITE_BEFORE);
const cases = builds.before
  ? [
      ["before", "table"],
      ["after", "table"],
      ["before", "query"],
      ["after", "query"],
      ["control", "manual-tuned"],
    ]
  : [
      ["after", "table"],
      ["after", "query"],
      ["control", "manual-tuned"],
    ];
const all = [];
for (let round = 0; round < rounds; round++) {
  const order = [
    ...cases.slice(round % cases.length),
    ...cases.slice(0, round % cases.length),
  ];
  for (const f of fixtures)
    for (const compression of ["none", "zip"])
      for (const [variant, method] of order) {
        const c = spawnSync(
          process.execPath,
          [
            fileURLToPath(new URL("./worker.mjs", import.meta.url)),
            "worker",
            JSON.stringify(f),
            method,
            compression,
          ],
          {
            encoding: "utf8",
            maxBuffer: 1e6,
            env: {
              ...process.env,
              EXPORTLITE_BUILD: builds[variant] ?? builds.after,
            },
          },
        );
        assert.equal(c.status, 0, c.stderr);
        const row = { round, variant, ...JSON.parse(c.stdout) };
        assert(
          Number.isFinite(row.medianMs),
          "Single-export diagnostics do not produce benchmark timings.",
        );
        if (compression === "none") {
          assert.equal(row.sha256, f.csvSha256);
          assert.equal(row.bytes, f.bytes);
        }
        all.push(row);
      }
  await writeFile(`${output}/all.json`, `${JSON.stringify(all, null, 2)}\n`);
  console.error(`Finished deep CSV round ${round + 1}/${rounds}.`);
}
const summary = [];
for (const f of fixtures)
  for (const compression of ["none", "zip"]) {
    const group = all.filter(
      (r) => r.fixture === f.name && r.compression === compression,
    );
    assert.equal(
      new Set(
        group
          .filter((r) => compression === "none" || r.method !== "query")
          .map((r) => r.sha256),
      ).size,
      1,
    );
    assert.equal(
      new Set(group.filter((r) => r.method === "query").map((r) => r.sha256))
        .size,
      1,
    );
    for (const [variant, method] of cases) {
      const rows = group.filter(
        (r) => r.variant === variant && r.method === method,
      );
      summary.push({
        fixture: f.name,
        compression,
        variant,
        method,
        medianMs: median(rows.map((r) => r.medianMs)),
        minMs: Math.min(...rows.map((r) => r.medianMs)),
        maxMs: Math.max(...rows.map((r) => r.medianMs)),
        medianCpuMs: median(rows.map((r) => r.medianCpuMs)),
        medianPeakRssMiB: median(rows.map((r) => r.peakRssMiB)),
        maxPeakRssMiB: Math.max(...rows.map((r) => r.peakRssMiB)),
        medianSetupRssMiB: median(rows.map((r) => r.setupMemory.rss / 1048576)),
        medianSetupPeakRssMiB: median(rows.map((r) => r.setupPeakRssMiB)),
        bytes: rows[0].bytes,
        sha256: rows[0].sha256,
      });
    }
  }
const buildHashes = {};
for (const [variant, path] of Object.entries(builds)) {
  buildHashes[variant] = {};
  for (const file of (await readdir(path))
    .filter((n) => n.endsWith(".mjs"))
    .sort())
    buildHashes[variant][file] = hash(await readFile(join(path, file)));
}
await writeFile(
  `${output}/summary.json`,
  `${JSON.stringify(summary, null, 2)}\n`,
);
await writeFile(
  `${output}/configuration.json`,
  `${JSON.stringify({ node: process.version, nodeSha256: hash(await readFile(process.execPath)), cpu: cpus()[0]?.model, beforeSourceCommit: process.env.BEFORE_COMMIT ?? null, rounds, cases, packageFormat: process.env.CSV_BENCH_PACKAGE_FORMAT ?? "esm", drizzleModules: process.env.CSV_BENCH_DRIZZLE_MODULES ?? process.env.CSV_BENCH_PACKAGE_FORMAT ?? "esm", drizzleSetup: process.env.CSV_BENCH_DRIZZLE_SETUP ?? "matched", fixtures: fixtures.map(({ path, ...f }) => f), builds: buildHashes, protocol: "Sequential fresh workers, rotating case order. One output verification, two warmups, three timed batches; two exports per bulk batch, 50 tiny. Natural GC, no profiling/forced GC. Counting Node writable; planning, generation, encoding/ZIP and completion included; imports/connection excluded from time. Peak RSS is whole-process including imports/warmups/repeated exports. Fixed 256-row SQL batches, 64 KiB writer and yields every 2048 rows. ZIP level 1, memLevel 9, 256 KiB compression output chunks. Each package build uses its own ZIP/checksum implementation; manual JS uses the installed zip-stream. Plain bytes independently match csv-stringify and parse to original fixture values. All before/after and same-name manual archive hashes match. JSON-mode initializes the same Drizzle driver/schema for package and manual workers; manual JS still reads driver rows directly and parses/stringifies JSON to match native canonical cells. ESM is the default for both package and schema imports. Pre-export setup RSS and its high-water mark are recorded separately. CPU usage includes process threads." }, null, 2)}\n`,
);
console.log(JSON.stringify({ workers: all.length, cases: summary.length }));
