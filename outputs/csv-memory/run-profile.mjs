import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFixture } from "../../exportlite/benchmarks/fixture.mjs";

assert.equal(process.version, "v26.12.0");
const here=fileURLToPath(new URL("./",import.meta.url));
const pkg=fileURLToPath(new URL("../../exportlite/",import.meta.url));
const probe=join(here,"probe.mjs");
const worker=fileURLToPath(new URL("../csv/compare.mjs",import.meta.url));
const fixture={name:"wide",rows:15000,width:1024,profile:"varied",iterations:2,path:join(here,"fixtures/wide.sqlite")};
await mkdir(join(here,"fixtures"),{recursive:true});
await mkdir(join(here,"profiles"),{recursive:true});
try { await access(fixture.path); } catch { createFixture(fixture.path,fixture.rows,{...fixture,seed:20261017}); }
const builds={before:process.env.EXPORTLITE_BEFORE ?? join(here,"baseline/dist"),after:process.env.EXPORTLITE_AFTER ?? join(pkg,"dist")};
const checks=[];
for(const [variant,method] of [["before","exportlite-table"],["after","exportlite-table"],["control","js-stream"]]) for(const compression of ["none","zip"]) {
  const out=join(here,"profiles",`${variant}-${method}-${compression}.json`);
  const c=spawnSync(process.execPath,["--expose-gc","--import",probe,worker,"worker",JSON.stringify(fixture),method,compression],{
    encoding:"utf8",maxBuffer:1024*1024,
    env:{...process.env,PROFILE_OUT:out,EXPORTLITE_BUILD:builds[variant] ?? builds.after},
  });
  assert.equal(c.status,0,c.stderr);
  const result=JSON.parse(c.stdout);
  const profile=JSON.parse(await readFile(out,"utf8"));
  checks.push({variant,method,compression,bytes:result.bytes,sha256:result.sha256,allocations:profile.allocations,peaks:profile.peaks,naturalGc:profile.naturalGc});
}
for (const compression of ["none","zip"]) assert.equal(new Set(checks.filter(c=>c.compression===compression).map(c=>c.sha256)).size,1);
await writeFile(join(here,"profiles/checks.json"),JSON.stringify({node:process.version,protocol:"Separate instrumented workers; nine exports each. Counts native batches, Buffer.concat and string Buffer.from allocations >=4 KiB. Samples memory at allocation/iteration and on a 5 ms timer; observes natural GC. Three forced GCs occur only after all exports and client close, as a diagnostic. Do not use these instrumented timings/peaks as the performance comparison. Before/after and manual JS output hashes match.",checks},null,2)+"\n");
console.log("Allocation profiles and output hashes verified.");
