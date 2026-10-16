import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import {testConfig,fakeTududi,input,cleanup} from './helpers.js';
import {nextTimes,wallTime} from '../shared/schedules.js';
import {defaultSettings,defaultPolicy} from '../shared/runtime.js';
const zone='Europe/Istanbul';
test("B1: five schedule types, month end, final day and one-shot schedules",()=>{
  const at=Date.parse('2026-10-12T05:00:00Z');
  assert.deepEqual(nextTimes({kind:'daily',time:'09:00'},at,zone),['2026-10-12T06:00:00.000Z','2026-10-13T06:00:00.000Z','2026-10-14T06:00:00.000Z']);
  assert.deepEqual(nextTimes({kind:'weekly',time:'09:00',days:[1,3]},at,zone),['2026-10-12T06:00:00.000Z','2026-10-14T06:00:00.000Z','2026-10-19T06:00:00.000Z']);
  assert.deepEqual(nextTimes({kind:'interval',hours:3,start:9,end:18},at,zone),['2026-10-12T06:00:00.000Z','2026-10-12T09:00:00.000Z','2026-10-12T12:00:00.000Z']);
  assert.deepEqual(nextTimes({kind:'monthly',time:'09:00',day:31},Date.parse('2026-02-01T00:00:00Z'),zone),['2026-03-31T06:00:00.000Z','2026-05-31T06:00:00.000Z','2026-07-31T06:00:00.000Z']);
  assert.deepEqual(nextTimes({kind:'once',time:'09:00',date:'2026-10-12'},at,zone),['2026-10-12T06:00:00.000Z']);
  assert.equal(nextTimes({kind:'daily',time:'09:00'},at,zone,'2026-10-12').length,1);
});
test("B1: DST skips missing hours and runs repeated hours once",()=>{
  assert.equal(wallTime('2026-03-29','02:30','Europe/Berlin'),null);
  assert.equal(new Date(wallTime('2026-10-25','02:30','Europe/Berlin')!).toISOString(),'2026-10-25T00:30:00.000Z');
  assert.deepEqual(nextTimes({kind:'daily',time:'02:30'},Date.parse('2026-03-28T02:00:00Z'),'Europe/Berlin'),['2026-03-30T00:30:00.000Z','2026-03-31T00:30:00.000Z','2026-04-01T00:30:00.000Z']);
  assert.equal(nextTimes({kind:'daily',time:'02:30'},Date.parse('2026-10-25T00:30:00Z'),'Europe/Berlin',null,1)[0],'2026-10-26T01:30:00.000Z');
});
async function setup(){let at=Date.parse('2026-10-12T05:59:00Z');const config=testConfig(),fake=fakeTududi(),c=await createApp(config,{fetcher:fake.fetcher,background:false,scheduleClock:()=>at});const dept=randomUUID();c.store.db.prepare('INSERT INTO departments(id,name,description,color,sort_order) VALUES (?,?,?,?,?)').run(dept,'Ekip','','#498f87',0);const agent=await c.office.createAgent({...input(dept),session_mode:'persistent'});c.runtime.heartbeat('fake');
  const task=(overrides={})=>c.runtime.scheduler.upsert({name:'Rutin kontrol',agent_id:agent.id,instruction:'Kaynakları gözden geçir.',timing:{kind:'daily',time:'09:00'},...overrides});
  const advance=(value:string)=>{at=Date.parse(value);c.runtime.heartbeat('fake');c.runtime.scheduler.tick();};
  return {...c,config,fake,agent,task,advance,close:async()=>{await c.app.close();cleanup(config);}};
}
test("B1: due tasks use fresh sessions, quiet results, persistent notes, history and daily summaries",async()=>{const c=await setup();try{
 const t=c.task({attention_only:true});c.runtime.writeMemory(c.agent.id,'Bu uzun oturum hafızası zamanlanmış işe taşınmasın.');
 c.advance('2026-10-12T06:00:00Z');const lease=c.runtime.claim('fake')!;assert.ok(lease);assert.equal(lease.session,undefined);assert.ok(!lease.prompt.includes('Bu uzun oturum hafızası'));assert.equal(lease.run.trigger,'Zamanlanmış görev: Rutin kontrol');assert.ok(lease.prompt.includes('SESSIZ'));assert.equal(lease.run.work_item_id,'schedule:'+t.id);
 await c.runtime.tool(lease.run,'is_notu_yaz',{metin:'Doğrulandı: bugün değişiklik yok.'});const item=c.store.db.prepare('SELECT task_uid FROM work_items WHERE id=?').get('schedule:'+t.id)!;
 c.runtime.finish(lease.run.id,'completed','SESSIZ: değişiklik yok','',{input_tokens:400,output_tokens:10});c.runtime.scheduler.reconcile();assert.equal(c.store.messages().length,0);assert.equal(c.runtime.scheduler.history(t.id)[0].state,'silent');
 c.advance('2026-10-13T06:00:00Z');const second=c.runtime.claim('fake')!;assert.equal(second.session,undefined);assert.ok(second.prompt.includes('Doğrulandı: bugün değişiklik yok.'));
 await c.runtime.tool(second.run,'is_notu_yaz',{metin:'Yeni durum doğrulandı.'});assert.equal(c.store.db.prepare('SELECT task_uid FROM work_items WHERE id=?').get('schedule:'+t.id)!.task_uid,item.task_uid);
 const data=await c.runtime.notebook.data(c.agent.id);assert.equal(data.tasks.length,1);assert.equal(data.tasks[0].name,'Zamanlanmış: Rutin kontrol');
 c.runtime.finish(second.run.id,'completed','Dikkat: yeni bilgi var.','',{input_tokens:600,output_tokens:20});c.runtime.scheduler.reconcile();const m=c.store.messages().at(-1)!;assert.equal(m.recipient_id,c.agent.id);assert.equal(m.owner_only,true);assert.ok(m.text.startsWith('Zamanlanmış: Rutin kontrol'));
 const h=c.runtime.scheduler.history(t.id)[0];assert.equal(h.tokens,620);assert.equal(h.state,'completed');assert.ok(c.runtime.a3.summary('2026-10-13').text.includes('Rutin kontrol: 1 tamamlandı'));
}finally{await c.close();}});
test("B1: busy agents queue work; overlapping schedules skip; daily task limits emit one notice",async()=>{const c=await setup();try{
 const regular=c.runtime.enqueue(c.agent.id,'Elle','Başka iş')!,active=c.runtime.claim('fake')!;assert.equal(active.run.id,regular.id);
 const t=c.task({timing:{kind:'interval',hours:1,start:9,end:18},daily_limit:1});c.advance('2026-10-12T06:00:00Z');assert.equal(c.runtime.scheduler.history(t.id)[0].state,'queued');assert.equal(c.runtime.claim('fake'),null);
 c.advance('2026-10-12T07:00:00Z');assert.match(c.runtime.scheduler.history(t.id)[0].reason,/hâlâ sürüyor/);
 c.runtime.finish(active.run.id,'completed','','');const l=c.runtime.claim('fake')!;await c.runtime.tool(l.run,'is_notu_yaz',{metin:'Bitti: sonuç doğrulandı.'});c.runtime.finish(l.run.id,'completed','Bitti','');c.runtime.scheduler.reconcile();
 c.advance('2026-10-12T08:00:00Z');c.advance('2026-10-12T09:00:00Z');assert.equal(c.runtime.scheduler.history(t.id)[0].state,'skipped');assert.equal(c.store.messages().filter(m=>m.text.includes('günlük çalıştırma sınırı')).length,1);
}finally{await c.close();}});
test("B1: catch up the last missed run within six hours once; older runs stay missed",async()=>{const c=await setup();try{
 const t=c.task({timing:{kind:'interval',hours:1,start:9,end:18}});c.advance('2026-10-12T10:30:00Z');assert.equal(c.runtime.scheduler.history(t.id).filter(h=>h.run_id).length,1);assert.equal(c.runtime.scheduler.history(t.id)[0].due_at,'2026-10-12T10:00:00.000Z');c.runtime.scheduler.tick();assert.equal(c.runtime.scheduler.history(t.id).filter(h=>h.run_id).length,1);
 const old=c.task({name:'Eski',timing:{kind:'once',date:'2026-10-12',time:'14:00'}});c.advance('2026-10-13T06:00:00Z');assert.equal(c.runtime.scheduler.history(old.id)[0].state,'missed');assert.equal(c.runtime.scheduler.task(old.id).next_at,null);
}finally{await c.close();}});
test("B1: three failures deactivate a schedule",async()=>{const c=await setup();try{
 const t=c.task({timing:{kind:'interval',hours:1,start:9,end:18},token_budget:1000});
 for(const at of ['2026-10-12T06:00:00Z','2026-10-12T07:00:00Z','2026-10-12T08:00:00Z']){c.advance(at);const l=c.runtime.claim('fake')!;c.runtime.finish(l.run.id,'failed','','Deneme model hatası.');assert.equal(c.runtime.run(l.run.id).state,'failed');c.runtime.scheduler.reconcile();}
 assert.equal(c.runtime.scheduler.task(t.id).enabled,false);assert.equal(c.runtime.scheduler.task(t.id).failures,3);assert.equal(c.store.messages().filter(m=>m.text.includes('3 başarısızlık')).length,1);assert.equal(c.runtime.runs().length,3);
}finally{await c.close();}});
for(const limit of ['agent','office','provider'])test(`B1: ${limit} limit skips work and reports once`,async()=>{const c=await setup();try{
 const t=c.task();if(limit==='agent')c.store.db.prepare('UPDATE agents SET policy=? WHERE id=?').run(JSON.stringify({...defaultPolicy,dailyRuns:0}),c.agent.id);
 if(limit==='office')c.store.db.prepare('UPDATE runtime_settings SET json=? WHERE id=1').run(JSON.stringify({...defaultSettings,language:'tr',dailyTokenBudget:1}));
 if(limit==='office'){const r=c.runtime.enqueue(c.agent.id,'Elle','Önceki')!;c.runtime.finish(r.id,'completed','','',{input_tokens:2});}
 if(limit==='provider')c.runtime.a3.pause('codex','Deneme',null);
 c.advance('2026-10-12T06:00:00Z');assert.equal(c.runtime.scheduler.history(t.id)[0].state,'skipped');c.runtime.scheduler.launch(c.runtime.scheduler.task(t.id),'2026-10-12T06:01:00Z');assert.equal(c.store.messages().filter(m=>m.text.startsWith('Zamanlanmış:')).length,1);
}finally{await c.close();}});
test("B1: task API authorization, invalid dates and previews",async()=>{const c=await setup();try{
 assert.equal((await c.app.inject('/api/schedules')).statusCode,401);const login=await c.app.inject({method:'POST',url:'/api/login',headers:{'x-ofis-islem':'1'},payload:{password:c.config.ownerPassword}});const cookie=String(login.headers['set-cookie']).split(';')[0],headers={cookie,'x-ofis-islem':'1'};
 assert.equal((await c.app.inject({method:'POST',url:'/api/schedules/preview',headers,payload:{timing:{kind:'once',date:'2026-02-30',time:'09:00'}}})).statusCode,400);
 const p=await c.app.inject({method:'POST',url:'/api/schedules/preview',headers,payload:{timing:{kind:'daily',time:'09:00'}}});assert.equal(p.statusCode,200);assert.equal(p.json().times.length,3);
 assert.ok((await c.app.inject({url:'/api/session',headers})).json().build_id);
}finally{await c.close();}});

test("B1: token budgets sum chain input/output, skip work and never retry",async()=>{const c=await setup();try{
 const t=c.task({token_budget:1000});c.advance('2026-10-12T06:00:00Z');const l=c.runtime.claim('fake')!;c.runtime.update(l.run.id,'usage','',{input_tokens:800,output_tokens:250});assert.equal(c.runtime.run(l.run.id).state,'budget_exceeded');c.runtime.scheduler.reconcile();assert.equal(c.runtime.scheduler.history(t.id)[0].state,'skipped');assert.match(c.runtime.scheduler.history(t.id)[0].reason,/token bütçesi/);assert.equal(c.runtime.scheduler.task(t.id).failures,0);assert.equal(c.runtime.runs().length,1);
}finally{await c.close();}});

test("B1: restart catches up once from the persisted schedule; repeated polling does not duplicate work",async()=>{
 const c=await setup();let reopened:Awaited<ReturnType<typeof createApp>>|undefined;try{
  const t=c.task({timing:{kind:'interval',hours:1,start:9,end:18}});await c.app.close();
  reopened=await createApp(c.config,{fetcher:c.fake.fetcher,background:false,scheduleClock:()=>Date.parse('2026-10-12T09:30:00Z')});
  assert.equal(reopened.runtime.scheduler.task(t.id).next_at,'2026-10-12T06:00:00.000Z');reopened.runtime.heartbeat('yeniden');reopened.runtime.scheduler.tick();reopened.runtime.scheduler.tick();
  assert.equal(reopened.runtime.scheduler.history(t.id).filter(h=>h.run_id).length,1);assert.equal(reopened.runtime.scheduler.history(t.id)[0].due_at,'2026-10-12T09:00:00.000Z');assert.equal(reopened.runtime.scheduler.task(t.id).next_at,'2026-10-12T10:00:00.000Z');
 }finally{await reopened?.app.close();await c.close();}
});
test("B1: schedule creation prepares the notebook; polling/renaming preserves one task",async()=>{const c=await setup();try{
 const t=c.task();await c.runtime.scheduler.ensureTask(t,true);await c.runtime.scheduler.ensureTask(t,true);const before=await c.runtime.notebook.data(c.agent.id);assert.equal(before.tasks.length,1);assert.equal(before.tasks[0].name,'Zamanlanmış: Rutin kontrol');
 const edited=c.runtime.scheduler.upsert({name:'Yeni kontrol',agent_id:t.agent_id,instruction:t.instruction,timing:t.timing},t.id);await c.runtime.scheduler.ensureTask(edited,true);const after=await c.runtime.notebook.data(c.agent.id);assert.equal(after.tasks.length,1);assert.equal(after.tasks[0].uid,before.tasks[0].uid);assert.equal(after.tasks[0].name,'Zamanlanmış: Yeni kontrol');
}finally{await c.close();}});
test("B1: fresh scheduled sessions get information headings and only the work note in every session mode",async()=>{const c=await setup();try{
 for(const mode of ['work','persistent','single']){
  c.store.db.prepare('UPDATE agents SET session_mode=? WHERE id=?').run(mode,c.agent.id);c.store.db.prepare('INSERT INTO notebook_cache VALUES (?,?) ON CONFLICT(agent_id) DO UPDATE SET json=excluded.json').run(c.agent.id,JSON.stringify({tasks:[],notes:[{uid:'karar',title:'Doğrulanan karar',content:'Topluca verilmemesi gereken uzun içerik'}]}));
  const t=c.task({name:'Biçim '+mode});c.runtime.scheduler.launch(t,'2026-10-12T05:59:00Z');const l=c.runtime.claim('fake')!;assert.equal(l.session,undefined);assert.match(l.prompt,/Doğrulanan karar/);assert.ok(!l.prompt.includes('Topluca verilmemesi'));await c.runtime.tool(l.run,'is_notu_yaz',{metin:'Doğrulanmış sonuç.'});c.runtime.finish(l.run.id,'completed','Sonuç','');c.runtime.scheduler.reconcile();
 }
}finally{await c.close();}});
test("B1: daily caps reached while an agent is busy skip queued scheduled work",async()=>{const c=await setup();try{
 const regular=c.runtime.enqueue(c.agent.id,'Elle','Önceki iş')!,active=c.runtime.claim('fake')!;const t=c.task();c.advance('2026-10-12T06:00:00Z');c.runtime.finish(regular.id,'completed','','');c.store.db.prepare('UPDATE agents SET policy=? WHERE id=?').run(JSON.stringify({...defaultPolicy,dailyRuns:1}),c.agent.id);c.runtime.scheduler.tick();assert.equal(c.runtime.scheduler.history(t.id)[0].state,'skipped');assert.match(c.runtime.scheduler.history(t.id)[0].reason,/günlük çalışma sınırı/);assert.equal(c.runtime.claim('fake'),null);
}finally{await c.close();}});

test("B1: distant one-shot dates, half-hour zones and end calendars",()=>{
 assert.equal(nextTimes({kind:'once',time:'09:00',date:'2032-04-01'},Date.parse('2026-10-12T00:00:00Z'),'Europe/Istanbul')[0],'2032-04-01T06:00:00.000Z');
 assert.equal(nextTimes({kind:'daily',time:'09:00'},Date.parse('2026-10-12T00:00:00Z'),'Asia/Kolkata',null,1)[0],'2026-10-12T03:30:00.000Z');
 assert.deepEqual(nextTimes({kind:'once',time:'09:00',date:'2032-04-01'},Date.parse('2026-10-12T00:00:00Z'),zone,'2032-03-31'),[]);
});

test("B1: completion without a final status note produces neither successful history nor owner message",async()=>{const c=await setup();try{
 const t=c.task();c.advance('2026-10-12T06:00:00Z');const l=c.runtime.claim('fake')!;c.runtime.finish(l.run.id,'completed','Yapıldı iddiası','');c.runtime.scheduler.reconcile();assert.equal(c.runtime.scheduler.history(t.id)[0].state,'failed');assert.match(c.runtime.scheduler.history(t.id)[0].reason,/Son durum notu/);assert.equal(c.store.messages().length,0);
}finally{await c.close();}});
test("B1: the real claim endpoint loads information headings before the first scheduled turn",async()=>{const c=await setup();try{
 c.config.runnerKey='sahte-runner-key-'.repeat(4);await c.office.tududi.note(c.office.token(c.agent.id),{title:'Seçerek okunacak bilgi',content:'Girdiye topluca eklenmeyecek uzun içerik',project_uid:await c.office.ensureWorkbook(c.agent.id)});const t=c.task();c.advance('2026-10-12T06:00:00Z');
 const result=await c.app.inject({method:'POST',url:'/api/runner/claim',headers:{authorization:'Bearer '+c.config.runnerKey},payload:{id:'fake'}});assert.equal(result.statusCode,200);const lease=result.json();assert.match(lease.prompt,/Seçerek okunacak bilgi/);assert.ok(!lease.prompt.includes('Girdiye topluca eklenmeyecek'));assert.equal(lease.session,undefined);assert.equal(lease.run.scheduled_task_id,t.id);assert.ok(lease.task_uid);
}finally{await c.close();}});

test("B1: disconnected Tududi preserves old-task closure records and closes on reconnect",async()=>{const c=await setup();try{
 const t=c.task();await c.runtime.scheduler.ensureTask(t,true);const uid=(await c.runtime.notebook.data(c.agent.id)).tasks[0].uid;c.fake.setUnavailable(true);await assert.rejects(c.runtime.scheduler.retireTask(t));assert.equal(c.store.db.prepare('SELECT COUNT(*) AS n FROM schedule_retirements').get()!.n,1);
 c.store.db.prepare('DELETE FROM scheduled_tasks WHERE id=?').run(t.id);c.store.db.prepare('DELETE FROM work_items WHERE id=?').run('schedule:'+t.id);c.fake.setUnavailable(false);await c.runtime.scheduler.syncTasks();assert.equal(c.store.db.prepare('SELECT COUNT(*) AS n FROM schedule_retirements').get()!.n,0);assert.equal((await c.runtime.notebook.data(c.agent.id)).tasks.find(task=>task.uid===uid)!.status,2);
}finally{await c.close();}});

test("B1: decided approvals do not lock old work; fresh continuation instructions and final state persist",async()=>{const c=await setup();try{
 const t=c.task({attention_only:true});c.advance('2026-10-12T06:00:00Z');const first=c.runtime.claim('fake')!;await c.runtime.tool(first.run,'onay_iste',{baslik:'Deneme kararı',ayrinti:'Devam için karar gerekiyor.',tur:'genel'});assert.equal(c.runtime.run(first.run.id).state,'waiting');assert.equal(c.runtime.scheduler.active(t.id),true);
 c.runtime.decide(c.runtime.approvals()[0].id,false,'Bu adımı atla.');const next=c.runtime.claim('fake')!;assert.equal(next.run.scheduled_task_id,t.id);assert.equal(next.session,undefined);assert.match(next.prompt,/Kaynakları gözden geçir/);assert.match(next.prompt,/SESSIZ/);await c.runtime.tool(next.run,'is_notu_yaz',{metin:'Onay kararı sonrası doğrulanan son durum.'});c.runtime.finish(next.run.id,'completed','SESSIZ: yeni bilgi yok','');c.runtime.scheduler.reconcile();assert.equal(c.runtime.scheduler.active(t.id),false);assert.equal(c.runtime.scheduler.history(t.id)[0].state,'silent');assert.equal(c.runtime.scheduler.history(t.id)[0].result_run_id,next.run.id);
 c.advance('2026-10-13T06:00:00Z');assert.equal(c.runtime.scheduler.history(t.id)[0].state,'queued');
}finally{await c.close();}});

test("B1: late usage updates history and reports the token brake once",async()=>{const c=await setup();try{
 const t=c.task({token_budget:1000});c.advance('2026-10-12T06:00:00Z');const l=c.runtime.claim('fake')!;await c.runtime.tool(l.run,'is_notu_yaz',{metin:'Doğrulanan sonuç.'});c.runtime.finish(l.run.id,'completed','İlk görülen kullanım sınır içindeydi.','',{input_tokens:100,output_tokens:10});c.runtime.scheduler.reconcile();assert.equal(c.runtime.scheduler.history(t.id)[0].state,'completed');
 c.runtime.finish(l.run.id,'completed','','',{input_tokens:1100,output_tokens:20});c.runtime.scheduler.reconcile();c.runtime.scheduler.reconcile();const history=c.runtime.scheduler.history(t.id)[0];assert.equal(history.state,'skipped');assert.equal(history.tokens,1120);assert.equal(c.store.messages().filter(m=>m.sender_type==='system' && m.text.includes('token bütçesi')).length,1);assert.equal(c.runtime.scheduler.task(t.id).failures,0);
}finally{await c.close();}});
