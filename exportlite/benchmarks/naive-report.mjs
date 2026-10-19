import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const load = async (name) =>
  JSON.parse(
    await readFile(new URL(`./results/${name}.json`, import.meta.url), "utf8"),
  );
const reports = [await load("naive-narrow"), await load("naive-wide")];
const names = {
  exportlite: "ExportLite",
  "object-stream": "JS streaming",
  "naive-all": "Naive JS all + stringify",
};
const mib = (n) => (n / 1_048_576).toFixed(2);
const secs = (n) => (n / 1000).toFixed(3);
const find = (report, method, compression) =>
  report.results.find(
    (r) => r.method === method && r.compression === compression,
  ).summary;
for (const report of reports) {
  assert.equal(report.results.length, 6);
  assert.equal(report.configuration.profile, "varied");
  assert.equal(report.configuration.seed, 20261017);
  assert.equal(report.configuration.repeats, 5);
  assert.equal(report.configuration.warmups, 1);
  assert.deepEqual(report.configuration.methods, Object.keys(names));
  for (const compression of ["none", "zip"]) {
    const reference = find(report, "exportlite", compression);
    for (const method of Object.keys(names)) {
      const result = report.results.find(
        (r) => r.method === method && r.compression === compression,
      );
      assert.equal(result.runs.length, 5);
      assert.equal(result.summary.bytes, reference.bytes);
      for (const run of result.runs)
        assert.equal(
          run.verifiedDecodedSha256,
          result.runs[0].verifiedDecodedSha256,
        );
    }
  }
  assert.equal(
    new Set(
      report.results.flatMap((r) =>
        r.runs.map((run) => run.verifiedDecodedSha256),
      ),
    ).size,
    1,
  );
}
let text = `# ExportLite versus naive JavaScript exports

This comparison adds the common implementation that loads every SQLite row into a JS array and serializes the entire array at once:

\`\`\`js
const rows = db.prepare(sql).all();
const json = JSON.stringify(rows);
await writeFile("export.json", json);
\`\`\`

The measured \`naive-all\` method performs those same fetch and serialization steps, then passes the complete JSON string through the counted destination used by the other methods. For ZIP, that complete string goes to the same tuned ZIP writer: zip-stream ${reports[0].environment.zipStream}, DEFLATE level 1, a 256 KiB zlib output buffer, one \`data.json\` entry and ZIP64. Its row fetching and JSON serialization hold the whole result in memory; archive bytes are written directly to the destination.

ExportLite and JS object streaming are rerun alongside it, with identical fixtures, file-completion rules and ZIP settings. ExportLite uses its public \`exportTable()\` API and \`zip: true\` option. JS streaming uses \`iterate()\` plus per-row \`JSON.stringify()\` and a 64 KiB flush target. ExportLite retains its fixed 256-row SQLite JSON batches. The package implementation and API are unchanged.

## Results

Median of five fresh-process measured runs after one warmup per case, with rotating order. Total time includes database fetching, JSON serialization, output setup, compression and checksums when enabled, ZIP finalization, destination callbacks and file close. Process/module startup, fixture creation and independent output validation are excluded. The local filesystem is cached and writes do not use fsync.

| Dataset | Exporter | Output | Total seconds (min–max) | File MiB | Peak RSS MiB | Sampled heap MiB |
| --- | --- | --- | ---: | ---: | ---: | ---: |
`;
for (const report of reports) {
  const label =
    report.configuration.width === 32
      ? "1m smaller records"
      : "100k larger records";
  for (const compression of ["none", "zip"]) {
    for (const method of Object.keys(names)) {
      const s = find(report, method, compression);
      text += `| ${label} | ${names[method]} | ${compression === "zip" ? "ZIP" : "JSON"} | ${secs(s.durationMs)} (${secs(s.minDurationMs)}–${secs(s.maxDurationMs)}) | ${mib(s.bytes)} | ${s.peakRssMiB.toFixed(1)} | ${s.sampledPeakHeapMiB.toFixed(1)} |\n`;
    }
  }
}
text += `
Peak RSS is the median of the absolute process high-water memory for the five runs, including Node, loaded modules, SQLite cache, JS allocations and native buffers. Sampled heap is a lower bound on JS heap, sampled at flushes, every 5 ms and immediately after the naive method's full array and JSON string allocations. It excludes native memory. All methods load the same benchmark dependencies. The measurements reflect these datasets and machine; none of the streaming buffer settings is a process-wide RAM cap.

## What changed relative to naive JS

`;
for (const report of reports) {
  const label =
    report.configuration.width === 32
      ? "1m smaller records"
      : "100k larger records";
  for (const compression of ["none", "zip"]) {
    const e = find(report, "exportlite", compression);
    const n = find(report, "naive-all", compression);
    const timeDifference = 100 * (1 - e.durationMs / n.durationMs);
    const memoryDifference = 100 * (1 - e.peakRssMiB / n.peakRssMiB);
    text += `- **${label}, ${compression === "zip" ? "ZIP" : "plain JSON"}:** ExportLite took ${secs(e.durationMs)} versus ${secs(n.durationMs)} seconds (${Math.abs(timeDifference).toFixed(1)}% ${timeDifference >= 0 ? "less" : "more"} time) and used ${Math.abs(memoryDifference).toFixed(1)}% ${memoryDifference >= 0 ? "less" : "more"} peak RSS (${e.peakRssMiB.toFixed(1)} versus ${n.peakRssMiB.toFixed(1)} MiB).\n`;
  }
}
text += `
The naive method can be faster than per-row JS streaming despite using much more memory. Its single native \`all()\` call and one \`JSON.stringify()\` call avoid the per-record serialization calls, JS loop and repeated output buffering of the JS streaming baseline. The results above measure the combined outcome rather than attributing time to each step. Streaming's memory benefit is separate from whether it wins on total time.

The naive path completes \`all()\` and then \`JSON.stringify()\` before it starts writing JSON. Streaming begins writing while rows are still being fetched. Streaming ZIP can also overlap fetching/serialization with asynchronous compression; the naive path supplies its full JSON string after those stages have finished. The timing includes UTF-8 conversion of that string when it is written. These are differences in how the implementations run; the benchmark does not separately attribute their individual costs.

The comparison uses the same ZIP implementation rather than comparing compression libraries. It therefore measures the cost of fetching and serializing everything at once, including the resulting memory pressure, while keeping ZIP settings aligned. All methods produced identical JSON bytes and identical ZIP file sizes for these fixtures.

## Data, validation and limits

The seeded varied fixtures are the same shapes as the previous ZIP runs: international names, distinct references, amounts, dates, NULLs, variable-length support notes and occasional longer notes. Seed: 20261017. They are synthetic business records with recurring templates/categories. Exact distributions, samples, environments and every measured run are saved in the raw results.

All six method/output combinations matched a parsed 257-row fixture before timing. Every completed warmup and measured file was hashed outside the timed process. ZIP files were fully decoded with an independent reader, with CRC-32 and declared sizes checked. Decoded SHA-256 hashes matched across all methods and both output modes. Measured encoded sizes matched the filesystem. No large JSON array was loaded by the validation process.

These are local file exports, not network downloads. Client transfer/decompression, concurrent requests and other schemas may change the tradeoffs. Rowid table exports are timed; the package's query/view/virtual/WITHOUT ROWID fallbacks are outside this timing comparison.

Environment: ${reports[0].environment.cpu}; ${reports[0].environment.platform} ${reports[0].environment.architecture}; Node ${reports[0].environment.node}; better-sqlite3 ${reports[0].environment.driver}; SQLite ${reports[0].environment.sqlite}; zip-stream ${reports[0].environment.zipStream}. Package versions were checked October 17, 2026.

## Reproduce

Run sequentially after building:

\`\`\`sh
pnpm build
node benchmarks/run.mjs --rows=1000000 --width=32 --profile=varied --seed=20261017 --repeats=5 --warmups=1 --methods=exportlite,object-stream,naive-all --compressions=none,zip --destinations=file --out=benchmarks/results/naive-narrow.json
node benchmarks/run.mjs --rows=100000 --width=1024 --profile=varied --seed=20261017 --repeats=5 --warmups=1 --methods=exportlite,object-stream,naive-all --compressions=none,zip --destinations=file --out=benchmarks/results/naive-wide.json
node benchmarks/naive-report.mjs
\`\`\`

Raw runs: [smaller records](results/naive-narrow.json), [larger records](results/naive-wide.json). [Earlier ZIP-only comparison](ZIP.md).
`;
await writeFile(new URL("./NAIVE.md", import.meta.url), text);
