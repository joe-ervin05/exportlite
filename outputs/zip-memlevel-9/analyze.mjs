import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../',import.meta.url));
const directory = fileURLToPath(new URL('.',import.meta.url));
const read = name => JSON.parse(readFileSync(`${directory}${name}`,'utf8'));
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const all = read('all.json');
const summary = read('summary.json');
const config = read('configuration.json');
assert.equal(all.length,30);
assert.equal(all.flatMap(row => row.samples).length,90);
assert.equal(read('validation.json').length,30);
assert(read('validation.json').every(row => row.passed));
for (const [file,digest] of Object.entries(read('default-fingerprints.json'))) assert.equal(sha256(`${root}exportlite/${file}`),digest,file);
for (const [file,digest] of Object.entries(config.fingerprints)) assert.equal(sha256(`${root}${file}`),digest,file);
for (const name of ['dist/index.d.mts','dist/index.d.cts','src/planner/batches.ts','src/output/writer.ts','src/api/export.ts','src/output/readable.ts']) assert.deepEqual(readFileSync(`${root}exportlite/${name}`),readFileSync(`${directory}variant/${name}`),name);
assert(readFileSync(`${directory}variant-tests.log`,'utf8').includes('180 passed'));
const comparisons = ['matched','narrow','wide'].map(dataset => {
  const current = summary.find(row => row.dataset === dataset && row.method === 'current');
  const mem9 = summary.find(row => row.dataset === dataset && row.method === 'mem9');
  assert.equal(current.decodedSha256,mem9.decodedSha256);
  assert.equal(current.jsonBytes,mem9.jsonBytes);
  const roundRatios = [];
  for (let round=0;round<5;round++) {
    const before = all.filter(row => row.dataset === dataset && row.variant === 'current')[round];
    const after = all.filter(row => row.dataset === dataset && row.variant === 'mem9')[round];
    roundRatios.push(after.median.totalMs/before.median.totalMs);
  }
  return {dataset,current,mem9,elapsedChangePct:100*(mem9.totalMs/current.totalMs-1),zipSizeChangePct:100*(mem9.zipBytes/current.zipBytes-1),medianPeakRssChangePct:100*(mem9.peakRssMiB/current.peakRssMiB-1),rotatingRoundElapsedRatios:roundRatios};
});
const report = {protocol:'Same fixture hashes, Node 26.12.0, sequential fresh workers in alternating method order. Five workers per setting/fixture, three timed exports per worker after verification and warmup. Timings include planning through ZIP and destination completion; disk, network, process/module startup and verification excluded. Natural GC.',memoryMeaning:'Median whole-worker peak RSS, including startup, verification, warmup and three timed exports. Observed max/min retained. These are not per-request allocations or hard bounds.',comparisons};
writeFileSync(`${directory}comparison.json`,JSON.stringify(report,null,2));
const csv = ['fixture,setting,median_ms,min_ms,max_ms,zip_bytes,zip_mib,median_peak_rss_mib,min_peak_rss_mib,max_peak_rss_mib'];
for (const row of summary) csv.push([row.dataset,row.method,row.totalMs,row.minMs,row.maxMs,row.zipBytes,row.zipBytes/1048576,row.peakRssMiB,row.minPeakRssMiB,row.maxPeakRssMiB].join(','));
writeFileSync(`${directory}summary.csv`,`${csv.join('\n')}\n`);
writeFileSync(`${directory}checks.json`,JSON.stringify({prototype:{tests:180,testFiles:5,types:'passed',lint:'passed',esmAndCommonJsBuild:'passed',sourceChange:'Only adds memLevel:9 to ZIP zlib options. Fixed 256-row batching, 64 KiB output flush target, buffer joins, callback/drain checks, cancellation and cleanup unchanged.'},defaultPackage:'Source, build, tests and public declarations unchanged; SHA-256 fingerprints verified.',benchmark:{node:'v26.12.0',sqlite:all[0].environment.sqlite,freshWorkers:30,timedExports:90,verifiedArchives:30,validation:'All actual ZIP verification archives independently decoded and checked for JSON SHA-256, decoded byte count, entry metadata and CRC-32. Encoded digest consistent per setting and fixture. Timed outputs checked for expected encoded size. Current setting also matches previous encoded archive hashes.'}},null,2));
const variant = `${directory}variant/`;
const files = ['src','dist','tests'].flatMap(folder => readdirSync(`${variant}${folder}`,{recursive:true,withFileTypes:true}).filter(file => file.isFile()).map(file => `${file.parentPath}/${file.name}`));
writeFileSync(`${variant}manifest.json`,JSON.stringify(Object.fromEntries(files.map(file => [file.slice(variant.length),sha256(file)])),null,2));
for (const row of comparisons) console.log(`${row.dataset}: time ${row.elapsedChangePct.toFixed(2)}%; ZIP size ${row.zipSizeChangePct.toFixed(2)}%; median RSS ${row.medianPeakRssChangePct.toFixed(2)}%`);
console.log('All content, reliability-suite and source/build fingerprint checks passed.');
