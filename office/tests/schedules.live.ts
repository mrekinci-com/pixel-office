import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import {testConfig,input,cleanup} from './helpers.js';
// Explicit opt-in test. Requests are confined to the agents' 9393 copy.
test("B1 / 9393: one persistent task, real work note, second fresh input, rename and account cleanup",{timeout:60000},async()=>{
 const config=testConfig(),env=parseEnv(readFileSync('../tududi/.env','utf8'));config.tududiAdminEmail=env.TUDUDI_USER_EMAIL || '';config.tududiAdminPassword=env.TUDUDI_USER_PASSWORD || '';
 assert.ok(config.tududiAdminEmail && config.tududiAdminPassword);assert.equal(config.tududiUrl,'http://127.0.0.1:9393');
 let at=Date.now();const c=await createApp(config,{background:false,scheduleClock:()=>at,fetcher:async(url,init)=>{assert.equal(new URL(String(url)).origin,'http://127.0.0.1:9393');return fetch(url,init);}});
 let aid:string|undefined,email='';let verified=false;
 try{
  const dept=randomUUID();c.store.db.prepare('INSERT INTO departments(id,name,description,color,sort_order) VALUES (?,?,?,?,?)').run(dept,'B1 deneme','','#498f87',0);
  const a=await c.office.createAgent({...input(dept),username:'b1-deneme-'+randomUUID().slice(0,8),name:'B1 deneme ajanı'});aid=a.id;email=a.tududi_email;
  assert.equal(c.office.agent(a.id).tududi_state,'ready',"The 9393 test account must be ready.");
  const t=c.runtime.scheduler.upsert({name:'B1 kalıcı kontrol',agent_id:a.id,instruction:'Yalnız deneme belgelerini incele.',timing:{kind:'daily',time:'09:00'}});
  await c.runtime.scheduler.ensureTask(t,true);const firstTasks=(await c.runtime.notebook.data(a.id)).tasks;assert.equal(firstTasks.filter(task=>task.name==='Zamanlanmış: B1 kalıcı kontrol').length,1);const uid=firstTasks.find(task=>task.name==='Zamanlanmış: B1 kalıcı kontrol')!.uid;
  c.runtime.heartbeat('live-b1');const h=c.runtime.scheduler.launch(t,new Date(at).toISOString()),first=c.runtime.claim('live-b1')!;assert.equal(first.run.id,h.run_id);assert.equal(first.session,undefined);
  await c.runtime.tool(first.run,'is_notu_yaz',{metin:'İlk doğrulanmış deneme sonucu. Sıradaki adım: tekrar karşılaştır.'});c.runtime.finish(first.run.id,'completed','Birinci deneme sonucu.','');c.runtime.scheduler.reconcile();
  at+=60000;c.runtime.heartbeat('live-b1');c.runtime.scheduler.launch(c.runtime.scheduler.task(t.id),new Date(at).toISOString());const second=c.runtime.claim('live-b1')!;assert.equal(second.session,undefined);assert.match(second.prompt,/İlk doğrulanmış deneme sonucu/);
  await c.runtime.tool(second.run,'is_notu_yaz',{metin:'İkinci doğrulanmış deneme sonucu.'});c.runtime.finish(second.run.id,'completed','İkinci deneme sonucu.','');c.runtime.scheduler.reconcile();
  const renamed=c.runtime.scheduler.upsert({name:'B1 yeniden adlandırılan kontrol',agent_id:a.id,instruction:t.instruction,timing:t.timing},t.id);await c.runtime.scheduler.ensureTask(renamed,true);
  const data=await c.runtime.notebook.data(a.id),task=data.tasks.find(task=>task.uid===uid)!;assert.equal(data.tasks.length,1);assert.equal(task.name,'Zamanlanmış: B1 yeniden adlandırılan kontrol');assert.match(task.description || task.note || '',/İkinci doğrulanmış/);assert.equal(c.runtime.scheduler.history(t.id).filter(h=>h.state==='completed').length,2);assert.equal(c.store.messages().filter(m=>m.text.startsWith('Zamanlanmış:')).length,2);
  await c.office.removeAgent(aid,true);assert.equal(c.office.pendingDeletions().length,0,"The test account must be deleted.");aid=undefined;assert.equal(await c.office.tududi.findUser(email),null);verified=true;
 }finally{
  if(aid && c.store.agent(aid))await c.office.removeAgent(aid,true);
  await c.app.close();cleanup(config);mkdirSync('.test-data',{recursive:true});writeFileSync('.test-data/b1-live.json',JSON.stringify({verified,accountRemoved:aid===undefined,providerCall:false},null,2)+'\n');
 }
});
