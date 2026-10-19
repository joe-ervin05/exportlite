import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const read = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const all = read('all.json');
const summary = read('summary.json');
const validation = read('validation.json');
assert.equal(all.length, 75);
assert.equal(all.flatMap(row => row.samples).length, 225);
assert.equal(validation.length, 75);
assert(validation.every(row => row.passed));
const methods = ['buffered','fixed-256','fixed-1024','fixed-4096','adaptive-p95'];
const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length/2)];
for (const row of summary) {
  const group = all.filter(result => result.dataset === row.dataset && result.variant === row.method);
  assert.equal(group.length, 5);
  row.minPeakRssMiB = Math.min(...group.map(result => result.peakRssMiB));
  row.maxPeakRssMiB = Math.max(...group.map(result => result.peakRssMiB));
  const baseline = summary.find(result => result.dataset === row.dataset && result.method === 'buffered');
  row.elapsedRatioToBuffered = row.totalMs/baseline.totalMs;
  row.medianRssRatioToBuffered = row.peakRssMiB/baseline.peakRssMiB;
  // Compare matching rounds as an additional summary of the rotating schedule.
  const ratios = group.map(result => {
    const repeat = all.filter(other => other.dataset === row.dataset && other.variant === row.method).indexOf(result);
    const before = all.filter(other => other.dataset === row.dataset && other.variant === 'buffered')[repeat];
    return result.median.totalMs/before.median.totalMs;
  });
  row.rotatingRoundElapsedRatios = ratios;
  row.medianRotatingRoundElapsedRatio = median(ratios);
}
writeFileSync(new URL('summary.json',import.meta.url), JSON.stringify(summary,null,2));
const overall = methods.map(method => ({method, highestObservedPeakRssMiB: Math.max(...all.filter(row => row.variant === method).map(row => row.peakRssMiB)), cases: summary.filter(row => row.method === method).map(({dataset,totalMs,peakRssMiB,maxPeakRssMiB,elapsedRatioToBuffered}) => ({dataset,totalMs,medianPeakRssMiB:peakRssMiB,maxPeakRssMiB,elapsedRatioToBuffered}))}));
writeFileSync(new URL('overall.json',import.meta.url), JSON.stringify({criterion:'Consistently reasonable memory, lower observed peak memory or faster exports; no requirement to minimize every fixture separately.', memoryMeaning:'RSS is the high-water mark of the whole worker, including verification, warmup and three timed exports. Highest observed is the maximum of 15 workers per method across these fixtures, not a guaranteed bound.', methods:overall},null,2));
const csv = ['dataset,method,median_ms,min_ms,max_ms,median_peak_rss_mib,min_peak_rss_mib,max_peak_rss_mib,zip_bytes'];
for (const row of summary) csv.push([row.dataset,row.method,row.totalMs,row.minMs,row.maxMs,row.peakRssMiB,row.minPeakRssMiB,row.maxPeakRssMiB,row.zipBytes].join(','));
writeFileSync(new URL('summary.csv',import.meta.url), `${csv.join('\n')}\n`);
console.log(JSON.stringify(overall,null,2));
