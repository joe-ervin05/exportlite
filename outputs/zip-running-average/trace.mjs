import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

// Untimed diagnostics only. Keep these counters outside throughput/RSS workers.
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(`${root}exportlite/benchmarks/matched-api/package.json`);
const Database = require('better-sqlite3');
assert.equal(process.version, 'v26.12.0');
const [dataset, variant, destination] = process.argv.slice(2);
const fixture = JSON.parse(readFileSync(`${root}exportlite/benchmarks/results/batch-profile/fixtures.json`, 'utf8'))[dataset];
const prior = JSON.parse(readFileSync(`${root}outputs/performance-zip/summary.json`, 'utf8')).find(row => row.dataset === dataset);
const { exportTable } = await import(variant === 'buffered' ? `${root}exportlite/benchmarks/baselines/pre-direct-zip/dist/index.mjs` : (variant === "adaptive-mean" ? new URL(`./variants/${variant}/dist/index.mjs`, import.meta.url) : new URL(`../zip-batch-sizing/variants/${variant}/dist/index.mjs`, import.meta.url)));
const db = new Database(fixture.path, { readonly: true });
const batches = [];
let executions = 0;
let dataStatements = 0;
let callbacks = 0;
const connection = {
  function(name, options, callback) {
    db.function(name, options, token => { callbacks++; return callback(token); });
  },
  prepare(sql) {
    const statement = db.prepare(sql);
    if (sql.startsWith('WITH RECURSIVE "__exportlite_batches"')) {
      dataStatements++;
      const iterate = statement.iterate.bind(statement);
      statement.iterate = function* (...params) {
        executions++;
        for (const value of iterate(...params)) {
          const [payload, rows] = value;
          assert(Buffer.isBuffer(payload));
          batches.push({ rows: Number(rows), bytes: payload.length });
          yield value;
        }
      };
    }
    return statement;
  },
};
let zipInputChunks = 0;
let zipInputBytes = 0;
const pipe = PassThrough.prototype.pipe;
PassThrough.prototype.pipe = function (...args) {
  if (this.constructor.name === 'EntryInput') this.on('data', chunk => { zipInputChunks++; zipInputBytes += chunk.length; });
  return pipe.apply(this, args);
};
const hash = createHash('sha256');
const sink = new Writable({ write(chunk, _encoding, callback) { hash.update(chunk); callback(); } });
try {
  const result = await exportTable(connection, dataset === 'matched' ? 'users' : 'data', {
    columns: dataset === 'matched' ? ['name'] : ['id','name','note','active'],
    zip: true, format: 'json', output: sink, end: true,
  });
  const encodedSha256 = hash.digest('hex');
  assert.equal(encodedSha256, prior.encodedSha256);
  assert.equal(zipInputBytes, fixture.expected.bytes);
  assert.equal(result.rowsExported, fixture.rows);
  assert.equal(dataStatements, 1);
  assert.equal(executions, 1);
  assert.equal(batches.reduce((sum, row) => sum + row.rows, 0), fixture.rows);
  const percentile = (values, q) => [...values].sort((a,b) => a-b)[Math.ceil(values.length * q) - 1];
  const stats = key => ({ min: Math.min(...batches.map(row => row[key])), max: Math.max(...batches.map(row => row[key])), mean: batches.reduce((sum,row) => sum + row[key],0)/batches.length, p50: percentile(batches.map(row => row[key]),0.5), p95: percentile(batches.map(row => row[key]),0.95) });
  const report = {dataset, variant, note: 'Untimed instrumented diagnostic; throughput/RSS measured separately.', dataStatements, executions, callbacks, batches: batches.length, zipInputChunks, zipInputBytes, batchRows: stats('rows'), batchBytes: stats('bytes'), firstBatches: batches.slice(0,12), lastBatches: batches.slice(-5), targetBytes: variant.startsWith('adaptive-') ? 262144 : null, batchesOver256KiB: batches.filter(row => row.bytes > 262144).length, encodedSha256};
  writeFileSync(destination, JSON.stringify(report,null,2));
  console.log(`${dataset} ${variant}: ${batches.length} batches; ${zipInputChunks} ZIP writes; ${(report.batchBytes.mean / 1024).toFixed(1)} KiB mean batch`);
} finally {
  PassThrough.prototype.pipe = pipe;
  db.close();
}
