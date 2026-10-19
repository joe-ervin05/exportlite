import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, access } from "node:fs/promises";
import { cpus } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL("./", import.meta.url));
const pkg = fileURLToPath(new URL("../../exportlite/", import.meta.url));
const worker = fileURLToPath(new URL("../csv/compare.mjs", import.meta.url));
assert.equal(process.version, "v26.12.0");
const { createFixture } = await import(pathToFileURL(join(pkg, "benchmarks/fixture.mjs")));
const fixtures = [
  {name:"tiny", rows:100, width:32, profile:"repeated", iterations:50},
  {name:"narrow", rows:50000, width:32, profile:"varied", iterations:2},
  {name:"wide", rows:15000, width:1024, profile:"varied", iterations:2},
].filter((f) => (process.env.BENCH_FIXTURES ?? "tiny,narrow,wide").split(",").includes(f.name));
await mkdir(join(here, "fixtures"), {recursive:true});
for (const f of fixtures) {
  f.path = join(here, "fixtures", `${f.name}.sqlite`);
  try { await access(f.path); } catch { createFixture(f.path, f.rows, {...f,seed:20261017}); }
  f.databaseSha256 = createHash("sha256").update(await readFile(f.path)).digest("hex");
}
const builds = { before: process.env.EXPORTLITE_BEFORE ?? join(here,"baseline/dist"), after:process.env.EXPORTLITE_AFTER ?? join(pkg,"dist") };
const rounds = Number(process.env.BENCH_ROUNDS ?? 5);
const output = process.env.BENCH_OUT ?? join(here,"comparison");
await mkdir(output, {recursive:true});
const methods = (process.env.BENCH_METHODS ?? "exportlite-table,exportlite-query,js-stream").split(",");
const results = [];
for (let round=0; round<rounds; round++) {
  for (const f of fixtures) for (const compression of ["none","zip"]) {
    const order = round % 2 ? [...methods].reverse() : methods;
    for (const method of order) for (const variant of method === "js-stream" ? ["control"] : round % 2 ? ["after","before"] : ["before","after"]) {
      const child = spawnSync(process.execPath, [worker,"worker",JSON.stringify(f),method,compression], {
        encoding:"utf8", maxBuffer:1024*1024,
        env:{...process.env, EXPORTLITE_BUILD:builds[variant] ?? builds.after},
      });
      assert.equal(child.status,0,child.stderr);
      results.push({round,variant,...JSON.parse(child.stdout)});
    }
  }
  await writeFile(join(output,"all.json"),JSON.stringify(results,null,2)+"\n");
  process.stderr.write(`Finished paired CSV round ${round+1}/${rounds}.\n`);
}
const summary=[];
for (const f of fixtures) for (const compression of ["none","zip"]) for (const method of methods) {
  const rows=results.filter(r=>r.fixture===f.name && r.compression===compression && r.method===method);
  assert.equal(new Set(rows.map(r=>r.sha256)).size,1);
  const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
  const metrics=variant=>{
    const subset=rows.filter(r=>r.variant===variant);
    return { medianMs:median(subset.map(r=>r.medianMs)), minWorkerMs:Math.min(...subset.map(r=>r.medianMs)), maxWorkerMs:Math.max(...subset.map(r=>r.medianMs)), medianPeakRssMiB:median(subset.map(r=>r.peakRssMiB)), maxPeakRssMiB:Math.max(...subset.map(r=>r.peakRssMiB)) };
  };
  const before=metrics(method==="js-stream"?"control":"before");
  const after=metrics(method==="js-stream"?"control":"after");
  summary.push({fixture:f.name,compression,method,before,after,timeChangePercent:100*(after.medianMs/before.medianMs-1),rssChangePercent:100*(after.medianPeakRssMiB/before.medianPeakRssMiB-1),bytes:rows[0].bytes,sha256:rows[0].sha256});
}
for (const f of fixtures) for (const compression of ["none","zip"]) {
  const comparable=results.filter(r=>r.fixture===f.name && r.compression===compression && (compression==="none" || r.method!=="exportlite-query"));
  assert.equal(new Set(comparable.map(r=>r.sha256)).size,1);
}
const hashes={};
for (const [variant,path] of Object.entries(builds)) {
  hashes[variant]={};
  for (const file of (await readdir(path)).filter(n=>n.endsWith(".mjs")).sort()) hashes[variant][file]=createHash("sha256").update(await readFile(join(path,file))).digest("hex");
}
await writeFile(join(output,"summary.json"),JSON.stringify(summary,null,2)+"\n");
await writeFile(join(output,"configuration.json"),JSON.stringify({node:process.version,nodeSha256:createHash("sha256").update(await readFile(process.execPath)).digest("hex"),cpu:cpus()[0]?.model,beforeCommit:"09404fd2dcd880590dbf22010bc2cbad1adfc4a5",rounds,methods,fixtures:fixtures.map(({path,...rest})=>rest),builds:hashes,protocol:"Sequential fresh workers; before/after order alternates by round. Same immutable varied fixtures/seed 20261017 and worker as CSV comparison. One hash verification, two warmups, then three timed batches, natural GC. Bulk=two exports per batch; tiny=50. No instrumentation or forced GC. Includes query construction, CSV generation, UTF-8/ZIP delivery and completion to counting Node writable. Process peak RSS includes setup/imports, verification and warmups. Before/after output bytes and SHA-256 must match; JS control CSV/table ZIP also match. Query ZIP uses a different entry name."},null,2)+"\n");
console.log(JSON.stringify({workers:results.length,cases:summary.length}));
