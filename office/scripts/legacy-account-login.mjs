// Run locally by the operator. Starts no services and prints no secrets.
import {readFileSync,realpathSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {parseEnv} from 'node:util';
let apply=false,agent='',envFile='.env';
for(let i=2;i<process.argv.length;i++) {
  if(process.argv[i]==='--uygula')apply=true;
  else if(process.argv[i]==='--ajan')agent=process.argv[++i];
  else if(process.argv[i]==='--ortam')envFile=process.argv[++i];
  else throw Error("Usage: node scripts/legacy-account-login.mjs [--ortam .env] [--ajan id] [--uygula]");
}
const env=parseEnv(readFileSync(envFile,'utf8')),dataDir=resolve(env.OFIS_DATA_DIR || 'data');
if((env.TUDUDI_BASE_URL || 'http://127.0.0.1:9393')!=='http://127.0.0.1:9393')throw Error("Only the separate agent instance on 9393 is allowed.");
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),database=resolve(dataDir,'ofis.sqlite');
if(!dataDir.startsWith(repo+'/') || realpathSync(database)!==database)throw Error("Existing Office data must be inside this repository without symlinks.");
if(!apply) {
 const db=new DatabaseSync(database,{readOnly:true});
 try {
  const rows=db.prepare("SELECT id,name FROM agents WHERE tududi_state='ready' AND tududi_password_encrypted IS NULL AND (?='' OR id=?)").all(agent,agent);
  if(agent && !db.prepare('SELECT 1 FROM agents WHERE id=?').get(agent))throw Error("Agent not found.");
  for(const a of rows)console.log(`${a.name}: login preparation is required.`);
  console.log(rows.length ? "Listing only. Use --uygula to prepare login." : "No legacy accounts need login preparation.");
 }finally{db.close();}
}else{
const {loadConfig}=await import('../dist/server/config.js'),{Store}=await import('../dist/server/db.js'),{Office}=await import('../dist/server/service.js'),{TududiClient}=await import('../dist/server/tududi.js'),{prepareLegacyPassword}=await import('../dist/server/legacy-password.js');
const config=loadConfig(env);
const store=new Store(config.dataDir),office=new Office(store,config,new TududiClient(config));
try {
  const rows=store.agents().filter(a=>(!agent || a.id===agent) && a.tududi_state==='ready' && !store.db.prepare('SELECT tududi_password_encrypted FROM agents WHERE id=?').get(a.id).tududi_password_encrypted);
  if(agent && !store.agents().some(a=>a.id===agent))throw Error("Agent not found.");
  for(const a of rows) {
    await prepareLegacyPassword(office,a.id);console.log(`${a.name}: login ready; data preserved.`);
  }
  if(!rows.length)console.log("No legacy accounts need login preparation.");
}catch{console.error("Account preparation failed. Data was preserved; check operator access and connectivity.");process.exitCode=1;}
finally{store.db.close();}
}
