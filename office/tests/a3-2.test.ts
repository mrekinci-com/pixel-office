import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { defaultPolicy, defaultSettings, PROTOCOL_VERSION } from '../shared/runtime.js';
import { dayStart, officeDay, previousDay } from '../shared/time.js';
import { messageResponses } from '../src/chat/model.js';
import { cleanup, fakeTududi, input, testConfig } from './helpers.js';
async function setup() {
  const config={...testConfig(),runnerKey:'a3-2-test-'.repeat(5)};
  const fake=fakeTududi(),ctx=await createApp(config,{fetcher:fake.fetcher,background:false}),did=randomUUID();
  ctx.store.db.prepare('INSERT INTO departments(id,name,description,color,sort_order) VALUES (?,?,?,?,?)').run(did,'Ekip','','#498f87',0);
  const a=await ctx.office.createAgent(input(did));ctx.runtime.heartbeat('runner');
  const login=await ctx.app.inject({url:'/api/login',method:'POST',headers:{'x-ofis-islem':'1'},payload:{password:config.ownerPassword}});
  const headers={cookie:String(login.headers['set-cookie']).split(';')[0],'x-ofis-islem':'1'};
  const api=(url:string,method:any='GET',payload?:any)=>ctx.app.inject({url,method,headers,payload});
  const claim=()=>ctx.app.inject({url:'/api/runner/claim',method:'POST',headers:{authorization:`Bearer ${config.runnerKey}`},payload:{id:'runner'}});
  return {...ctx,config,fake,a,did,api,claim,close:async()=>{await ctx.app.close();cleanup(config);}};
}
for(const mode of ['single','persistent','work'] as const) test(`A3.2: ${mode} input has four information headings; tools use the same account and project filter`,async()=>{
  const c=await setup();try {
    c.store.db.prepare('UPDATE agents SET session_mode=? WHERE id=?').run(mode,c.a.id);
    const token=c.office.token(c.a.id),project=c.a.workbook_uid!,titles=['Harita','Kararlar','Bilinen kusurlar','Nasıl yapılır'];
    for(const title of titles)await c.runtime.notebook.upsert(c.a.id,title,'Girdiye tamamı alınmaması gereken uzun bilgi',project);
    await c.office.tududi.note(token,{title:'Başka proje',content:'Ayrı not',project_uid:'other'});
    c.runtime.enqueue(c.a.id,'Elle','Bilgi notu başlıkları neler?');
    const response=await c.claim();assert.equal(response.statusCode,200);const lease=response.json();
    for(const title of titles)assert.ok(lease.prompt.includes(title),`${mode}: ${title}`);
    assert.ok(!lease.prompt.includes('Girdiye tamamı alınmaması gereken uzun bilgi'));
    const result=await c.runtime.tool(lease.run,'tududi_notlar',{proje:project}) as {title:string}[];
    for(const title of titles)assert.equal(result.filter(n=>n.title===title).length,1);
    assert.ok(!result.some(n=>n.title==='Başka proje'));assert.equal((await c.runtime.tool(lease.run,'tududi_notlar',{}) as unknown[]).length,result.length+1);
  }finally{await c.close();}
});
test("A3.2: daily token cap keeps messages queued, explains settings in two places and resumes after an increase",async()=>{
  const c=await setup();try {
    const done=c.runtime.enqueue(c.a.id,'Elle','Önceki iş')!;c.runtime.claim('runner');c.runtime.finish(done.id,'completed','','');
    c.store.db.prepare('UPDATE runs SET usage=? WHERE id=?').run(JSON.stringify({input_tokens:5300000}),done.id);
    const message=c.office.message(null,'agent',c.a.id,'Bekleyen mesaj');assert.equal(c.runtime.claim('runner'),null);
    const snapshot={...c.store.snapshot(),runtime:c.runtime.snapshot()},status=messageResponses(message,snapshot)[0];
    assert.match(status.text,/Günlük token tavanı doldu \(5.300.000 \/ 750.000\).*ağırlıklı/);assert.equal(status.setting,'usage');
    assert.equal(snapshot.runtime.queueBlocks![0].reason,status.text);assert.equal(snapshot.runtime.dailyUsage!.input_tokens,5300000);
    assert.equal((await c.api('/api/runtime/settings','PUT',{...defaultSettings,language:'tr',dailyTokenBudget:6000000})).statusCode,200);
    assert.equal(c.runtime.claim('runner')?.run.message_id,message.id);
  }finally{await c.close();}
});
test("A3.2: agent daily cap preserves work and allows other agents; a new day releases queued work",async t=>{
  const c=await setup();try {
    t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-12T20:59:00Z')});c.runtime.heartbeat('runner');
    c.store.db.prepare('UPDATE agents SET policy=? WHERE id=?').run(JSON.stringify({...defaultPolicy,dailyRuns:1}),c.a.id);
    c.runtime.enqueue(c.a.id,'Elle','İlk');const first=c.runtime.claim('runner')!;c.runtime.finish(first.run.id,'completed','','');
    const queued=c.runtime.enqueue(c.a.id,'Elle','Yarın devam')!;assert.equal(queued.state,'queued');assert.match(queued.reason,/ajan günlük çalışma sınırı/);
    const b=await c.office.createAgent({...input(c.did),name:'Diğer ajan'});c.runtime.enqueue(b.id,'Elle','Bağımsız iş');const other=c.runtime.claim('runner')!;assert.equal(other.agent.id,b.id);c.runtime.finish(other.run.id,'completed','','');
    t.mock.timers.setTime(Date.parse('2026-10-12T21:00:00Z'));c.runtime.heartbeat('runner');assert.equal(c.runtime.claim('runner')?.run.id,queued.id);
  }finally{await c.close();t.mock.timers.reset();}
});
test("A3.2: provider pauses, disconnections and version mismatches appear as queue reasons",async()=>{
  const c=await setup();try {
    c.runtime.enqueue(c.a.id,'Elle','İş');c.runtime.a3.pause('codex','Deneme kotası',null);
    assert.match(c.runtime.snapshot().queueBlocks![0].reason,/sağlayıcısı duraklatıldı/);assert.equal(c.runtime.claim('runner'),null);
    c.runtime.a3.resume('codex');c.runtime.disconnect('runner');assert.match(c.runtime.snapshot().queueBlocks![0].reason,/Çalıştırıcı bağlı değil/);
    assert.throws(()=>c.runtime.heartbeat('runner',undefined,2,undefined,undefined,false,PROTOCOL_VERSION-1));assert.match(c.runtime.snapshot().queueBlocks![0].reason,/sürümü uyumsuz/);
    c.runtime.heartbeat('runner');assert.ok(c.runtime.claim('runner'));
  }finally{await c.close();}
});
test("A3.2: Istanbul and DST day boundaries; usage after 21:00 UTC belongs to the new day",async t=>{
  assert.equal(officeDay('2026-10-12T21:00:00Z'),'2026-10-13');assert.equal(dayStart('2026-10-13').toISOString(),'2026-10-12T21:00:00.000Z');
  assert.equal(+dayStart('2026-03-09','America/New_York')-+dayStart('2026-03-08','America/New_York'),23*3600000);
  assert.equal(+dayStart('2026-11-02','America/New_York')-+dayStart('2026-11-01','America/New_York'),25*3600000);assert.equal(previousDay('2026-03-01'),'2026-02-28');
  const c=await setup();try {
    t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-12T20:59:00Z')});c.runtime.heartbeat('runner');
    c.runtime.enqueue(c.a.id,'Elle','Dünkü iş');const old=c.runtime.claim('runner')!;c.runtime.finish(old.run.id,'completed','','',{input_tokens:100});
    c.runtime.log(old.run.id,'tool_success','tududi_not_oku: dünkü okuma');
    assert.equal(c.runtime.totals().input_tokens,100);t.mock.timers.setTime(Date.parse('2026-10-12T21:01:00Z'));c.runtime.heartbeat('runner');
    c.runtime.enqueue(c.a.id,'Elle','Yeni gün');const fresh=c.runtime.claim('runner')!;c.runtime.finish(fresh.run.id,'completed','','',{input_tokens:200});
    c.runtime.log(fresh.run.id,'tool_success','tududi_not_oku: yeni gün okuma');
    assert.equal((await c.api('/api/usage')).json().find((r:any)=>r.id===c.a.id).notes_read,1);
    assert.equal(c.runtime.totals().input_tokens,200);assert.equal(c.runtime.totals(undefined,7).input_tokens,300);
    const details=(await c.api('/api/usage/details')).json();assert.equal(details.days.find((d:any)=>d.day==='2026-10-13').input_tokens,200);assert.match(c.runtime.a3.summary('2026-10-13').text,/200 girdi token/);
    assert.equal((await c.api('/api/runtime/settings','PUT',{...defaultSettings,language:'tr',timeZone:'Yanlış/Dilim'})).statusCode,400);
  }finally{await c.close();t.mock.timers.reset();}
});
test("A3.2: chat tasks and notes hide raw IDs and survive stale-link cleanup",async()=>{
  const c=await setup();try {
    c.office.message(null,'agent',c.a.id,'İstenilen açıklama');const lease=c.runtime.claim('runner')!;
    const item=await c.runtime.notebook.prepareWork(lease.run),key=c.office.token(c.a.id);
    let task=(await c.office.tududi.read(key)).tasks.find(t=>t.uid===item.task_uid)!;
    assert.match(task.description!,/İstenilen açıklama/);assert.match(task.description!,/Ofis sohbetinden/);assert.ok(!task.description!.includes(String(item.id)));
    await c.runtime.notebook.writeWork(lease.run,'Doğrulandı');task=(await c.office.tududi.read(key)).tasks.find(t=>t.uid===item.task_uid)!;assert.ok(!task.note!.includes('[Ofis işi:'));
    const id=`${c.a.id}:chat:agent:${c.a.id}:2026-10-11`,legacy=await c.office.tududi.task(key,{name:'Eski iş',description:`Sahibin açıklaması\n[Ofis işi: ${id}]`});
    await c.runtime.notebook.poll(true);const cleaned=(await c.office.tududi.read(key)).tasks.find(t=>t.uid===legacy.uid)!;
    assert.equal(cleaned.note,'Sahibin açıklaması\nOfis sohbetinden · 11 Eki');assert.equal(c.store.db.prepare('SELECT task_uid FROM work_items WHERE id=?').get(id)?.task_uid,legacy.uid);
  }finally{await c.close();}
});
test("A3.2: profiles start in Turkish, migrate once and reapply after a timezone change",async()=>{
  const c=await setup();try {
    const key='Bearer '+c.office.token(c.a.id);assert.deepEqual(c.fake.profiles.get(key),{language:'tr',timezone:'Europe/Istanbul'});
    const count=()=>c.fake.calls.filter(call=>call.path==='/api/profile' && call.method==='PATCH').length,before=count();
    await c.runtime.notebook.poll(true);await c.runtime.notebook.poll(true);assert.equal(count(),before);
    c.store.db.prepare('DELETE FROM tududi_profiles').run();await c.runtime.notebook.poll(true);assert.equal(count(),before);
    c.fake.profiles.set(key,{language:'en',timezone:'UTC'});c.store.db.prepare('DELETE FROM tududi_profiles').run();await c.runtime.notebook.poll(true);assert.equal(count(),before+1);
    assert.equal((await c.api('/api/runtime/settings','PUT',{...defaultSettings,language:'tr',timeZone:'Europe/Berlin'})).statusCode,200);assert.deepEqual(c.fake.profiles.get(key),{language:'tr',timezone:'Europe/Berlin'});
    const applied=count();await c.runtime.notebook.poll(true);assert.equal(count(),applied);
  }finally{await c.close();}
});
