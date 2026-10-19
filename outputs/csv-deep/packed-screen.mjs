import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {Writable} from 'node:stream';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(`${root}exportlite/package.json`);
const Database=require('better-sqlite3');
const api=await import(`${root}outputs/csv-deep/builds/baseline/dist/index.mjs`);
const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
const values=[0,1,2,3].map(i=>`"__exportlite_c${i}"`);
const original=`concat_ws(',', ${values.map(v=>`CASE typeof(${v}) WHEN 'null' THEN '' WHEN 'blob' THEN json_quote(${v}) WHEN 'text' THEN '"' || replace(${v}, '"', '""') || '"' ELSE CAST(${v} AS TEXT) END`).join(', ')})`;
export function* encodeBatches(rows,columns,capacity=65536){
 let output=Buffer.allocUnsafe(capacity),used=0;
 for(const [blob] of rows){
  let cursor=2,column=0;
  while(cursor<blob.length){
   if(column){output[used++]=44;if(used===capacity){yield output;output=Buffer.allocUnsafe(capacity);used=0}}
   const text=blob[cursor++]===116;
   let start=cursor,end;
   if(text){let length=0;while(blob[cursor]!==58)length=length*10+blob[cursor++]-48;start=++cursor;end=start+length;cursor=end;
    output[used++]=34;if(used===capacity){yield output;output=Buffer.allocUnsafe(capacity);used=0}
   }else{end=blob.indexOf(58,cursor);assert(end>=0);cursor=end+1}
   let nextQuote=text?blob.indexOf(34,start):-1;
   if(nextQuote>=end)nextQuote=-1;
   while(start<end){
    const boundary=nextQuote<0?end:nextQuote+1;
    while(start<boundary){const n=Math.min(boundary-start,capacity-used);blob.copy(output,used,start,start+n);used+=n;start+=n;
     if(used===capacity){yield output;output=Buffer.allocUnsafe(capacity);used=0}
    }
    if(nextQuote>=0){output[used++]=34;if(used===capacity){yield output;output=Buffer.allocUnsafe(capacity);used=0}
     nextQuote=blob.indexOf(34,start);if(nextQuote>=end)nextQuote=-1;
    }
   }
   if(text){output[used++]=34;if(used===capacity){yield output;output=Buffer.allocUnsafe(capacity);used=0}}
   if(++column===columns){column=0;for(const byte of [13,10]){output[used++]=byte;if(used===capacity){yield output;output=Buffer.allocUnsafe(capacity);used=0}}}
  }
  assert.equal(column,0);
 }
 if(used)yield output.subarray(0,used);
}
if(process.argv[2]==='worker'){
 const[fixture,variant]=process.argv.slice(3);const db=new Database(`${root}outputs/csv-deep/fixtures/${fixture}.sqlite`,{readonly:true});
 let sql;const traced={prepare(s){if(s.startsWith('WITH RECURSIVE'))sql=s;return db.prepare(s)}};
 await api.exportTable(traced,'data',{format:'csv',columns:{id:api.integer().primaryKey(),name:api.text(),note:api.text(),active:api.integer()},output:new Writable({write(_c,_e,cb){cb()}})});
 if(variant==='packed'){
  const tuple=`concat(${values.map(v=>`CASE typeof(${v}) WHEN 'null' THEN 'n:' WHEN 'text' THEN concat('t', octet_length(${v}), ':', ${v}) WHEN 'blob' THEN json_quote(${v}) ELSE concat('n', CAST(${v} AS TEXT), ':') END`).join(', ')})`;
  assert(sql.includes(original));sql=sql.replace(original,tuple).replace(`group_concat(${tuple}, char(13, 10)) || char(13, 10)`,`group_concat(${tuple}, '')`);
 }
 const statement=db.prepare(sql).raw();
 function run(verify=false){const hash=verify?createHash('sha256'):undefined;let bytes=0;const rows=statement.iterate();
  for(const value of variant==='packed'?encodeBatches(rows,4):(function*(){for(const row of rows)yield row[0].subarray(2)})()){bytes+=value.length;hash?.update(value)}
  return {bytes,...(hash?{sha256:hash.digest('hex')}:{})};
 }
 const checked=run(true);run();run();const samples=[];for(let i=0;i<5;i++){const t=performance.now();for(let j=0;j<3;j++)run();samples.push((performance.now()-t)/3)}
 console.log(JSON.stringify({fixture,variant,...checked,medianMs:median(samples),samplesMs:samples,peakRssMiB:process.resourceUsage().maxRSS/1024}));db.close();
}else{
 const all=[];
 for(const fixture of ['tiny','narrow','wide','quote-heavy','null-heavy'])for(const variant of ['baseline','packed']){
  const c=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'worker',fixture,variant],{encoding:'utf8',maxBuffer:1e6});assert.equal(c.status,0,c.stderr);
  const r=JSON.parse(c.stdout);all.push(r);console.error(fixture,variant,r.medianMs.toFixed(2),r.peakRssMiB.toFixed(1));
 }
 await writeFile(`${root}outputs/csv-deep/packed-screen.json`,JSON.stringify(all,null,2)+'\n');
 for(const f of ['tiny','narrow','wide','quote-heavy','null-heavy'])assert.equal(new Set(all.filter(r=>r.fixture===f).map(r=>r.sha256)).size,1);
}
