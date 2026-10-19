import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('.', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
const {readZip} = await import(`${root}exportlite/benchmarks/read-zip.mjs`);
const node = '<node-26.12.0>';
const temporary = mkdtempSync(join(tmpdir(), 'exportlite-zip-diagnostic-'));
const all = [];
try {
 for (const dataset of ['narrow','wide']) for (const method of ['exportlite','objects']) {
  const archive = `${temporary}/${dataset}-${method}.zip`;
  const out = `${directory}diagnostic-${dataset}-${method}.json`;
  const child = spawnSync(node, ['--expose-gc',`${directory}diagnose.mjs`,`--dataset=${dataset}`,`--method=${method}`,'--samples=3',`--archive=${archive}`,`--out=${out}`], {stdio:'inherit'});
  assert.equal(child.status, 0);
  const result=JSON.parse(readFileSync(out,'utf8'));
  const decoded=await readZip(archive,{name:result.entryName});
  assert.equal(decoded.sha256,result.expected.sha256);
  assert.equal(decoded.bytes,result.expected.bytes);
  all.push(result); rmSync(archive);
 }
} finally {rmSync(temporary,{recursive:true,force:true});}
writeFileSync(`${directory}diagnostic-all.json`,JSON.stringify(all,null,2));
