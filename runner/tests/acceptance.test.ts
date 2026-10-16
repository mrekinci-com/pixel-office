import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {createApp} from '../../office/server/app.js';
import {testConfig,fakeTududi,cleanup,input} from '../../office/tests/helpers.js';
import {defaultPolicy} from '../../office/shared/runtime.js';
import {Worker} from '../src/worker.js';
import type {RunnerConfig} from '../src/config.js';
test("B2: fake CLI completion runs registered acceptance commands; failed gates cannot complete work",async()=>{
 const config={...testConfig(),runnerKey:'acceptance-fake-runner-key-'.repeat(2)},fake=fakeTududi(),c=await createApp(config,{fetcher:fake.fetcher,background:false});mkdirSync(resolve('.test-data'),{recursive:true});const dir=mkdtempSync(resolve('.test-data/acceptance-')),folderPath=join(dir,'folder');mkdirSync(folderPath);
 const did=randomUUID();c.store.db.prepare('INSERT INTO departments(id,name,description,color,sort_order) VALUES (?,?,?,?,?)').run(did,'Ekip','','#336699',1);const a=await c.office.createAgent({...input(did),policy:{...defaultPolicy,permission:'folders'}}),folder={id:randomUUID(),name:'Deneme klasörü',path:folderPath,agent_ids:[a.id],access:'read' as const,approved_write:true,validation:'valid' as const,detail:''};c.store.db.prepare('INSERT INTO folder_links VALUES (?,?)').run(folder.id,JSON.stringify(folder));
 const command={id:randomUUID(),name:'Kabul testi',folder_id:folder.id,directory:'.',command:'tanımlı-test',timeout_seconds:30,write:false,approval:false,agent_ids:[a.id]};c.store.db.prepare('INSERT INTO command_links VALUES (?,?)').run(command.id,JSON.stringify(command));
 const cli=join(dir,'fake.mjs');writeFileSync(cli,"console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Modelin tamamlandı iddiası'}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:5,output_tokens:2}}));\n");
 const runner:RunnerConfig={url:'http://127.0.0.1:9400',key:config.runnerKey,workDir:join(dir,'work'),allowedRoots:[folderPath],protectedRoots:[],concurrency:1,claude:'claude',codex:'codex',bwrap:'bwrap',codexModel:'secilen-model',smoke:true};
 const fetcher:typeof fetch=async(url,init)=>{const r=await c.app.inject({method:'POST',url:new URL(String(url)).pathname,headers:Object.fromEntries(new Headers(init?.headers).entries()),payload:JSON.parse(String(init?.body))});return new Response(r.body,{status:r.statusCode,headers:{'content-type':'application/json'}});};let exit=0,called=0;
 const worker=new Worker(runner,fetcher,command=>({...command,bin:process.execPath,args:[cli]}),undefined,async job=>{called++;assert.equal(job.command.id,command.id);assert.equal(job.command.command,'tanımlı-test');return {exit_code:exit,output:'Kayıtlı kapı sonucu'};});
 try{c.runtime.heartbeat(worker.id,{codex:['secilen-model'],claude:['sonnet']});for(const code of [0,1]){exit=code;const r=c.runtime.enqueue(a.id,'Elle','Kapıyı dene')!;c.runtime.setWorkOptions(r.id,{acceptance:[command.id]});const lease=c.runtime.claim(worker.id)!;assert.equal(lease.acceptanceCommands?.[0].id,command.id);await worker.execute(lease);assert.equal(c.runtime.run(r.id).state,code===0?'completed':'failed');assert.ok(c.store.db.prepare("SELECT 1 FROM run_logs WHERE run_id=? AND kind='acceptance_result'").get(r.id));}assert.equal(called,2);}
 finally{await worker.shutdown();await c.app.close();cleanup(config);rmSync(dir,{recursive:true,force:true});}
});
