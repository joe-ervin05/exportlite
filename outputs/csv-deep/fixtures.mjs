import {createRequire} from 'node:module';
import {access,cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(`${root}exportlite/package.json`);
const Database=require('better-sqlite3');
const {stringify}=require('csv-stringify/sync');
const {parse}=require('csv-parse/sync');
const here=`${root}outputs/csv-deep/fixtures`;
await mkdir(here,{recursive:true});
const normal=[{key:'id',type:'integer',primary:true},{key:'name',type:'text'},{key:'note',type:'text'},{key:'active',type:'integer'}];
const fixtures=[
 {name:'tiny',rows:100,columns:normal,iterations:50},
 {name:'narrow',rows:50000,columns:normal,iterations:2},
 {name:'wide',rows:15000,columns:normal,iterations:2},
 {name:'narrow-typed',source:'narrow',rows:50000,columns:normal.map(c=>c.key==='active'?{...c,mode:'boolean'}:c),iterations:2},
 {name:'wide-typed',source:'wide',rows:15000,columns:normal.map(c=>c.key==='active'?{...c,mode:'boolean'}:c),iterations:2},
 {name:'null-heavy',rows:50000,columns:normal,iterations:2},
 {name:'quote-heavy',rows:15000,columns:normal,iterations:2},
 {name:'boolean',rows:50000,columns:[normal[0],...['name','note','active'].map(key=>({key,type:'integer',mode:'boolean'}))],iterations:2},
 {name:'json',rows:15000,columns:[normal[0],{key:'name',type:'text',mode:'json'},{key:'note',type:'text',mode:'json'},{key:'active',type:'integer',mode:'boolean'}],iterations:2,drizzle:true},
 {name:'many-columns',rows:15000,columns:[normal[0],...Array.from({length:31},(_,i)=>({key:`c${i}`,type:i%3===0?'integer':'text'}))],iterations:2},
];
for(const f of fixtures){
 f.path=`${here}/${f.source??f.name}.sqlite`;
 try{await access(f.path)}catch{
  if(['tiny','narrow','wide'].includes(f.name))await cp(`${root}outputs/csv-js/fixtures/${f.name}.sqlite`,f.path);
  else{
   const db=new Database(f.path);
   try{
    db.exec(`CREATE TABLE data (${f.columns.map(c=>`"${c.key}" ${c.type==='integer'?'INTEGER':'TEXT'}${c.primary?' PRIMARY KEY':''}`).join(',')})`);
    const insert=db.prepare(`INSERT INTO data VALUES(${f.columns.map(()=>'?').join(',')})`);
    db.transaction(()=>{
     for(let id=1;id<=f.rows;id++){
      let row;
      if(f.name==='null-heavy')row=[id,id%10?null:`Name ${id}`,id%10?null:`Note ${id}`,id%10?null:id%2];
      else if(f.name==='quote-heavy')row=[id,`雪,"${id}"`,id%7===0?null:`${id}: `+'"q",\r\n雪\0'.repeat(100),id%2];
      else if(f.name==='boolean')row=[id,id%2,id%7?1:null,id%3?0:null];
      else if(f.name==='json')row=[id,` { "id" : ${id}, "label" : "雪,quote\\\"", "nested" : [true,null] } `,id%7===0?null:JSON.stringify({ticket:`ticket-${id}`,note:`${id}: `+'a "quote" and 雪,\n'.repeat(32),count:id%29}),id%2];
      else row=[id,...f.columns.slice(1).map((c,i)=>id%7===0?null:c.type==='integer'?id*13+i:`${id} field ${i}, "quoted" 雪`)];
      insert.run(...row);
     }
    })();
   }finally{db.close()}
  }
 }
 f.databaseSha256=createHash('sha256').update(await readFile(f.path)).digest('hex');
 const db=new Database(f.path,{readonly:true});
 try{
  const rows=db.prepare('SELECT * FROM data ORDER BY id').all().map(row=>Object.fromEntries(f.columns.map(c=>{
   const v=row[c.key];return[c.key,v===null?null:c.mode==='boolean'?(v?'true':'false'):c.mode==='json'?JSON.stringify(JSON.parse(v)):v];
  })));
  const csv=stringify(rows,{columns:f.columns.map(c=>c.key),header:true,quoted_string:true,record_delimiter:'\r\n'});
  const parsed=parse(csv,{columns:true});
  if(parsed.length!==f.rows)throw Error('Bad fixture');
  for(let i=0;i<rows.length;i++)for(const c of f.columns)if(parsed[i][c.key]!==String(rows[i][c.key]??''))throw Error('CSV mismatch');
  f.bytes=Buffer.byteLength(csv);f.csvSha256=createHash('sha256').update(csv).digest('hex');
  f.sqliteVersion=db.prepare('SELECT sqlite_version()').pluck().get();
 }finally{db.close()}
}
await writeFile(`${here}/configuration.json`,JSON.stringify(fixtures,null,2)+'\n');
console.log('Generated and independently validated CSV fixtures, including ordinary data with one boolean declaration.');
