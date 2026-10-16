import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { testConfig,cleanup,fakeTududi,input } from './helpers.js';
import { defaultSettings } from '../shared/runtime.js';
import { upstreamHeaders,proxyConfig } from '../server/tududi-proxy.js';
async function setup() {
  const config = {...testConfig(),runnerKey:'deneme-anahtari-'.repeat(4),publicOrigin:'http://127.0.0.1:9400',tududiPublicUrl:'http://127.0.0.1:9394'};
  const fake = fakeTududi(), ctx = await createApp(config,{fetcher:fake.fetcher}), did = randomUUID();
  ctx.store.db.prepare('INSERT INTO departments(id,name,description,color,sort_order) VALUES (?,?,?,?,?)').run(did,'Ekip','','#498f87',0);
  const a = await ctx.office.createAgent({...input(did),name:'Deniz',username:'deniz'}), b = await ctx.office.createAgent({...input(did),name:'Ece',username:'ece'});
  ctx.runtime.heartbeat('runner');
  const login = await ctx.app.inject({method:'POST',url:'/api/login',headers:{'x-ofis-islem':'1'},payload:{password:config.ownerPassword}});
  const headers = {cookie:String(login.headers['set-cookie']).split(';')[0],'x-ofis-islem':'1'};
  const api = (url:string,method:any='GET',payload?:any) => ctx.app.inject({url,method,headers,payload});
  return {...ctx,config,fake,a,b,did,headers,api,close:async () => {await ctx.app.close();cleanup(config);}};
}
test("A3: unique usernames; email-domain migration preserves tasks and keys",async () => {
  const c = await setup(); try {
    assert.equal(c.a.tududi_email,'deniz@piksel-ofis.local'); assert.equal(c.a.session_mode,'work'); assert.ok(c.a.workbook_uid);
    assert.equal((await c.api('/api/agents','POST',{...input(c.did),username:'deniz'})).statusCode,409);
    assert.equal((await c.api('/api/agents','POST',{...input(c.did),username:'Deniz'})).statusCode,400);
    const key = c.office.token(c.a.id), task = await c.office.tududi.task(key,{name:'Korunan iş'});
    assert.equal((await c.api('/api/runtime/settings','PUT',{...defaultSettings,language:'tr',emailDomain:'ekip.example'})).statusCode,200);
    assert.equal(c.office.agent(c.a.id).tududi_email,'deniz@ekip.example'); assert.equal(c.office.token(c.a.id),key);
    assert.ok((await c.office.tududi.read(key)).tasks.some(t => t.uid === task.uid));
    c.office.tududi.updateUser = async () => { const {TududiError} = await import('../server/tududi.js'); throw new TududiError(405); };
    await c.office.migrateEmail(c.a.id,'deniz-yeni'); assert.equal(c.office.agent(c.a.id).tududi_email,'deniz@ekip.example');
  } finally {await c.close();}
});
test("A3: expiring single-use transitions are owner-session-bound; events hide cookie secrets",async () => {
  const c = await setup(); try {
    const ticket = (await c.api(`/api/agents/${c.a.id}/tududi-link`,'POST',{})).json();
    const r = await c.api(ticket.url); assert.equal(r.statusCode,303); assert.equal(r.headers.location,c.config.tududiPublicUrl);
    assert.match(String(r.headers['set-cookie']),/HttpOnly/); assert.equal((await c.api(ticket.url)).statusCode,410);
    const second = (await c.api(`/api/agents/${c.a.id}/tududi-link`,'POST',{})).json();
    const another = await c.app.inject({method:'POST',url:'/api/login',headers:{'x-ofis-islem':'1'},payload:{password:c.config.ownerPassword}});
    const cookie = String(another.headers['set-cookie']).split(';')[0];
    assert.equal((await c.app.inject({url:second.url,headers:{cookie}})).statusCode,410);
    c.store.db.prepare('UPDATE login_tickets SET expires_at=0').run(); assert.equal((await c.api(second.url)).statusCode,410);
    assert.equal((await c.api(`/api/agents/${c.a.id}/tududi-credentials`,'POST',{password:'yanlış'})).statusCode,401);
    const secrets = (await c.api(`/api/agents/${c.a.id}/tududi-credentials`,'POST',{password:c.config.ownerPassword})).json();
    assert.ok(secrets.password.length > 20); assert.ok(!JSON.stringify(c.store.snapshot()).includes(secrets.password));
    assert.equal(c.runtime.scrub(secrets.password),'[gizlendi]');
  } finally {await c.close();}
});
test("A3: proxy rewrites Host, requires a private network and strips gateway headers and Office cookies",() => {
  const h = upstreamHeaders({host:'dış.example',cookie:'ofis_session=gizli; tududi_session=ajan','cf-ray':'secret','x-forwarded-host':'bad',origin:'http://192.0.2.10:9394','sec-websocket-key':'key'},true);
  assert.equal(h.host,'127.0.0.1:9393'); assert.equal(h['cf-ray'],undefined); assert.equal(h['x-forwarded-host'],undefined); assert.ok(!h.cookie?.includes('ofis_session')); assert.equal(h.upgrade,'websocket');
  for (const bind of ['0.0.0.0','192.0.2.10','localhost']) assert.throws(()=>proxyConfig({TUDUDI_PROXY_BIND:bind}));
  assert.equal(proxyConfig({TUDUDI_PROXY_BIND:'127.0.0.1'}).port,9394);
});
test("A3: second turn keeps identity and sends only new events; rule changes resend, reset preserves memory",async () => {
  const c = await setup(); try {
    c.office.message(null,'agent',c.a.id,'İlk tur bilgisi özel-123'); const one = c.runtime.claim('runner')!;
    c.runtime.a3.recordSession(one.run,randomUUID(),100); c.runtime.writeMemory(c.a.id,'Doğrulanmış kısa not');
    c.runtime.finish(one.run.id,'completed','İlk cevap','',{input_tokens:120});
    c.office.message(null,'agent',c.a.id,'İkinci yeni olay'); const two = c.runtime.claim('runner')!;
    assert.equal(two.session?.provider_id,c.runtime.a3.session(c.a.id).provider_id); assert.match(two.prompt,/İkinci yeni olay/); assert.ok(!two.prompt.includes('İlk tur bilgisi özel-123')); assert.ok(!two.prompt.includes('Kaynak göster.')); assert.ok(two.prompt.length < one.prompt.length);
    c.runtime.finish(two.run.id,'completed','İkinci cevap','',{input_tokens:30});
    c.store.db.prepare("UPDATE company_rules SET text='Yeni doğrulanmış kural'").run(); c.runtime.enqueue(c.a.id,'Elle','Üçüncü olay'); const three = c.runtime.claim('runner')!; assert.match(three.prompt,/Kurallar güncellendi/); assert.match(three.prompt,/Yeni doğrulanmış kural/);
    const old = c.runtime.a3.session(c.a.id); await c.api(`/api/agents/${c.a.id}/session/reset`,'POST',{}); const next = c.runtime.a3.session(c.a.id); assert.equal(next.generation,old.generation+1); assert.equal(next.provider_id,null); assert.equal(c.runtime.memory(c.a.id),'Doğrulanmış kısa not');
  } finally {await c.close();}
});
test("B2.2: owner reset stops running and queued persistent turns while preserving memory and notes",async () => {
  const c=await setup();try {
    c.store.db.prepare("UPDATE agents SET session_mode='persistent' WHERE id=?").run(c.a.id);
    const director=c.runtime.a3.session(c.runtime.director.agent().id);
    c.runtime.enqueue(c.a.id,'Elle','Kalıcı oturumda çalışan iş');const lease=c.runtime.claim('runner')!;
    c.runtime.a3.recordSession(lease.run,randomUUID(),100);
    c.runtime.writeMemory(c.a.id,'Sıfırlamada korunacak hafıza');
    await c.runtime.tool(lease.run,'is_notu_yaz',{metin:'Sıfırlamada korunacak doğrulanmış iş notu'});
    const before=c.runtime.a3.session(c.a.id);
    const item=c.store.db.prepare('SELECT * FROM work_items WHERE id=?').get(before.work_item_id!);
    const queued=c.runtime.enqueue(c.a.id,'Elle','Kalıcı oturumda sıradaki iş')!;
    const reset=await c.api(`/api/agents/${c.a.id}/session/reset`,'POST',{session_key:before.session_key});
    assert.equal(reset.statusCode,200);
    const after=c.runtime.a3.session(c.a.id);
    assert.equal(after.session_key,before.session_key);assert.equal(after.generation,before.generation+1);
    assert.equal(after.provider_id,null);assert.equal(after.renewing,false);assert.equal(after.closed,false);
    assert.equal(c.runtime.run(lease.run.id).state,'stopped');assert.equal(c.runtime.run(queued.id).state,'stopped');
    assert.equal(c.runtime.memory(c.a.id),'Sıfırlamada korunacak hafıza');
    assert.deepEqual(c.store.db.prepare('SELECT * FROM work_items WHERE id=?').get(before.work_item_id!),item);
    assert.deepEqual(c.runtime.a3.session(director.agent_id),director);
    assert.throws(()=>c.runtime.a3.recordSession(lease.run,randomUUID(),100),/Oturum değişti/);
    c.runtime.enqueue(c.a.id,'Elle','Sıfırlamadan sonraki yeni tur');const fresh=c.runtime.claim('runner')!;
    assert.equal(fresh.agent.id,c.a.id);assert.equal(fresh.session?.generation,after.generation);assert.equal(fresh.session?.provider_id,null);
  }finally{await c.close();}
});
test("A3: renewal waits for its summary; owner interruption queues input in the same session",async () => {
  const c = await setup(); try {
    c.runtime.enqueue(c.a.id,'Elle','İlk'); const first = c.runtime.claim('runner')!; const id = randomUUID(); c.runtime.a3.recordSession(first.run,id,12);
    await c.api(`/api/agents/${c.a.id}/session/input`,'POST',{text:'Yön değişti',mode:'interrupt'}); assert.equal(c.runtime.run(first.run.id).state,'stopped');
    const next = c.runtime.claim('runner')!; assert.equal(next.session?.provider_id,id); assert.match(next.prompt,/Yön değişti/); c.runtime.finish(next.run.id,'completed','Yeni cevap','');
    await c.api(`/api/agents/${c.a.id}/session/renew`,'POST',{}); const renew = c.runtime.claim('runner')!;
    await c.runtime.tool(renew.run,'hafiza_yaz',{metin:'Doğrulanmış hafıza'}); await c.runtime.tool(renew.run,'is_notu_yaz',{metin:'Amaç ve yapılan: test doğrulandı. Sıradaki adım: yeni oturum.'});
    c.runtime.finish(renew.run.id,'completed','Hazır',''); assert.equal(c.runtime.a3.session(c.a.id).provider_id,null); assert.equal(c.runtime.a3.session(c.a.id).renewals,1);
  } finally {await c.close();}
});
test("A3: provider quota pauses one provider; other providers and timed resume work; daily caps block new work",async () => {
  const c = await setup(); try {
    c.store.db.prepare("UPDATE agents SET runner='claude' WHERE id=?").run(c.b.id);
    c.runtime.enqueue(c.a.id,'Elle','Codex işi'); c.runtime.enqueue(c.b.id,'Elle','Claude işi'); c.runtime.a3.pause('codex','Kota',null);
    assert.equal(c.runtime.claim('runner')!.agent.id,c.b.id); assert.equal(c.runtime.claim('runner'),null); c.runtime.a3.resume('codex'); const r = c.runtime.claim('runner')!; assert.equal(r.agent.id,c.a.id);
    c.runtime.finish(r.run.id,'completed','Bitti','',{input_tokens:2}); c.store.db.prepare('UPDATE runtime_settings SET json=?').run(JSON.stringify({...defaultSettings,language:'tr',dailyTokenBudget:1})); c.runtime.enqueue(c.a.id,'Elle','Sonraki'); assert.equal(c.runtime.claim('runner'),null);
    c.runtime.a3.pause('codex','Kota',Date.now()-1); assert.equal(c.runtime.a3.pauses().length,0);
  } finally {await c.close();}
});
test("A3: selective note reading avoids bulk content; lock/error markers and work notes persist",async () => {
  const c = await setup(); try {
    c.runtime.enqueue(c.a.id,'Elle','İki adımlı iş'); const l = c.runtime.claim('runner')!;
    const n = await c.runtime.tool(l.run,'tududi_not_yaz',{baslik:'Kararlar',icerik:'Kaynağı testte doğrulanmış bilgi'}) as any;
    const list = await c.runtime.tool(l.run,'tududi_notlar',{}) as any[]; assert.ok(list.every(n => !('content' in n))); assert.equal(list.filter(n => n.title === 'Kararlar').length,1);
    const read = await c.runtime.tool(l.run,'tududi_not_oku',{kimlik:n.uid}) as any; assert.equal(read.content,'Kaynağı testte doğrulanmış bilgi');
    const search = await c.runtime.tool(l.run,'tududi_ara',{sorgu:'Kaynağı'}) as any; assert.equal(search.notlar[0].uid,n.uid);
    await c.api(`/api/agents/${c.a.id}/notes/${n.uid}/mark`,'PUT',{locked:true,invalid:false,verified:true}); await assert.rejects(()=>c.runtime.tool(l.run,'tududi_not_yaz',{baslik:'Kararlar',icerik:'Değiştirme'}),/kilitli/);
    await c.api(`/api/agents/${c.a.id}/notes/${n.uid}/mark`,'PUT',{locked:true,invalid:true}); await assert.rejects(()=>c.runtime.tool(l.run,'tududi_not_oku',{kimlik:n.uid}),/yanlış/);
    await c.runtime.tool(l.run,'is_notu_yaz',{metin:'Amaç: iki adım. Yapılan: ilk adım doğrulandı. Sıradaki: ikinci adım.'}); const item = c.store.db.prepare('SELECT * FROM work_items WHERE agent_id=?').get(c.a.id)!; assert.match(String(item.note),/ilk adım/); assert.ok(item.task_uid);
    await assert.rejects(()=>c.runtime.tool(l.run,'ortak_not_yaz',{baslik:'Ortak',icerik:'Bilgi'}),/yetkiniz/);
    await c.api('/api/shared-notebook','POST',{title:'Ortak',content:'Sahibin bilgisi'}); const shared = await c.runtime.tool(l.run,'ortak_notlar',{}) as any[]; assert.ok(!('content' in shared[0]));
  } finally {await c.close();}
});
test("A3: fixed command permissions reject arguments, record evidence and stop repeated blockers",async () => {
  const c = await setup(); try {
    const folder = {id:randomUUID(),name:'Kod',path:'/izinli/kod',access:'read',approved_write:true,agent_ids:[c.a.id],validation:'valid',detail:''}; c.store.db.prepare('INSERT INTO folder_links VALUES (?,?)').run(folder.id,JSON.stringify(folder));
    const cmd = (await c.api('/api/commands','POST',{name:'Testler',folder_id:folder.id,command:'npm test',agent_ids:[c.a.id],approval:false})).json(); assert.ok(cmd.id);
    c.runtime.enqueue(c.a.id,'Elle','Kanıt'); const l = c.runtime.claim('runner')!;
    await assert.rejects(()=>c.runtime.tool(l.run,'komut_calistir',{ad:'Testler',args:'--kötü'})); const j = await c.runtime.tool(l.run,'komut_calistir',{ad:'Testler'}) as any; assert.ok(j.komut_is);
    const runnerHeaders = {authorization:`Bearer ${c.config.runnerKey}`};
    await c.app.inject({url:'/api/runner/commands/take',method:'POST',headers:runnerHeaders,payload:{id:j.komut_is}});
    await c.app.inject({url:'/api/runner/commands/result',method:'POST',headers:runnerHeaders,payload:{id:j.komut_is,exit_code:0,output:'Testler geçti.'}});
    assert.ok(c.store.db.prepare("SELECT 1 FROM run_logs WHERE kind='command_result' AND run_id=?").get(l.run.id)); await c.runtime.tool(l.run,'yayina_hazir',{karar:'KABUL: komut kanıtı var.'}); assert.equal(c.runtime.approvals()[0].type,'release_ready');
    await c.runtime.tool(l.run,'engel_bildir',{engel:'Gerekli araç yok'}); assert.equal(c.runtime.run(l.run.id).state,'running'); await c.runtime.tool(l.run,'engel_bildir',{engel:'Gerekli araç yok'}); assert.equal(c.runtime.run(l.run.id).state,'failed');
  } finally {await c.close();}
});
test("A3: polling distinguishes owner edits from agent writes; task triggers remain off and summaries call no model",async () => {
  const c = await setup(); try {
    await c.runtime.notebook.poll(true); const before = c.runtime.runs().length;
    await c.office.tududi.task(c.office.token(c.a.id),{name:'Sahibin Tududi işi'}); await c.runtime.notebook.poll(true);
    assert.equal(c.runtime.runs().length,before); assert.ok(c.store.events().some(e => e.kind === 'notebook_owner_write'));
    c.store.db.prepare('UPDATE agents SET watch_tasks=1 WHERE id=?').run(c.a.id); await c.office.tududi.task(c.office.token(c.a.id),{name:'Yeni tetik'}); await c.runtime.notebook.poll(true); assert.ok(c.runtime.runs().some(r => r.trigger === 'Tududi görevi değişti'));
    const count = c.runtime.runs().length; const summary = (await c.api('/api/summaries/now','POST',{})).json(); assert.match(summary.text,/Deniz/); assert.equal(c.runtime.runs().length,count);
  } finally {await c.close();}
});

test("A3: failed summary tools are not renewal evidence; automatic preparation cannot loop",async()=>{
  const c=await setup();try{
    c.store.db.prepare("UPDATE agents SET session_mode='persistent' WHERE id=?").run(c.a.id);
    c.runtime.a3.renew(c.a.id);const l=c.runtime.claim('runner')!;
    await c.runtime.tool(l.run,'hafiza_yaz',{metin:'Hafıza yazıldı'});
    c.office.tududi.updateTaskNote=async()=>{throw new Error('Deneme bağlantı kesintisi');};
    await assert.rejects(()=>c.runtime.tool(l.run,'is_notu_yaz',{metin:'Bu yazım başarısız'}));
    c.runtime.finish(l.run.id,'completed','Hazır iddiası','');
    assert.equal(c.runtime.a3.session(c.a.id).generation,1);assert.equal(c.runtime.a3.session(c.a.id).renew_error,true);
    c.store.db.prepare('UPDATE runtime_settings SET json=?').run(JSON.stringify({...defaultSettings,language:'tr',sessionTurnLimit:1}));
    c.runtime.enqueue(c.a.id,'Elle','Yeni iş');assert.ok(c.runtime.claim('runner'));
    assert.equal(c.runtime.runs().filter(r=>r.trigger==='Oturum yenileme hazırlığı').length,1);
  }finally{await c.close();}
});
test("A3: mid-run rule changes reach the next input; deletion preserves the profile decision",async()=>{
  const c=await setup();try{
    c.runtime.enqueue(c.a.id,'Elle','İlk');const l=c.runtime.claim('runner')!;c.runtime.a3.recordSession(l.run,randomUUID(),12);
    c.store.db.prepare("UPDATE company_rules SET text='Tur sırasında yeni kural'").run();c.runtime.finish(l.run.id,'completed','Bitti','');
    c.runtime.enqueue(c.a.id,'Elle','İkinci');assert.match(c.runtime.claim('runner')!.prompt,/Tur sırasında yeni kural/);
    await c.office.removeAgent(c.a.id,true,true);assert.ok(c.store.db.prepare('SELECT 1 FROM profile_deletions WHERE agent_id=?').get(c.a.id));
    await c.office.removeAgent(c.b.id,true,false);assert.equal(c.store.db.prepare('SELECT 1 FROM profile_deletions WHERE agent_id=?').get(c.b.id),undefined);
  }finally{await c.close();}
});

test("A3: reviewers cannot open overlapping read/write folders until developers finish",async()=>{
  const c=await setup();try{
    for(const [aid,access] of [[c.a.id,'write'],[c.b.id,'read']] as const){const l={id:randomUUID(),path:'/izinli/ortak-kod',name:'Kod',access,approved_write:false,agent_ids:[aid],validation:'valid',detail:''};c.store.db.prepare('INSERT INTO folder_links VALUES (?,?)').run(l.id,JSON.stringify(l));}
    c.runtime.enqueue(c.a.id,'Elle','Yaz');c.runtime.enqueue(c.b.id,'Elle','İncele');const writer=c.runtime.claim('runner')!;assert.equal(writer.agent.id,c.a.id);assert.equal(c.runtime.claim('runner'),null);
    c.runtime.log(writer.run.id,'git_change','Dosyalar: deneme.ts; +2/-1');c.runtime.finish(writer.run.id,'completed','Bitti','');assert.equal(c.runtime.claim('runner')!.agent.id,c.b.id);
  }finally{await c.close();}
});

test("A3: stopping or removing a command cancels pending/running command jobs",async()=>{
 const c=await setup();try{
   const folder={id:randomUUID(),name:'Kod',path:'/izinli/kod',access:'read',approved_write:false,agent_ids:[c.a.id],validation:'valid',detail:''};c.store.db.prepare('INSERT INTO folder_links VALUES (?,?)').run(folder.id,JSON.stringify(folder));
   const cmd=(await c.api('/api/commands','POST',{name:'Testler',folder_id:folder.id,command:'npm test',agent_ids:[c.a.id],approval:false})).json();
   c.runtime.enqueue(c.a.id,'Elle','Komut');const lease=c.runtime.claim('runner')!;const result=await c.runtime.tool(lease.run,'komut_calistir',{ad:'Testler'}) as any;
   const headers={authorization:`Bearer ${c.config.runnerKey}`};await c.app.inject({url:'/api/runner/commands/take',method:'POST',headers,payload:{id:result.komut_is}});
   await c.api(`/api/commands/${cmd.id}`,'DELETE');const job=c.runtime.a3.jobs().find(j=>j.id===result.komut_is)!;assert.equal(job.state,'completed');assert.equal(job.exit_code,null);assert.equal(c.runtime.run(lease.run.id).state,'stopped');
   assert.equal((await c.app.inject({url:'/api/runner/commands/result',method:'POST',headers,payload:{id:job.id,exit_code:0,output:'Gecikmiş sonuç'}})).statusCode,409);
 }finally{await c.close();}
});

test("A3: unverified legacy-account passwords are not stored; records and keys persist",async () => {
  const c=await setup();try {
    const key=c.office.token(c.a.id),task=await c.office.tududi.task(key,{name:'Korunan eski iş'});
    c.store.db.prepare('UPDATE agents SET tududi_password_encrypted=NULL WHERE id=?').run(c.a.id);
    c.office.tududi.updateUser=async()=>{};
    c.office.tududi.login=async()=>{const {TududiError}=await import('../server/tududi.js');throw new TududiError(401);};
    await assert.rejects(()=>c.office.password(c.a.id),/eski hesabın şifresi/);
    assert.equal(c.store.db.prepare('SELECT tududi_password_encrypted FROM agents WHERE id=?').get(c.a.id)!.tududi_password_encrypted,null);
    assert.equal(c.office.token(c.a.id),key);assert.ok((await c.office.tududi.read(key)).tasks.some(t=>t.uid===task.uid));
  }finally{await c.close();}
});
test("A3: reviewer acceptance creates one evidence-backed release card automatically",async () => {
  const c=await setup();try {
    c.runtime.enqueue(c.a.id,'Kod işi','Kısa iş');const author=c.runtime.claim('runner')!;
    const h=await c.runtime.tool(author.run,'gorev_devret',{kime:c.b.id,baslik:'İncele',aciklama:'Kayıtlı farkı incele'}) as {id:string};
    const reviewer=c.runtime.claim('runner')!;assert.equal(reviewer.run.handoff_id,h.id);
    c.runtime.log(author.run.id,'git_change','Kod: bir dosyada 2 satır değişti.');
    c.runtime.finish(reviewer.run.id,'completed','KABUL: fark ve test kanıtı uygun.','');
    const cards=c.runtime.approvals().filter(a=>a.type==='release_ready');assert.equal(cards.length,1);assert.match(cards[0].detail,/2 satır/);
    c.runtime.a3.readyCard(reviewer.run,'KABUL: tekrar');assert.equal(c.runtime.approvals().filter(a=>a.type==='release_ready').length,1);
  }finally{await c.close();}
});
test("A3: test daily summaries never write to the live administrator project",async () => {
  const c=await setup();try {
    c.config.port=9401;const projects:string[]=[];
    c.office.tududi.publishSummary=async(_day,_text,project)=>{projects.push(project!);};
    c.runtime.a3.summary('2026-10-10');await c.runtime.notebook.poll(true);
    assert.ok(projects.length);assert.ok(projects.every(p=>p==='Deneme — Günlük özet'));
  }finally{await c.close();}
});

test("A3: long tasks are read selectively; other accounts' tasks cannot be opened",async()=>{
  const c=await setup();try{
    c.runtime.enqueue(c.a.id,'Elle','Görevi oku');const lease=c.runtime.claim('runner')!;
    const description='A'.repeat(300)+' Son adım: sonucu doğrula.';
    const task=await c.office.tududi.task(c.office.token(c.a.id),{name:'Uzun istek',description});
    const list=await c.runtime.tool(lease.run,'tududi_gorevler',{}) as {uid:string;description:string}[];
    assert.ok(list.find(t=>t.uid===task.uid)!.description.length<=160);
    const selected=await c.runtime.tool(lease.run,'tududi_gorev_oku',{kimlik:task.uid}) as {description:string};assert.equal(selected.description,description);
    const other=await c.office.tududi.task(c.office.token(c.b.id),{name:'Başka hesabın görevi'});
    await assert.rejects(()=>c.runtime.tool(lease.run,'tududi_gorev_oku',{kimlik:other.uid}),/sizin hesabınızda/);
  }finally{await c.close();}
});

test("A3: daily summaries reauthenticate after admin expiry without duplicating notes",async()=>{
  const c=await setup();try{
    const {TududiClient}=await import('../server/tududi.js');let logins=0,expired=true;
    const client=new TududiClient(c.config,async(url,init)=>{
      const path=new URL(String(url)).pathname;
      if(path==='/api/login')logins++;
      if(path==='/api/projects' && expired){expired=false;return new Response('{}',{status:401});}
      return c.fake.fetcher(url,init);
    });
    await client.publishSummary('2026-10-11','İlk özet');assert.equal(logins,2);
    await client.publishSummary('2026-10-11','Güncellenmiş özet');assert.equal(logins,2);
    const notes=(await client.read('')).notes.filter(n=>n.title==='2026-10-11');assert.equal(notes.length,1);assert.equal(notes[0].content,'Güncellenmiş özet');
  }finally{await c.close();}
});

test("A3: local account preparation changes only the verified legacy account and preserves keys/records",async()=>{
 const c=await setup();try{
  const {prepareLegacyPassword}=await import('../server/legacy-password.js');let updates=0;
  const updater=async(a:{id:string;email:string;password:string})=>{updates++;assert.equal(a.id,c.a.tududi_user_id);assert.equal(a.email,c.a.tududi_email);await c.office.tududi.updateUser(a.id,{password:a.password});};
  assert.deepEqual(await prepareLegacyPassword(c.office,c.a.id,updater),{prepared:false});assert.equal(updates,0);
  const key=c.office.token(c.a.id),task=await c.office.tududi.task(key,{name:'Korunan eski görev'});
  c.store.db.prepare('UPDATE agents SET tududi_password_encrypted=NULL WHERE id=?').run(c.a.id);
  assert.deepEqual(await prepareLegacyPassword(c.office,c.a.id,updater),{prepared:true});assert.equal(updates,1);
  assert.equal(c.office.token(c.a.id),key);assert.ok((await c.office.tududi.read(key)).tasks.some(t=>t.uid===task.uid));
  const password=await c.office.password(c.a.id);assert.ok(!JSON.stringify(c.store.snapshot()).includes(password));assert.equal(c.runtime.scrub(password),'[gizlendi]');
 }finally{await c.close();}
});
test("A3: local preparation rejects other Tududi instances and account-ID mismatches",async()=>{
 const c=await setup();try{
  const {prepareLegacyPassword}=await import('../server/legacy-password.js');let updates=0;
  const updater=async()=>{updates++;};c.store.db.prepare('UPDATE agents SET tududi_password_encrypted=NULL WHERE id=?').run(c.a.id);
  c.config.tududiUrl='http://127.0.0.1:9292';await assert.rejects(()=>prepareLegacyPassword(c.office,c.a.id,updater),/9393/);c.config.tududiUrl='http://127.0.0.1:9393';
  c.office.tududi.findUser=async()=>c.b.tududi_user_id!;await assert.rejects(()=>prepareLegacyPassword(c.office,c.a.id,updater),/doğrulanamadı/);assert.equal(updates,0);
 }finally{await c.close();}
});
test("A3: failed process or login verification prevents password storage",async()=>{
 const c=await setup();try{
  const {prepareLegacyPassword}=await import('../server/legacy-password.js');c.store.db.prepare('UPDATE agents SET tududi_password_encrypted=NULL WHERE id=?').run(c.a.id);
  await assert.rejects(()=>prepareLegacyPassword(c.office,c.a.id,async()=>{throw Error('Süreç yok.');}),/Süreç yok/);
  const {TududiError}=await import('../server/tududi.js');c.office.tududi.login=async()=>{throw new TududiError(401);};
  await assert.rejects(()=>prepareLegacyPassword(c.office,c.a.id,async()=>{}));
  assert.equal(c.store.db.prepare('SELECT tududi_password_encrypted FROM agents WHERE id=?').get(c.a.id)!.tududi_password_encrypted,null);
 }finally{await c.close();}
});

test("A3: operator tool lists read-only without a build and changes no data or network records",async()=>{
 const c=await setup();try{
  const {writeFileSync}=await import('node:fs'),{join,resolve}=await import('node:path'),{spawnSync}=await import('node:child_process');
  c.store.db.prepare('UPDATE agents SET tududi_password_encrypted=NULL WHERE id=?').run(c.a.id);
  const env=join(c.config.dataDir,'yerel-test.env');writeFileSync(env,`OFIS_OWNER_PASSWORD=${c.config.ownerPassword}\nOFIS_SECRET_KEY=${c.config.secretKey}\nOFIS_DATA_DIR=${c.config.dataDir}\nTUDUDI_BASE_URL=http://127.0.0.1:9393\n`,{mode:0o600});
  const events=c.store.events().length,calls=c.fake.calls.length;
  const noBuild='data:text/javascript,'+encodeURIComponent('import {registerHooks} from "node:module"; registerHooks({resolve(s,c,next){if(s.includes("/dist/"))throw Error("Listing must not require a build.");return next(s,c);}});');
  const result=spawnSync(process.execPath,['--import',noBuild,'scripts/legacy-account-login.mjs','--ortam',env,'--ajan',c.a.id],{cwd:resolve('.'),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Listing only/);assert.ok(!result.stdout.includes(c.config.ownerPassword));
  assert.equal(c.store.db.prepare('SELECT tududi_password_encrypted FROM agents WHERE id=?').get(c.a.id)!.tududi_password_encrypted,null);
  assert.equal(c.store.events().length,events);assert.equal(c.fake.calls.length,calls);
 }finally{await c.close();}
});
