import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync,writeFileSync,mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(`${root}exportlite/benchmarks/matched-api/package.json`);
const Database=require('better-sqlite3');
assert.equal(process.version,'v26.12.0');
const original=JSON.parse(readFileSync(`${root}exportlite/benchmarks/results/batch-profile/fixtures.json`,'utf8'));
assert.equal(createHash('sha256').update(readFileSync(original.narrow.path)).digest('hex'),original.narrow.fixtureSha256);
const directory=mkdtempSync(join(tmpdir(),'exportlite-plan-cache-'));
const path=join(directory,'small.db');
const db=new Database(path);
const cases=[];
try {
  db.prepare('ATTACH DATABASE ? AS fixture').run(original.narrow.path);
  for(const rows of [1,10,1000]) {
    db.exec(`CREATE TABLE data${rows}(id INTEGER PRIMARY KEY,name TEXT,note TEXT,active INTEGER); INSERT INTO data${rows} SELECT id,name,note,active FROM fixture.data ORDER BY rowid LIMIT ${rows}`);
    const payload=db.prepare(`SELECT CAST(json_group_array(json_object('id',id,'name',name,'note',note,'active',active)) AS BLOB) FROM (SELECT * FROM data${rows} ORDER BY rowid)`).pluck().get();
    const expected={bytes:payload.length,sha256:createHash('sha256').update(payload).digest('hex')};
    for(const api of ['table','query']) cases.push({name:`${api}-${rows}`,api,rows,path,table:`data${rows}`,expected,iterations:rows===1000?50:300,warmups:20,cold:false,zip:false});
    if(rows===1)for(const api of ['table','query'])cases.push({name:`cold-${api}-1`,api,rows,path,table:'data1',expected,iterations:50,warmups:2,cold:true,zip:false});
  }
} finally {db.close();}
const zipReference=JSON.parse(readFileSync(`${root}outputs/zip-memlevel-9/summary.json`,'utf8')).find(row=>row.dataset==='wide'&&row.method==='mem9');
cases.push({name:'bulk-plain',api:'table',rows:original.narrow.rows,path:original.narrow.path,table:'data',expected:original.narrow.expected,iterations:1,warmups:1,cold:false,zip:false});
cases.push({name:'bulk-zip',api:'table',rows:original.wide.rows,path:original.wide.path,table:'data',expected:original.wide.expected,expectedZip:{bytes:zipReference.zipBytes,sha256:zipReference.encodedSha256},iterations:1,warmups:1,cold:false,zip:true});
const fixtures={path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),sourceFixture:original.narrow,cases};
writeFileSync(new URL('./fixtures.json',import.meta.url),JSON.stringify(fixtures,null,2));
console.log(`Prepared ${cases.length} benchmark cases from the same varied data, using Node ${process.version}.`);
