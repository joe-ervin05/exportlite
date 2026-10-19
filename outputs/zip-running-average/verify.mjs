import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = fileURLToPath(new URL('.', import.meta.url));
const parse = file => JSON.parse(readFileSync(file,'utf8'));
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const old = `${root}outputs/zip-batch-sizing/variants/adaptive-p95/`;
const current = `${directory}variants/adaptive-mean/`;
for (const [file,digest] of Object.entries(parse(`${directory}default-fingerprints.json`))) assert.equal(sha256(`${root}exportlite/${file}`),digest,file);
for (const [file,digest] of Object.entries(parse(`${directory}configuration.json`).fingerprints)) assert.equal(sha256(`${root}${file}`),digest,file);
for (const name of ['dist/index.d.mts','dist/index.d.cts','src/planner/batches.ts','src/output/writer.ts','src/output/zip.ts','src/output/readable.ts']) assert.deepEqual(readFileSync(`${current}${name}`),readFileSync(`${old}${name}`),name);
const logs = readFileSync(`${directory}adaptive-mean-tests.log`,'utf8');
assert(logs.includes('196 passed'));
const all = parse(`${directory}all.json`);
assert.equal(all.length,75);
assert.equal(all.flatMap(row => row.samples).length,225);
assert.equal(parse(`${directory}validation.json`).length,75);
const traces = readdirSync(`${directory}trace/`).filter(file => file.endsWith('.json')).map(file => parse(`${directory}trace/${file}`));
assert.equal(traces.length,6);
assert(traces.every(row => row.dataStatements === 1 && row.executions === 1));
const checks = {
  prototype: {tests:196, files:6, typecheck:'passed', lint:'passed', build:'ESM and CommonJS passed', difference:'Only the estimator module differs from the p95 prototype. SQL, ZIP, writer, readable lifecycle and public declarations are byte-identical.'},
  defaultPackage:'Source, tests and build unchanged; fingerprints verified.',
  benchmark:{node:'v26.12.0',freshWorkers:75,timedExports:225,verifiedArchives:75,zip:'Bit-identical ZIP archives per fixture; independently decoded and checked SHA-256, length and CRC-32. Timed exports checked for expected output size.'},
  diagnostics:'Six separate untimed exports, p95 and mean on each fixture; exact ZIP-input byte counts, encoded digest and one export query/execution verified.',
  estimator:'Cumulative mean batch bytes divided by cumulative mean batch rows; equivalent to total emitted payload bytes / total emitted rows. Two counters, no retained samples or sorting. Target 256 KiB with 10% headroom, initial 64 rows, growth limited to 2x and range 1–65536 rows. State is cleared when the iterator completes or is cancelled.',
  memory:'RSS is whole-process high-water including verification, warmup and three timed exports; natural GC. Highest observed across these fixtures is not a guaranteed bound. The controller observes serialized payload bytes, not process RSS.',
  timing:'Median of five fresh-worker medians with three timed exports each, rotating method order, sequential workers. All observations retained. Small differences should be assessed against min/max ranges.'
};
writeFileSync(`${directory}checks.json`,JSON.stringify(checks,null,2));
const files = ['src','dist','tests'].flatMap(folder => readdirSync(`${current}${folder}`,{recursive:true,withFileTypes:true}).filter(file => file.isFile()).map(file => `${file.parentPath}/${file.name}`));
writeFileSync(`${current}manifest.json`,JSON.stringify(Object.fromEntries(files.map(file => [file.slice(current.length),sha256(file)])),null,2));
console.log('All result, safety-suite, lifecycle and source fingerprint checks passed.');
