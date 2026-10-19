import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const directory = "benchmarks/results/remaining-gap";
const all = JSON.parse(readFileSync(`${directory}/all.json`, "utf8"));
assert.equal(all.length, 120);
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const groups = [];
for (const dataset of ["matched", "narrow", "wide"]) {
  for (const mode of ["output", "sql", "web", "zip", "rows"]) {
    for (const method of ["before", "after", "full", "full-blob"]) {
      const rows = all.filter(
        (row) =>
          row.dataset === dataset && row.mode === mode && row.method === method,
      );
      if (!rows.length) continue;
      assert.equal(new Set(rows.map((row) => row.verification.sha256)).size, 1);
      const times = rows.map((row) => row.median.totalMs);
      const representative = [...rows].sort(
        (a, b) => a.median.totalMs - b.median.totalMs,
      )[Math.floor(rows.length / 2)].median;
      groups.push({
        dataset,
        mode,
        method,
        workers: rows.length,
        totalMs: median(times),
        minMs: Math.min(...times),
        maxMs: Math.max(...times),
        encodingMs: ["output", "rows"].includes(mode)
          ? representative.encodingMs
          : null,
        generationMs: ["output", "rows"].includes(mode)
          ? representative.totalMs - representative.encodingMs
          : null,
        peakRssMiB: median(rows.map((row) => row.peakRssMiB)),
        peakRssRangeMiB: [
          Math.min(...rows.map((row) => row.peakRssMiB)),
          Math.max(...rows.map((row) => row.peakRssMiB)),
        ],
        bytes: rows[0].verification.bytes,
        sha256: rows[0].verification.sha256,
      });
    }
  }
}
for (const dataset of ["narrow", "wide"]) {
  const zip = groups.filter(
    (row) => row.dataset === dataset && row.mode === "zip",
  );
  assert.equal(
    zip[0].sha256,
    zip[1].sha256,
    "ZIP archives must be byte-identical",
  );
}
writeFileSync(
  `${directory}/summary.json`,
  `${JSON.stringify(groups, null, 2)}\n`,
);
const columns = Object.keys(groups[0]).filter(
  (key) => key !== "peakRssRangeMiB",
);
writeFileSync(
  `${directory}/summary.csv`,
  `${columns.join(",")}\n${groups.map((row) => columns.map((key) => row[key]).join(",")).join("\n")}\n`,
);
for (const row of groups)
  console.log(
    `${row.dataset.padEnd(7)} ${row.mode.padEnd(6)} ${row.method.padEnd(6)} ${row.totalMs.toFixed(2)} ms (${row.minMs.toFixed(2)}–${row.maxMs.toFixed(2)}), RSS ${row.peakRssMiB.toFixed(1)} MiB`,
  );
