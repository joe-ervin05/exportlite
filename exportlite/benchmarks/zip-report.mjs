import { readFile, writeFile } from "node:fs/promises";

const load = async (name) =>
  JSON.parse(
    await readFile(new URL(`./results/${name}.json`, import.meta.url), "utf8"),
  );
const reports = [await load("zip-narrow"), await load("zip-wide")];
const zip64 = await load("zip64-validation");
const mib = (n) => (n / 1_048_576).toFixed(2);
const secs = (n) => (n / 1000).toFixed(3);
const find = (report, method, compression) =>
  report.results.find(
    (r) => r.method === method && r.compression === compression,
  ).summary;
const comparison = (report) => {
  const a = find(report, "exportlite", "zip");
  const b = find(report, "object-stream", "zip");
  const difference = ((b.durationMs - a.durationMs) / b.durationMs) * 100;
  return `ExportLite took ${secs(a.durationMs)} s versus ${secs(b.durationMs)} s for JS object streaming (${Math.abs(difference).toFixed(1)}% ${difference >= 0 ? "less" : "more"} time). Both ZIP files were ${mib(a.bytes)} MiB. ExportLite's median peak RSS was ${a.peakRssMiB.toFixed(1)} MiB versus ${b.peakRssMiB.toFixed(1)} MiB.`;
};
const environment = reports[0].environment;
let text = `# Actual streaming ZIP exports

These runs compare the public \`exportTable(..., { zip: true })\` option with a JS object iterator plus \`JSON.stringify()\` and an equivalent streaming ZIP writer. Uncompressed exports provide a reference. ZIP contains one \`data.json\` entry; both implementations use zip-stream ${environment.zipStream}, DEFLATE level 1, a 256 KiB zlib output buffer, ZIP64, and the same fixed timestamp. The package retains its internal 256-row SQLite JSON batches.

For the smaller records, ${comparison(reports[0])}

For the larger records, ${comparison(reports[1])}

## Measurements

Median of five measured fresh-process runs after one warmup process per case. Cases rotate order and run sequentially. Total time includes planning, serialization, compression, CRC-32, archive finalization, all destination callbacks and local file close. Fixture creation, process/driver startup and independent validation are outside timing. File writes do not use fsync. OS caches affect the results.

| Dataset | Exporter | Output | Total seconds (min–max) | File MiB | Peak RSS MiB | Sampled heap MiB |
| --- | --- | --- | ---: | ---: | ---: | ---: |
`;
for (const report of reports) {
  const label =
    report.configuration.width === 32
      ? "1m smaller records"
      : "100k larger records";
  for (const result of report.results) {
    const s = result.summary;
    text += `| ${label} | ${result.method === "exportlite" ? "ExportLite" : "JS objects"} | ${result.compression === "zip" ? "ZIP" : "JSON"} | ${secs(s.durationMs)} (${secs(s.minDurationMs)}–${secs(s.maxDurationMs)}) | ${mib(s.bytes)} | ${s.peakRssMiB.toFixed(1)} | ${s.sampledPeakHeapMiB.toFixed(1)} |\n`;
  }
}
text += `
Peak RSS is each fresh process's absolute high-water memory, including startup, database cache, strings and native compression buffers. The table reports the median of those high-water values. Sampled JS heap is a lower bound and excludes native memory. Both exporters load the same benchmark dependencies. Streaming avoids retaining the complete export; 256 rows and the compression buffer are not global RAM limits.

## Data and verification

Both datasets use the same seeded varied-data generator as the earlier compression investigation: international names, distinct references, dates, amounts, NULLs and support notes. Seed: 20261017. They remain synthetic business data with recurring categories/templates, not a production corpus or random binary data.

| Rows | Raw JSON MiB | ZIP reduction | Non-null note mean / p95 / max (UTF-8 bytes) | Distinct non-null notes |
| ---: | ---: | ---: | --- | ---: |
`;
for (const report of reports) {
  const fixture = report.fixtures[0];
  const s = find(report, "exportlite", "zip");
  const note = fixture.noteUtf8Bytes;
  text += `| ${fixture.rows.toLocaleString("en-US")} | ${mib(s.rawBytes)} | ${(100 * (1 - s.bytes / s.rawBytes)).toFixed(1)}% | ${note.mean.toFixed(1)} / ${note.p95} / ${note.max} | ${fixture.distinctNonNullNotes.toLocaleString("en-US")} |\n`;
}
text += `
Before timing, all four cases matched a parsed 257-row fixture. Every warmup and measured ZIP was independently decoded with yauzl, its full CRC-32 and uncompressed size checked, and its decoded SHA-256 compared with the uncompressed exports. Actual encoded file sizes matched the measured byte counts. The public option's \`bytesWritten\` was also checked against the counted destination bytes. For the package ZIP path, raw JSON byte count is computed by an untimed fixture scan; no measuring transform is inserted into its internal JSON stream.

The separate large-entry check streamed **${zip64.decoded.bytes.toLocaleString("en-US")} decoded bytes** into a ${mib(zip64.result.bytesWritten)} MiB ZIP, then read the entire entry through yauzl with matching CRC-32 and sizes. Its central directory requires ZIP version ${zip64.decoded.entry.versionNeededToExtract / 10}. Combined export-and-validation peak RSS was ${zip64.peakRssMiB.toFixed(1)} MiB. This deliberately compressible fixture tests the 4 GiB entry boundary; it is not evidence of typical compression ratios. A compressed archive itself larger than 4 GiB and every desktop extractor have not been tested.

The package tests cover JSON/JSONL boundaries, empty entries, query/table fallbacks, parameter binding, exact integer literals, backpressure, cancellation, stream ownership, write/close/finalization/footer failures, cleanup and WAL snapshots. No extra export query or adaptive sizing was added.

## Interpretation and limits

ZIP is a convenience around the existing exporter. Compression and ZIP checksums add work to both methods, so serialization savings do not translate directly into the same total-time advantage. The ZIP writer's CRC-32 calculation runs in JavaScript; native DEFLATE compression runs asynchronously. A faster uncompressed export can still finish near the JS baseline once compression dominates. These measurements apply to the tested machine, schema, data and settings.

The package's tuned compression settings are fixed internally. Level 1 favors speed over the smaller files potentially available at higher levels. The 256 KiB setting is the compressor's output buffer; it is separate from the exporter’s UTF-8 flush target. No per-batch archive, compressor reset or flush is used. JS object streaming receives the same tuning.

These are local file exports. Network transfer, concurrent exports, slow clients, client decompression and server CPU contention are not timed. Slower downloads can make the smaller ZIP more useful even when local export time increases. Queries/views and other streaming fallbacks are tested for correctness but are outside these timing tables.

Environment: ${environment.cpu}; ${environment.platform} ${environment.architecture}; Node ${environment.node}; better-sqlite3 ${environment.driver}; SQLite ${environment.sqlite}; zlib ${environment.zlib}. Dependency versions were checked October 17, 2026. Cross-version CI has not been run.

## Reproduce

Build first, then run sequentially:

\`\`\`sh
pnpm build
node benchmarks/run.mjs --rows=1000000 --width=32 --profile=varied --seed=20261017 --repeats=5 --warmups=1 --methods=exportlite,object-stream --compressions=none,zip --destinations=file --out=benchmarks/results/zip-narrow.json
node benchmarks/run.mjs --rows=100000 --width=1024 --profile=varied --seed=20261017 --repeats=5 --warmups=1 --methods=exportlite,object-stream --compressions=none,zip --destinations=file --out=benchmarks/results/zip-wide.json
node benchmarks/validate-zip64.mjs
node benchmarks/zip-report.mjs
\`\`\`

Raw runs: [smaller records](results/zip-narrow.json), [larger records](results/zip-wide.json), [actual ZIP64 entry validation](results/zip64-validation.json).
`;
await writeFile(new URL("./ZIP.md", import.meta.url), text);
