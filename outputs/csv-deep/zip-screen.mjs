import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const worker=`${root}outputs/csv/compare.mjs`;
const fixtures=[{name:'tiny',rows:100,width:32,profile:'repeated',iterations:50},{name:'narrow',rows:50000,width:32,profile:'varied',iterations:2},{name:'wide',rows:15000,width:1024,profile:'varied',iterations:2}];
const variants=['baseline','zip256k','zip1m','zip4m'];
const all=[];
for(let round=0;round<3;round++)for(const f of fixtures){
 const order=[...variants.slice(round),...variants.slice(0,round)];
 for(const variant of order){
 const c=spawnSync(process.execPath,[worker,'worker',JSON.stringify({...f,path:`${root}outputs/csv-js/fixtures/${f.name}.sqlite`}), 'exportlite-table','zip'],{encoding:'utf8',maxBuffer:1e6,env:{...process.env,EXPORTLITE_BUILD:`${root}outputs/csv-deep/builds/${variant}/dist`}});
 assert.equal(c.status,0,c.stderr);const r={round,variant,...JSON.parse(c.stdout)};all.push(r);
 console.error(round,f.name,variant,r.medianMs.toFixed(2),r.peakRssMiB.toFixed(1));
 await writeFile(`${root}outputs/csv-deep/zip-screen.json`,JSON.stringify(all,null,2)+'\n');
 }
}
for(const f of fixtures)assert.equal(new Set(all.filter(r=>r.fixture===f.name).map(r=>r.sha256)).size,1);
