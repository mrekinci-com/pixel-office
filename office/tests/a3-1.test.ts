import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { Store } from '../server/db.js';
import { defaultPolicy, defaultSettings, usageTotals } from '../shared/runtime.js';
import { cleanup, fakeTududi, input, testConfig } from './helpers.js';

async function setup() {
  const config={...testConfig(),runnerKey:'yalniz-a3-1-test-'.repeat(4)};
  const fake=fakeTududi(),ctx=await createApp(config,{fetcher:fake.fetcher}),did=randomUUID();
  ctx.store.db.prepare('INSERT INTO departments(id,name,description,color,sort_order) VALUES (?,?,?,?,?)').run(did,'Ekip','','#498f87',0);
  const a=await ctx.office.createAgent(input(did)),b=await ctx.office.createAgent({...input(did),name:'İnceleyici'});
  ctx.runtime.heartbeat('runner');
  const login=await ctx.app.inject({method:'POST',url:'/api/login',headers:{'x-ofis-islem':'1'},payload:{password:config.ownerPassword}});
  const headers={cookie:String(login.headers['set-cookie']).split(';')[0],'x-ofis-islem':'1'};
  const api=(url:string,method:any='GET',payload?:any)=>ctx.app.inject({url,method,headers,payload});
  return {...ctx,config,fake,a,b,api,close:async()=>{await ctx.app.close();cleanup(config);}};
}

test("A3.1: separate sessions per task; returning to old work and reviewer feedback preserve identity",async()=>{
  const c=await setup();try {
    const root=c.runtime.enqueue(c.a.id,'Elle','Birinci iş')!,one=c.runtime.claim('runner')!,provider=randomUUID();
    c.runtime.a3.recordSession(one.run,provider,100);
    await c.runtime.tool(one.run,'is_notu_yaz',{metin:'Birinci işin doğrulanan notu'});
    c.runtime.finish(root.id,'completed','Birinci sonuç','',{input_tokens:100,cached_input_tokens:60});
    c.runtime.enqueue(c.a.id,'Elle','İkinci ayrı iş');const two=c.runtime.claim('runner')!;
    assert.notEqual(two.session?.session_key,one.session?.session_key);assert.equal(two.session?.provider_id,null);
    assert.ok(!two.prompt.includes('Birinci işin doğrulanan notu'));assert.ok(!two.prompt.includes('Birinci sonuç'));
    c.runtime.a3.recordSession(two.run,randomUUID(),50);c.runtime.finish(two.run.id,'completed','İkinci sonuç','');
    const message=(await c.api(`/api/agents/${c.a.id}/session/input`,'POST',{text:'Birinci işe devam',session_key:one.session!.session_key})).json();
    const next=c.runtime.claim('runner')!;
    assert.equal(next.run.message_id,message.id);assert.equal(next.session?.provider_id,provider);
    assert.match(next.prompt,/Birinci işin doğrulanan notu/);c.runtime.finish(next.run.id,'completed','','');
    const review=c.runtime.enqueue(c.b.id,'İnceleme','Birinci işi incele',c.runtime.run(root.id))!;
    const reviewer=c.runtime.claim('runner')!;assert.equal(reviewer.run.id,review.id);
    await c.runtime.tool(reviewer.run,'mesaj_gonder',{kime:c.a.id,metin:'İnceleyici geri bildirimi',cevap_bekleniyor:true});
    c.runtime.finish(review.id,'completed','','');const feedback=c.runtime.claim('runner')!;
    assert.equal(feedback.session?.provider_id,provider);assert.equal(feedback.run.work_item_id,one.run.work_item_id || c.runtime.run(root.id).work_item_id);
  }finally{await c.close();}
});

test("A3.1: completion preserves the final note; new input for closed work opens a fresh session",async()=>{
  const c=await setup();try {
    c.runtime.enqueue(c.a.id,'Elle','Tamamlanacak iş');const first=c.runtime.claim('runner')!;
    c.runtime.a3.recordSession(first.run,randomUUID(),100);
    const item=await c.runtime.notebook.prepareWork(first.run);
    await c.runtime.tool(first.run,'tududi_gorev_guncelle',{gorev:item.task_uid,durum:2});
    await c.runtime.tool(first.run,'is_notu_yaz',{metin:'Son doğrulama: iş tamamlandı, dosya sonuc.txt'});
    c.runtime.finish(first.run.id,'completed','Tamamlandı','');
    const old=c.runtime.a3.session(c.a.id);assert.equal(old.closed,true);
    await c.api(`/api/agents/${c.a.id}/session/input`,'POST',{text:'Bu işe ek düzeltme',session_key:old.session_key});
    const next=c.runtime.claim('runner')!;assert.equal(next.session?.provider_id,null);
    assert.ok(next.session!.generation>old.generation);assert.equal(next.session?.work_item_id,old.work_item_id);
    assert.match(next.prompt,/Son doğrulama: iş tamamlandı/);
    assert.equal(c.store.db.prepare('SELECT close_requested FROM work_items WHERE id=?').get(old.work_item_id!)!.close_requested,0);
  }finally{await c.close();}
});

test("A3.1: failed summary after 24 idle hours does not close the session",async()=>{
  const c=await setup();try {
    c.runtime.enqueue(c.a.id,'Elle','Bekleyen iş');const first=c.runtime.claim('runner')!;
    c.runtime.a3.recordSession(first.run,randomUUID(),100);c.runtime.finish(first.run.id,'completed','','');
    const old=c.runtime.a3.session(c.a.id);old.last_input_at=new Date(Date.now()-86400001).toISOString();c.runtime.a3.saveSession(old);
    c.runtime.reap();const summary=c.runtime.claim('runner')!;assert.equal(summary.run.trigger,'İş oturumu kapanış hazırlığı');
    c.runtime.finish(summary.run.id,'completed','Not yazıldı iddiası','');
    assert.equal(c.runtime.a3.session(c.a.id).closed,undefined);assert.equal(c.runtime.a3.session(c.a.id).renew_error,true);
    const count=c.runtime.runs().length;c.runtime.reap();assert.equal(c.runtime.runs().length,count);
    await c.api(`/api/agents/${c.a.id}/session/renew`,'POST',{});const retry=c.runtime.claim('runner')!;
    await c.runtime.tool(retry.run,'hafiza_yaz',{metin:'Doğrulanan bilgi'});await c.runtime.tool(retry.run,'is_notu_yaz',{metin:'Son iş notu'});
    c.runtime.finish(retry.run.id,'completed','','');assert.equal(c.runtime.a3.session(c.a.id).provider_id,null);
  }finally{await c.close();}
});

test("A3.1: idle closure requires a successful note; incoming work reopens with that note",async()=>{
  const c=await setup();try {
    c.runtime.enqueue(c.a.id,'Elle','Sessiz iş');const first=c.runtime.claim('runner')!;
    c.runtime.a3.recordSession(first.run,randomUUID(),10);c.runtime.finish(first.run.id,'completed','','');
    const old=c.runtime.a3.session(c.a.id);old.last_input_at=new Date(Date.now()-86400001).toISOString();c.runtime.a3.saveSession(old);
    await c.api(`/api/agents/${c.a.id}/session/input`,'POST',{text:'Gecikmiş devam',session_key:old.session_key});
    assert.equal(c.runtime.claim('runner'),null);const closing=c.runtime.claim('runner')!;
    assert.equal(closing.run.trigger,'İş oturumu kapanış hazırlığı');assert.equal(closing.session?.provider_id,old.provider_id);
    await c.runtime.tool(closing.run,'is_notu_yaz',{metin:'Gecikmeden önce son doğrulanan durum'});c.runtime.finish(closing.run.id,'completed','','');
    assert.equal(c.runtime.a3.session(c.a.id).closed,true);
    const next=c.runtime.claim('runner')!;assert.equal(next.session?.provider_id,null);assert.match(next.prompt,/Gecikmeden önce son doğrulanan durum/);
  }finally{await c.close();}
});

test("A3.1: thresholds use the last input rather than history; agent limits override Office limits",async()=>{
  const c=await setup();try {
    c.store.db.prepare('UPDATE agents SET policy=? WHERE id=?').run(JSON.stringify({...defaultPolicy,sessionTokenLimit:150,sessionTurnLimit:12}),c.a.id);
    const root=c.runtime.enqueue(c.a.id,'Elle','Eşik işi')!;let lease=c.runtime.claim('runner')!;
    c.runtime.a3.recordSession(lease.run,randomUUID(),10);c.runtime.finish(lease.run.id,'completed','','',{input_tokens:150,context_input_tokens:150});
    c.runtime.enqueue(c.a.id,'Devam','İkinci',c.runtime.run(root.id),undefined,false);lease=c.runtime.claim('runner')!;
    assert.ok(lease);c.runtime.finish(lease.run.id,'completed','','',{input_tokens:150,context_input_tokens:150});
    assert.equal(c.runtime.a3.session(c.a.id).input_tokens,300);
    c.runtime.enqueue(c.a.id,'Devam','Üçüncü',c.runtime.run(root.id),undefined,false);lease=c.runtime.claim('runner')!;
    c.runtime.finish(lease.run.id,'completed','','',{input_tokens:151,context_input_tokens:151});
    c.runtime.enqueue(c.a.id,'Devam','Dördüncü',c.runtime.run(root.id),undefined,false);assert.equal(c.runtime.claim('runner'),null);
    const summary=c.runtime.claim('runner')!;assert.equal(summary.run.trigger,'Oturum yenileme hazırlığı');
    await c.runtime.tool(summary.run,'hafiza_yaz',{metin:'Doğrulanan özet'});await c.runtime.tool(summary.run,'is_notu_yaz',{metin:'Eşik işi devam ediyor'});
    c.runtime.finish(summary.run.id,'completed','','');lease=c.runtime.claim('runner')!;
    assert.equal(lease.session?.provider_id,null);assert.match(lease.prompt,/Eşik işi devam ediyor/);
  }finally{await c.close();}
});

test("A3.1: retry over-budget work once in a fresh session; late results do not revive it",async()=>{
  const c=await setup();try {
    c.store.db.prepare('UPDATE agents SET policy=? WHERE id=?').run(JSON.stringify({...defaultPolicy,inputTokenBudget:100}),c.a.id);
    const message=c.office.message(null,'agent',c.a.id,'Bütçe denemesi'),first=c.runtime.claim('runner')!;
    c.runtime.a3.recordSession(first.run,randomUUID(),10);
    await c.runtime.tool(first.run,'is_notu_yaz',{metin:'Bütçe öncesi doğrulanan iş notu'});
    c.runtime.update(first.run.id,'usage','Kullanım',{input_tokens:101,cached_input_tokens:80,output_tokens:72});
    assert.equal(c.runtime.run(first.run.id).state,'budget_exceeded');const retry=c.runtime.runs().find(r=>r.state==='queued')!;
    assert.equal(retry.work_item_id,c.runtime.run(first.run.id).work_item_id);assert.equal(retry.message_id,message.id);assert.equal(retry.chain_id,first.run.chain_id);
    c.runtime.finish(first.run.id,'completed','Geç sonuç','',{input_tokens:102});assert.equal(c.runtime.runs().length,2);
    const next=c.runtime.claim('runner')!;assert.equal(next.session?.provider_id,null);assert.match(next.prompt,/Bütçe öncesi doğrulanan iş notu/);
    c.runtime.update(next.run.id,'usage','Kullanım',{input_tokens:101});assert.equal(c.runtime.run(next.run.id).state,'budget_exceeded');assert.equal(c.runtime.runs().length,2);
    const newStep=c.runtime.enqueue(c.a.id,'Yeni onay sonucu','Aynı işte yeni tetik',c.runtime.run(next.run.id),undefined,false)!;
    const newLease=c.runtime.claim('runner')!;assert.equal(newLease.run.id,newStep.id);
    c.runtime.update(newLease.run.id,'usage','Kullanım',{input_tokens:101});assert.equal(c.runtime.runs().length,4);
    const newRetry=c.runtime.runs().find(r=>r.state==='queued')!;assert.equal(newRetry.work_item_id,c.runtime.run(first.run.id).work_item_id);

  }finally{await c.close();}
});

test("A3.1: consistent provider cache accounting; weighted budgets apply to office, chain and run",async()=>{
  assert.deepEqual(usageTotals({input_tokens:100,cached_input_tokens:70,output_tokens:5}),{input_tokens:100,cached_input_tokens:70,uncached_input_tokens:30,output_tokens:5,total_tokens:105});
  assert.deepEqual(usageTotals({input_tokens:20,cache_read_input_tokens:70,cache_creation_input_tokens:10,output_tokens:5}),{input_tokens:100,cached_input_tokens:70,uncached_input_tokens:30,output_tokens:5,total_tokens:105});
  const c=await setup();try {
    c.store.db.prepare('UPDATE runtime_settings SET json=?').run(JSON.stringify({...defaultSettings,language:'tr',cachedInputWeight:0.1,dailyTokenBudget:40,chainTokenBudget:40}));
    c.store.db.prepare('UPDATE agents SET policy=? WHERE id=?').run(JSON.stringify({...defaultPolicy,inputTokenBudget:40}),c.a.id);
    c.runtime.enqueue(c.a.id,'Elle','Önbellek bütçesi');const first=c.runtime.claim('runner')!;
    c.runtime.update(first.run.id,'usage','Kullanım',{input_tokens:100,cached_input_tokens:70});assert.equal(c.runtime.run(first.run.id).state,'running');
    c.runtime.finish(first.run.id,'completed','','');const totals=c.runtime.totals(c.a.id);
    assert.equal(totals.input_tokens,100);assert.equal(totals.cached_input_tokens,70);assert.equal(totals.uncached_input_tokens,30);
    const usage=(await c.api('/api/usage')).json().find((a:any)=>a.id===c.a.id);assert.equal(usage.average_uncached_tokens,30);assert.equal(usage.average_cached_tokens,70);
    const details=(await c.api('/api/usage/details')).json();assert.equal(details.days[0].uncached_input_tokens,30);assert.equal(details.days[0].cached_input_tokens,70);
    c.runtime.enqueue(c.b.id,'Elle','Ofis bütçesinde yer var');assert.equal(c.runtime.claim('runner')!.agent.id,c.b.id);
  }finally{await c.close();}
});

test("A3.1: daily and turn limits bound free chat; new work opens a separate session",async()=>{
  const c=await setup();try {
    c.store.db.prepare('UPDATE runtime_settings SET json=?').run(JSON.stringify({...defaultSettings,language:'tr',chatTurnLimit:1}));
    c.office.message(null,'agent',c.a.id,'Serbest selam');const first=c.runtime.claim('runner')!;
    c.runtime.a3.recordSession(first.run,randomUUID(),10);c.runtime.finish(first.run.id,'completed','','');
    c.office.message(null,'agent',c.a.id,'Sohbetin devamı');assert.equal(c.runtime.claim('runner'),null);
    const closing=c.runtime.claim('runner')!;await c.runtime.tool(closing.run,'is_notu_yaz',{metin:'Serbest sohbet özeti'});c.runtime.finish(closing.run.id,'completed','','');
    const resumed=c.runtime.claim('runner')!;assert.equal(resumed.session?.provider_id,null);c.runtime.finish(resumed.run.id,'completed','','');
    await c.api(`/api/agents/${c.a.id}/session/input`,'POST',{text:'Ayrı yeni iş',mode:'new'});
    const newJob=c.runtime.claim('runner')!;assert.notEqual(newJob.session?.session_key,first.session?.session_key);assert.equal(newJob.session?.provider_id,null);
  }finally{await c.close();}
});

test("A3.1: migration updates legacy defaults while preserving custom thresholds and work notes",async()=>{
  const c=await setup();
  const oldId=c.a.id,otherId=c.b.id;
  try {
    c.runtime.writeMemory(oldId,'Kalıcı bilgi');c.runtime.enqueue(oldId,'Elle','Korunan iş');const run=c.runtime.claim('runner')!;
    await c.runtime.tool(run.run,'is_notu_yaz',{metin:'Korunan iş notu'});c.runtime.finish(run.run.id,'completed','','');
    c.store.db.exec(`DROP TABLE factory_resets; DROP TABLE reset_gate; ALTER TABLE runtime_settings DROP COLUMN language_initialized; ALTER TABLE runtime_settings DROP COLUMN email_domain_seeded; DROP TABLE director_followups; ALTER TABLE runs DROP COLUMN director_followup; ALTER TABLE runs DROP COLUMN context_peak; DROP TABLE director_terminal; DROP TABLE director_actions; DROP TABLE director_redirects; DROP TABLE director_watches; DROP TABLE director_events; DROP TABLE director_state; DROP TABLE office_trash; DROP TABLE dismissed_notices; DROP INDEX agents_builtin; ALTER TABLE agents DROP COLUMN builtin; ALTER TABLE agents DROP COLUMN tool_groups; ALTER TABLE agents DROP COLUMN deleted_at; ALTER TABLE departments DROP COLUMN deleted_at; ALTER TABLE runs DROP COLUMN work_options; ALTER TABLE runs DROP COLUMN director_auto; DROP TABLE agent_sessions;
      CREATE TABLE agent_sessions(agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,json TEXT NOT NULL);
      ALTER TABLE runs DROP COLUMN budget_retry; ALTER TABLE runs DROP COLUMN parent_run_id;
      ALTER TABLE work_items DROP COLUMN close_requested; DROP TABLE tududi_profiles; DROP TABLE schedule_retirements; DROP TABLE schedule_history; DROP TABLE scheduled_tasks; ALTER TABLE runs DROP COLUMN scheduled_task_id; ALTER TABLE chains DROP COLUMN scheduled_token_budget; DELETE FROM migrations WHERE version>=10;
      UPDATE agents SET session_mode='persistent';`);
    c.store.db.prepare('INSERT INTO agent_sessions VALUES (?,?)').run(oldId,JSON.stringify({agent_id:oldId,runner:'codex',generation:4,provider_id:randomUUID(),turns:9,input_tokens:123,created_at:new Date().toISOString(),renewals:0,bytes:0,rules_hash:'',renewing:false}));
    c.store.db.prepare('UPDATE agents SET policy=? WHERE id=?').run(JSON.stringify({...defaultPolicy,sessionTurnLimit:7}),otherId);
    c.store.db.prepare('UPDATE runtime_settings SET json=?').run(JSON.stringify({...defaultSettings,language:'tr',sessionTurnLimit:100,sessionTokenLimit:3000000}));
    await c.app.close();
    const reopened=new Store(c.config.dataDir);
    try {
      assert.equal(reopened.agent(oldId)!.session_mode,'work');assert.equal(reopened.agent(otherId)!.policy!.sessionTurnLimit,7);
      const settings=JSON.parse(reopened.db.prepare('SELECT json FROM runtime_settings').get()!.json as string);
      assert.equal(settings.sessionTurnLimit,12);assert.equal(settings.sessionTokenLimit,150000);
      assert.equal(reopened.db.prepare('SELECT text FROM memories WHERE agent_id=?').get(oldId)!.text,'Kalıcı bilgi');
      assert.match(String(reopened.db.prepare('SELECT note FROM work_items WHERE agent_id=?').get(oldId)!.note),/Korunan iş notu/);
      const session=JSON.parse(reopened.db.prepare('SELECT json FROM agent_sessions').get()!.json as string);assert.equal(session.closed,true);assert.equal(session.generation,4);
    }finally{reopened.close();}
  }finally{await c.app.close();cleanup(c.config);}
});

test("A3.1: owner-closed work requests a closing note after the previous note",async()=>{
  const c=await setup();try {
    c.runtime.enqueue(c.a.id,'Elle','Sahibin kapatacağı iş');const run=c.runtime.claim('runner')!;
    c.runtime.a3.recordSession(run.run,randomUUID(),10);const item=await c.runtime.notebook.prepareWork(run.run);
    await c.runtime.tool(run.run,'is_notu_yaz',{metin:'Kapanmadan önceki not'});
    assert.equal((await c.api(`/api/agents/${c.a.id}/tasks/${item.task_uid}`,'PATCH',{status:2})).statusCode,200);
    c.runtime.finish(run.run.id,'completed','','');assert.notEqual(c.runtime.a3.session(c.a.id).closed,true);
    const closing=c.runtime.claim('runner')!;assert.equal(closing.run.trigger,'İş oturumu kapanış hazırlığı');
    await c.runtime.tool(closing.run,'is_notu_yaz',{metin:'Sahibin kapanışından sonra doğrulanan son durum'});c.runtime.finish(closing.run.id,'completed','','');
    assert.equal(c.runtime.a3.session(c.a.id).closed,true);
  }finally{await c.close();}
});

test("A3.1: two handoffs in one chain open separate tasks/sessions; old closure cannot close new work",async()=>{
  const c=await setup();try {
    c.runtime.enqueue(c.a.id,'Elle','Kök iş');const root=c.runtime.claim('runner')!;
    const first=await c.runtime.tool(root.run,'gorev_devret',{kime:c.b.id,baslik:'Birinci devir',aciklama:'İlk görev'}) as {id:string};
    const second=await c.runtime.tool(root.run,'gorev_devret',{kime:c.b.id,baslik:'İkinci devir',aciklama:'Ayrı görev'}) as {id:string};
    c.runtime.finish(root.run.id,'completed','','');
    const one=c.runtime.claim('runner')!;c.runtime.a3.recordSession(one.run,randomUUID(),10);await c.runtime.notebook.prepareWork(one.run);c.runtime.finish(one.run.id,'completed','','');
    const two=c.runtime.claim('runner')!;c.runtime.a3.recordSession(two.run,randomUUID(),10);await c.runtime.notebook.prepareWork(two.run);c.runtime.finish(two.run.id,'completed','','');
    assert.equal(one.run.handoff_id,first.id);assert.equal(two.run.handoff_id,second.id);assert.notEqual(one.session!.session_key,two.session!.session_key);
    const item=c.store.db.prepare('SELECT task_uid FROM work_items WHERE id=?').get(one.session!.work_item_id!)!;
    await c.api(`/api/agents/${c.b.id}/tasks/${item.task_uid}`,'PATCH',{status:3});const closing=c.runtime.claim('runner')!;
    assert.equal(closing.session!.session_key,one.session!.session_key);
    await c.runtime.tool(closing.run,'is_notu_yaz',{metin:'Birinci iş yapılamadı; doğrulanan engel kaydedildi.'});c.runtime.finish(closing.run.id,'completed','','');
    assert.equal(c.runtime.a3.sessions().find(s=>s.session_key===one.session!.session_key)!.closed,true);
    assert.notEqual(c.runtime.a3.sessions().find(s=>s.session_key===two.session!.session_key)!.closed,true);
  }finally{await c.close();}
});

test("A3.1: direct and general free chat use different daily sessions",async()=>{
  const c=await setup();try {
    c.office.message(null,'agent',c.a.id,'Yalnız birebir konuşmadaki bilgi');const privateRun=c.runtime.claim('runner')!,privateId=randomUUID();
    c.runtime.a3.recordSession(privateRun.run,privateId,10);c.runtime.finish(privateRun.run.id,'completed','','');
    c.office.message(null,'everyone',null,`@${c.a.name} genel konuşmadaki yeni istek`);const publicRun=c.runtime.claim('runner')!;
    assert.equal(publicRun.session!.provider_id,null);assert.notEqual(publicRun.session!.session_key,privateRun.session!.session_key);assert.ok(!publicRun.prompt.includes('Yalnız birebir konuşmadaki bilgi'));
    c.runtime.a3.recordSession(publicRun.run,randomUUID(),10);c.runtime.finish(publicRun.run.id,'completed','','');
    c.office.message(null,'agent',c.a.id,'Birebir konuşmaya devam');const continued=c.runtime.claim('runner')!;
    assert.equal(continued.session!.provider_id,privateId);assert.equal(continued.session!.session_key,privateRun.session!.session_key);
  }finally{await c.close();}
});
