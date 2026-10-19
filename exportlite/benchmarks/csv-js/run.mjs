import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFixture } from "../fixture.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const here = fileURLToPath(new URL("./", import.meta.url));
const sourceCommit = "6cedfe09ff9853116906a62426cfccc237bac0a8";
const worker = join(root, "outputs/csv/compare.mjs");
const output = process.env.BENCH_OUT ?? join(root, "outputs/csv-js/comparison");
const buildRoot =
  process.env.CSV_JS_BUILD_ROOT ?? join(root, "outputs/csv-js/projects");
const builds = {
  sqlite: join(buildRoot, "sqlite/exportlite/dist"),
  javascript: join(buildRoot, "javascript/exportlite/dist"),
};
const fixtures = [
  { name: "tiny", rows: 100, width: 32, profile: "repeated", iterations: 50 },
  { name: "narrow", rows: 50_000, width: 32, profile: "varied", iterations: 2 },
  { name: "wide", rows: 15_000, width: 1024, profile: "varied", iterations: 2 },
];
const rounds = Number(process.env.BENCH_ROUNDS ?? 5);
assert.equal(process.version, "v26.12.0");
assert(Number.isInteger(rounds) && rounds > 0);
await mkdir(output, { recursive: true });
await mkdir(join(root, "outputs/csv-js/fixtures"), { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const fixture of fixtures) {
  fixture.path = join(
    root,
    "outputs/csv-js/fixtures",
    `${fixture.name}.sqlite`,
  );
  try {
    await access(fixture.path);
  } catch {
    createFixture(fixture.path, fixture.rows, { ...fixture, seed: 20261017 });
  }
  fixture.databaseSha256 = hash(await readFile(fixture.path));
}

// Include query fallbacks as controls; the main comparison is the three table paths.
const methods = ["exportlite-table", "exportlite-query", "js-stream"];
const cases = methods.flatMap((method) =>
  (method === "js-stream" ? ["manual"] : ["sqlite", "javascript"]).map(
    (variant) => ({ method, variant }),
  ),
);
const all = [];
for (let round = 0; round < rounds; round++) {
  const order = [
    ...cases.slice(round % cases.length),
    ...cases.slice(0, round % cases.length),
  ];
  for (const fixture of fixtures) {
    for (const compression of ["none", "zip"]) {
      for (const { method, variant } of order) {
        const child = spawnSync(
          process.execPath,
          [worker, "worker", JSON.stringify(fixture), method, compression],
          {
            encoding: "utf8",
            maxBuffer: 1024 * 1024,
            env: {
              ...process.env,
              EXPORTLITE_BUILD: builds[variant] ?? builds.sqlite,
            },
          },
        );
        assert.equal(child.status, 0, child.stderr || child.error?.message);
        all.push({ round, variant, ...JSON.parse(child.stdout) });
      }
    }
  }
  await writeFile(
    join(output, "all.json"),
    `${JSON.stringify(all, null, 2)}\n`,
  );
  process.stderr.write(
    `Finished CSV JS comparison round ${round + 1}/${rounds}.\n`,
  );
}

const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = [];
for (const fixture of fixtures) {
  for (const compression of ["none", "zip"]) {
    const group = all.filter(
      (row) => row.fixture === fixture.name && row.compression === compression,
    );
    const comparable = group.filter(
      (row) => compression === "none" || row.method !== "exportlite-query",
    );
    assert.equal(new Set(comparable.map((row) => row.sha256)).size, 1);
    for (const { method, variant } of cases) {
      const rows = group.filter(
        (row) => row.method === method && row.variant === variant,
      );
      assert.equal(rows.length, rounds);
      assert.equal(new Set(rows.map((row) => row.sha256)).size, 1);
      summary.push({
        fixture: fixture.name,
        compression,
        method,
        variant,
        medianMs: median(rows.map((row) => row.medianMs)),
        minWorkerMs: Math.min(...rows.map((row) => row.medianMs)),
        maxWorkerMs: Math.max(...rows.map((row) => row.medianMs)),
        medianPeakRssMiB: median(rows.map((row) => row.peakRssMiB)),
        maxPeakRssMiB: Math.max(...rows.map((row) => row.peakRssMiB)),
        bytes: rows[0].bytes,
        sha256: rows[0].sha256,
      });
    }
    const queries = group.filter((row) => row.method === "exportlite-query");
    assert.equal(new Set(queries.map((row) => row.sha256)).size, 1);
  }
}
const buildHashes = {};
for (const [variant, directory] of Object.entries(builds)) {
  buildHashes[variant] = {};
  for (const file of (await readdir(directory))
    .filter((name) => name.endsWith(".mjs"))
    .sort())
    buildHashes[variant][file] = hash(await readFile(join(directory, file)));
}
const manifest = JSON.parse(
  await readFile(join(root, "exportlite/package.json"), "utf8"),
);
await writeFile(
  join(output, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
await writeFile(
  join(output, "configuration.json"),
  `${JSON.stringify(
    {
      node: process.version,
      nodeSha256: hash(await readFile(process.execPath)),
      cpu: cpus()[0]?.model,
      sourceCommit,
      rounds,
      methods,
      cases,
      fixtures: fixtures.map(({ path, ...rest }) => rest),
      workerSha256: hash(await readFile(worker)),
      candidatePatchSha256: hash(await readFile(join(here, "candidate.patch"))),
      builds: buildHashes,
      versions: Object.fromEntries(
        ["better-sqlite3", "zip-stream", "csv-stringify", "csv-parse"].map(
          (name) => [
            name,
            manifest.devDependencies[name] ?? manifest.dependencies[name],
          ],
        ),
      ),
      protocol:
        "Sequential fresh workers with rotating five-case order. Same immutable fixtures/seed 20261017 and unchanged CSV worker. One hash verification, two warmups, three timed batches; bulk two exports per batch, tiny 50. Natural GC, no instrumentation. Time includes planning, CSV generation, UTF-8/ZIP writes and completion to a counting Node writable; excludes connection/imports and HTTP/network. Whole-process peak RSS includes setup, verification and warmups. 64 KiB buffers, 2048-row yields; ZIP level 1, memLevel 9, 256 KiB compression output chunks. All plain outputs and table/manual ZIP bytes and hashes must match. Query ZIP matches both implementations but uses another entry name. Local native CSV candidate only; Turso remains SQLite.",
    },
    null,
    2,
  )}\n`,
);
console.log(JSON.stringify({ workers: all.length, cases: summary.length }));
