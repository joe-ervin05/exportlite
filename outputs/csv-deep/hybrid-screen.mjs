import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Writable} from 'node:stream';
const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(`${root}exportlite/package.json`);
const Database=require('better-sqlite3');
const api=await import(`${root}outputs/csv-deep/builds/baseline/dist/index.mjs`);
const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
const values=[0,1,2,3].map(i=>`"__exportlite_c${i}"`);
const original=`concat_ws(',', ${values.map(v=>`CASE typeof(${v}) WHEN 'null' THEN '' WHEN 'blob' THEN json_quote(${v}) WHEN 'text' THEN '"' || replace(${v}, '"', '""') || '"' ELSE CAST(${v} AS TEXT) END`).join(', ')})`;
function mask(kinds){return values.map((v,i)=>`CASE WHEN typeof(${v}) IN (${kinds}) THEN ${2**i} ELSE 0 END`).join(' + ')}
const scalar=values.map(v=>`CASE WHEN typeof(${v})='blob' THEN json_quote(${v}) ELSE CAST(${v} AS TEXT) END`);
function encode(row,kind){
 let out='';const flags=Number(row[4]);
 for(let i=0;i<4;i++){
  if(i)out+=',';let v=row[i];if(v===null)continue;
  if(kind==='wrapped'){
   out+=Array.isArray(v)?v[0]:`"${v.replaceAll('"','""')}"`;
  }else if(typeof v==='string'&&(kind==='real'?!(flags&(1<<i)):(flags&(1<<i))))out+=`"${v.replaceAll('"','""')}"`;
  else out+=String(v);
 }
 return out+'\r\n';
}
const variants=['baseline','raw-mask','raw-real-bigint','json-mask','json-wrapped','callback'];
if(process.argv[2]==='worker'){
 const [fixture,variant]=process.argv.slice(3);const db=new Database(`${root}outputs/csv-js/fixtures/${fixture}.sqlite`,{readonly:true});
 let sql;const traced={prepare(s){if(s.startsWith('WITH RECURSIVE'))sql=s;return db.prepare(s)}};
 await api.exportTable(traced,'data',{format:'csv',columns:{id:api.integer().primaryKey(),name:api.text(),note:api.text(),active:api.integer()},output:new Writable({write(_c,_e,cb){cb()}})});
 let kind='mask';
 if(variant==='raw-mask')sql=`SELECT ${scalar.join(', ')}, ${mask("'text'")} FROM (SELECT id AS __exportlite_c0,name AS __exportlite_c1,note AS __exportlite_c2,active AS __exportlite_c3 FROM data ORDER BY id LIMIT -1 OFFSET 0)`;
 else if(variant==='raw-real-bigint'||variant==='callback'){
  kind='real';const normalized=values.map(v=>`CASE typeof(${v}) WHEN 'blob' THEN json_quote(${v}) WHEN 'real' THEN CAST(${v} AS TEXT) ELSE ${v} END`);
  if(variant==='callback'){
   db.function('__csv',{varargs:true,safeIntegers:true},(...row)=>encode(row,'real').slice(0,-2));
   sql=sql.replace(original,`__csv(${normalized.join(', ')}, ${mask("'real'")})`);
  }else sql=`SELECT ${normalized.join(', ')}, ${mask("'real'")} FROM (SELECT id AS __exportlite_c0,name AS __exportlite_c1,note AS __exportlite_c2,active AS __exportlite_c3 FROM data ORDER BY id LIMIT -1 OFFSET 0)`;
 }else if(variant.startsWith('json')){
  let row;
  if(variant==='json-wrapped'){
   kind='wrapped';row=`json_array(${values.map(v=>`CASE typeof(${v}) WHEN 'integer' THEN json_array(CAST(${v} AS TEXT)) WHEN 'real' THEN json_array(CAST(${v} AS TEXT)) WHEN 'blob' THEN json_quote(${v}) ELSE ${v} END`).join(', ')})`;
  }else row=`json_array(${scalar.join(', ')}, ${mask("'text'")})`;
  const aggregate=`group_concat(${original}, char(13, 10)) || char(13, 10)`;
  const replacement=`json_group_array(${row})`;
  assert(sql.includes(aggregate));sql=sql.replace(aggregate,replacement);
  sql=sql.replace(`CAST(char(13, 10) || ${replacement} AS BLOB)`,replacement);
 }
 const statement=db.prepare(sql).raw();if(variant==='raw-real-bigint')statement.safeIntegers(true);
 function run(verify=false){const parts=[];let bytes=0,count=0;const hash=verify?createHash('sha256'):undefined;
  function put(s){bytes+=Buffer.byteLength(s);if(verify)parts.push(s)}
  for(const row of statement.iterate()){
   if(variant.startsWith('raw')){put(encode(row,kind));count++}
   else if(variant.startsWith('json')){const records=JSON.parse(row[0]);let buffer='';for(const r of records)buffer+=encode(r,kind);put(buffer);count+=Number(row[1])}
   else {const value=row[0].subarray(2);bytes+=value.length;count+=Number(row[1]);hash?.update(value)}
  }
  if(verify&&parts.length)hash.update(parts.join(''));
  return {bytes,count,...(hash?{sha256:hash.digest('hex')}:{})};
 }
 const checked=run(true);run();run();const samples=[];
 for(let i=0;i<5;i++){const t=performance.now();for(let j=0;j<3;j++)run();samples.push((performance.now()-t)/3)}
 console.log(JSON.stringify({fixture,variant,...checked,medianMs:median(samples),samplesMs:samples,peakRssMiB:process.resourceUsage().maxRSS/1024}));db.close();
}else{
 const all=[];
 for(const fixture of ['tiny','narrow','wide'])for(const variant of variants){
  const c=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'worker',fixture,variant],{encoding:'utf8',maxBuffer:1e6});assert.equal(c.status,0,c.stderr);
  const r=JSON.parse(c.stdout);all.push(r);console.error(fixture,variant,r.medianMs.toFixed(2),r.peakRssMiB.toFixed(1));
 }
 await writeFile(`${root}outputs/csv-deep/hybrid-screen.json`,JSON.stringify(all,null,2)+'\n');
 for(const f of ['tiny','narrow','wide'])assert.equal(new Set(all.filter(r=>r.fixture===f).map(r=>r.sha256)).size,1);
}
