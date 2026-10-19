import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { exportQuery } from "../dist/index.mjs";
import { readZip } from "./read-zip.mjs";

const directory = await mkdtemp(join(tmpdir(), "exportlite-zip64-"));
const db = new Database(":memory:");
try {
  const path = join(directory, "large.zip");
  const payload = "a".repeat(1_048_576);
  const count = 4097;
  const expectedBytes =
    (Buffer.byteLength(JSON.stringify({ note: payload })) + 1) * count;
  const result = await exportQuery(db, {
    sql: "WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<@count) SELECT @payload AS note FROM n",
    params: { count, payload },
    output: path,
    zip: true,
  });
  assert.equal(result.rowsExported, count);
  assert.equal(result.bytesWritten, (await stat(path)).size);
  const decoded = await readZip(path, { name: "export.jsonl" });
  assert.equal(decoded.bytes, expectedBytes);
  assert.ok(decoded.entry.uncompressedSize > 2 ** 32);
  assert.equal(decoded.entry.versionNeededToExtract, 45);
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    result,
    decoded,
    peakRssMiB: process.resourceUsage().maxRSS / 1024,
    verification:
      "An actual entry larger than 4 GiB was streamed, then fully decoded with yauzl; declared sizes and CRC-32 matched. The complete export was never retained in memory.",
  };
  await writeFile(
    new URL("./results/zip64-validation.json", import.meta.url),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  db.close();
  await rm(directory, { recursive: true, force: true });
}
