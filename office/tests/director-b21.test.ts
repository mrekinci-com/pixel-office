import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import {testConfig,fakeTududi,input,cleanup} from './helpers.js';
import {defaultPolicy,defaultSettings,weightedTokens} from '../shared/runtime.js';

async function setup(){
  let now=Date.now();const config=testConfig(),fake=fakeTududi();
  const c=await createApp(config,{fetcher:fake.fetcher,background:false,scheduleClock:()=>now});
  const did=randomUUID();c.store.db.prepare('INSERT INTO departments(id,name,description,color,sort_order) VALUES (?,?,?,?,?)').run(did,'Ekip','','#336699',1);
  const a=await c.office.createAgent(input(did));c.runtime.heartbeat('runner',{codex:['gpt-6.1-sol','secilen-model'],claude:['sonnet']});
  const login=await c.app.inject({method:'POST',url:'/api/login',headers:{'x-ofis-islem':'1'},payload:{password:config.ownerPassword}});
  const headers={cookie:String(login.headers['set-cookie']).split(';')[0],'x-ofis-islem':'1'};
  return {...c,a,did,gm:c.runtime.director.agent(),fake,config,
    api:(url:string,method:any='GET',payload?:any)=>c.app.inject({url,method,headers,payload}),
    settings:(extra:any)=>c.store.db.prepare('UPDATE runtime_settings SET json=?').run(JSON.stringify({...defaultSettings,language:'tr',...extra})),
    advance:(ms:number)=>{now+=ms;c.runtime.heartbeat('runner');},
    close:async()=>{await c.app.close();cleanup(config);}};
}

test("B2.1: multi-tool totals do not renew sessions; one oversized request renews the Director without a model",async()=>{
  const c=await setup();try{
    c.runtime.enqueue(c.a.id,'Elle','İzlenen görev');const job=c.runtime.claim('runner')!;c.runtime.director.watch(job.run.id,'korunan-is');
    c.runtime.enqueue(c.gm.id,'Elle','Ekip kur');const first=c.runtime.claim('runner')!;const provider=randomUUID();c.runtime.a3.recordSession(first.run,provider,10);
    await c.runtime.tool(first.run,'yonetim_defteri',{metin:'İzlenen görev sürüyor; sıradaki adım sonucu kontrol etmek.'});
    c.runtime.finish(first.run.id,'completed','','',{input_tokens:292683,cached_input_tokens:243072,output_tokens:1000,context_input_tokens:28000});
    assert.equal(c.runtime.run(first.run.id).state,'completed');assert.equal(c.runtime.a3.session(c.gm.id).last_input_tokens,28000);
    c.runtime.enqueue(c.gm.id,'Elle','Devam et');const second=c.runtime.claim('runner')!;
    assert.equal(second.session?.provider_id,provider);assert.equal(c.runtime.runs().length,3);
    await c.runtime.tool(second.run,'yonetim_defteri',{metin:'İzlenen görev sürüyor; bekleyen sonuç korunacak.'});
    c.runtime.finish(second.run.id,'completed','','',{input_tokens:160001,cached_input_tokens:155000,context_input_tokens:160001});
    c.runtime.enqueue(c.gm.id,'Elle','Yeni tur');const count=c.runtime.runs().length,third=c.runtime.claim('runner')!;
    assert.ok(third);assert.equal(third.session?.provider_id,null);assert.equal(c.runtime.runs().length,count);
    assert.ok(!c.runtime.runs().some(r=>r.trigger==='Oturum yenileme hazırlığı'));
    assert.match(third.prompt,/İzlenen görev sürüyor/);assert.match(third.prompt,/korunan-is/);
    c.runtime.finish(third.run.id,'stopped','','Deneme bitti');
    const renewed=await c.api('/api/agents/'+c.gm.id+'/session/renew','POST',{});assert.equal(renewed.statusCode,200);
    assert.equal(c.runtime.runs().length,count);assert.equal((await c.api('/api/director/input','POST',{text:'/yenile'})).statusCode,200);
    assert.equal(c.runtime.runs().length,count);
  }finally{await c.close();}
});

test("B2.1: current verified notes skip preparation; stale notes in large sessions require it",async()=>{
  const c=await setup();try{
    const root=c.runtime.enqueue(c.a.id,'Elle','Notlu iş')!,first=c.runtime.claim('runner')!;const provider=randomUUID();c.runtime.a3.recordSession(first.run,provider,10);
    await c.runtime.tool(first.run,'is_notu_yaz',{metin:'Amaç: kontrol. Yapılan: ilk adım doğrulandı. Sıradaki: ikinci adım.'});c.runtime.finish(first.run.id,'completed','','');
    const count=c.runtime.runs().length;c.runtime.a3.renew(c.a.id);assert.equal(c.runtime.runs().length,count);assert.equal(c.runtime.a3.session(c.a.id).provider_id,null);
    c.runtime.enqueue(c.a.id,'Devam','İkinci adım',root,undefined,false);const second=c.runtime.claim('runner')!;c.runtime.a3.recordSession(second.run,randomUUID(),10);
    assert.match(second.prompt,/ilk adım doğrulandı/);await c.runtime.tool(second.run,'hafiza_oku',{});c.runtime.finish(second.run.id,'completed','','');
    c.runtime.a3.renew(c.a.id);const prep=c.runtime.claim('runner')!;assert.equal(prep.run.trigger,'Oturum yenileme hazırlığı');assert.ok(prep.session?.provider_id);
  }finally{await c.close();}
});

test("B2.1: consistent weighted accounting for both providers, cached input, output and unknown cache",()=>{
  assert.equal(weightedTokens({input_tokens:100,cached_input_tokens:70,output_tokens:5}),42);
  assert.equal(weightedTokens({input_tokens:20,cache_read_input_tokens:70,cache_creation_input_tokens:10,output_tokens:5}),42);
  assert.equal(weightedTokens({input_tokens:100,output_tokens:5}),105);
  assert.equal(weightedTokens({input_tokens:100,cached_input_tokens:70,output_tokens:5},.5),70);
});

for(const scope of ['run','chain','office','auto'] as const)test(`B2.1: ${scope} cap and 80-percent warning use weighted tokens`,async()=>{
  const c=await setup();try{
    c.settings({dailyTokenBudget:scope==='office'?100:100000,chainTokenBudget:scope==='chain'?100:100000,director:{...defaultSettings.director!,dailyTokenBudget:scope==='auto'?100:100000,batchSeconds:1}});
    const aid=scope==='auto'?c.gm.id:c.a.id;
    c.store.db.prepare('UPDATE agents SET policy=?,session_mode=? WHERE id=?').run(JSON.stringify({...defaultPolicy,inputTokenBudget:scope==='run'?100:100000}),scope==='auto'?'persistent':'single',aid);
    if(scope==='auto'){c.runtime.director.setAuto(true);c.runtime.director.signal('work_result','agirlikli','Sonuç bekliyor');c.runtime.director.flush();}
    else c.runtime.enqueue(aid,'Elle','Ağırlıklı sınır');
    const lease=c.runtime.claim('runner')!;
    c.runtime.update(lease.run.id,'usage','Kullanım',{input_tokens:400,cached_input_tokens:360,output_tokens:4}); // 40 + 36 + 4 = 80
    assert.equal(c.runtime.run(lease.run.id).state,'running');assert.match(c.runtime.wrapUpNotice(lease.run.id),/yüzde 80/);
    const usage=(await c.api('/api/usage')).json().find((a:any)=>a.id===aid);assert.equal(usage.weighted_tokens,80);
    const daily=c.runtime.snapshot().dailyUsage!;assert.equal(daily.weighted_tokens,80);assert.equal(daily.total_tokens,404);assert.equal(daily.cached_input_tokens,360);
    c.runtime.update(lease.run.id,'usage','Kullanım',{input_tokens:400,cached_input_tokens:360,output_tokens:24});
    assert.equal(c.runtime.run(lease.run.id).state,'budget_exceeded');
  }finally{await c.close();}
});

test("B2.1: batch actions build a team using prior IDs and count as one call; errors stop side effects",async()=>{
  const c=await setup();try{
    c.runtime.enqueue(c.gm.id,'Elle','Ekip');const lease=c.runtime.claim('runner')!;
    const batch:any=await c.runtime.tool(lease.run,'yonetim_islem',{islemler:[
      {islem:'bolum_olustur',veri:{name:'Toplu ekip',color:'#336699'}},
      {islem:'ajan_olustur',veri:{...input(c.did),name:'Toplu Deniz',department_id:'$1.id'}},
      {islem:'ajan_olustur',veri:{...input(c.did),name:'Toplu Ece',department_id:'$1.id'}},
      {islem:'ajan_calistir',kimlik:'$2.id',veri:{kaynaklar:{klasorler:[],komutlar:[],belgeler:[]},kabul:'Tek satır sonuç',text:'İlk dar iş',is:'toplu-ilk',secenekler:{effort:'low'}}},
      {islem:'ajan_calistir',kimlik:'$3.id',veri:{kaynaklar:{klasorler:[],komutlar:[],belgeler:[]},kabul:'Tek satır sonuç',text:'İkinci dar iş',is:'toplu-ikinci'}},
    ]});
    assert.equal(batch.tamamlandi,true);assert.equal(batch.sonuclar.length,5);assert.equal(c.runtime.run(lease.run.id).calls,1);
    assert.equal(c.store.agents().find(a=>a.name==='Toplu Deniz')?.department_id,batch.sonuclar[0].sonuc.id);
    assert.equal(c.runtime.director.continuation().izlenen_isler.length,2);assert.ok(!JSON.stringify(batch).includes('appearance'));
    const failed:any=await c.runtime.tool(lease.run,'yonetim_islem',{islemler:[
      {islem:'bolum_olustur',veri:{name:'Önceki kalır',color:'#336699'}},
      {islem:'bolum_olustur',veri:{name:'',color:'yanlış'}},
      {islem:'bolum_olustur',veri:{name:'Uygulanmasın',color:'#336699'}},
    ]});
    assert.equal(failed.basarisiz,2);assert.equal(failed.uygulanmayan,1);assert.match(failed.neden,/Alanları/);
    assert.ok(c.store.departments().some(d=>d.name==='Önceki kalır'));assert.ok(!c.store.departments().some(d=>d.name==='Uygulanmasın'));
    const ref:any=await c.runtime.tool(lease.run,'yonetim_islem',{islemler:[{islem:'ajan_durdur',kimlik:'$1.id'}]});assert.equal(ref.basarisiz,1);assert.match(ref.neden,/önceki/);
    const bad:any=await c.runtime.tool(lease.run,'yonetim_islem',{islemler:[{islem:'ajan_durdur',kimlik:'$1.__proto__'}]});assert.equal(bad.basarisiz,1);
  }finally{await c.close();}
});

test("B2.1: batches stop for owner decisions; ordinary agents cannot use them",async()=>{
  const c=await setup();try{
    c.runtime.enqueue(c.gm.id,'Elle','Sahip kararı');const lease=c.runtime.claim('runner')!;
    const result:any=await c.runtime.tool(lease.run,'yonetim_islem',{islemler:[{islem:'ajan_sil',kimlik:c.a.id},{islem:'bolum_olustur',veri:{name:'Karar öncesi açılmasın',color:'#336699'}}]});
    assert.equal(result.bekleyen,1);assert.equal(result.uygulanmayan,1);assert.equal(c.runtime.run(lease.run.id).state,'waiting');
    assert.ok(!c.store.departments().some(d=>d.name==='Karar öncesi açılmasın'));
    c.runtime.enqueue(c.a.id,'Elle','Yetki');const worker=c.runtime.claim('runner')!;
    await assert.rejects(()=>c.runtime.tool(worker.run,'yonetim_islem',{islemler:[{islem:'bolum_olustur',veri:{name:'Kaçak',color:'#336699'}}]}),/yalnız yetkili/);
  }finally{await c.close();}
});

test("B2.1: cap emits one notice; interrupted batches and offline results persist after re-enabling",async()=>{
  const c=await setup();try{
    c.settings({director:{...defaultSettings.director!,dailyTokenBudget:50,batchSeconds:1}});
    const gm=c.runtime.director;gm.setAuto(true);
    c.runtime.enqueue(c.a.id,'Elle','Deniz sonucu');const work=c.runtime.claim('runner')!;gm.watch(work.run.id,'deniz-sonucu');
    gm.signal('work_result','eski-sonuc','Eski sonuç');const auto=gm.flush()!;assert.ok(auto);
    const run=c.runtime.claim('runner')!;c.runtime.update(run.run.id,'usage','Kullanım',{input_tokens:51});
    assert.equal(gm.state().auto,false);assert.ok(gm.pending().some(e=>e.subject==='eski-sonuc'));
    c.runtime.finish(work.run.id,'completed','Deniz tamamladı','');assert.ok(gm.pending().some(e=>e.subject==='deniz-sonucu'));
    gm.exhaustBudget();gm.observeRun(c.runtime.run(run.run.id));
    const notices=c.store.messages().filter(m=>m.text.includes('tavanı artırıp /oto aç'));assert.equal(notices.length,1);
    assert.match(notices[0].text,/Deneme Ajanı/);
    const terminal=c.store.db.prepare("SELECT text FROM director_terminal WHERE kind='notice'").all();assert.equal(terminal.length,1);
    assert.throws(()=>gm.setAuto(true),/tavanı doldu/);
    c.settings({director:{...defaultSettings.director!,dailyTokenBudget:500,batchSeconds:1}});c.advance(2000);gm.setAuto(true);
    const resumed=gm.flush()!;assert.ok(resumed);assert.match(resumed.summary,/eski-sonuc/);assert.match(resumed.summary,/deniz-sonucu/);
  }finally{await c.close();}
});

test("B2.1: brief status omits empty agent details and ledger; ID/state filters select details",async()=>{
  const c=await setup();try{
    await c.runtime.director.ledger('Uzun defter yalnız konuşmanın devamına verilir.');c.runtime.enqueue(c.a.id,'Elle','Sıradaki iş');
    const brief=await c.runtime.director.read({alan:'ofis'}) as any;assert.ok(brief.sayilar);assert.equal(brief.sayilar.sirada,1);
    assert.ok(!('ajanlar' in brief));assert.ok(!('ledger' in brief.otomatik));assert.ok(!JSON.stringify(brief).includes('Uzun defter'));
    const filtered=await c.runtime.director.read({alan:'ofis',kimlik:c.a.id,tur:'queued'}) as any;assert.equal(filtered.kuyruk.length,1);
    const detail=await c.runtime.director.read({alan:'ofis',ayrinti:true}) as any;assert.ok(detail.ajanlar.some((a:any)=>a.kimlik===c.a.id));
  }finally{await c.close();}
});

test("B2.1: manual turns complete without a ledger; late usage records the waiting turn's context",async()=>{
  const c=await setup();try{
    c.runtime.enqueue(c.gm.id,'Elle','Deftersiz tur');const missing=c.runtime.claim('runner')!;
    c.runtime.finish(missing.run.id,'completed','Bitti iddiası','');assert.equal(c.runtime.run(missing.run.id).state,'completed');
    c.runtime.enqueue(c.gm.id,'Elle','Sahip kararı');const lease=c.runtime.claim('runner')!;
    await c.runtime.tool(lease.run,'yonetim_defteri',{metin:'Sahibin harcama kararı bekleniyor.'});
    await c.runtime.tool(lease.run,'onay_iste',{baslik:'Harcama',ayrinti:'Sahibin kararı gerekiyor.',tur:'spending'});
    c.runtime.finish(lease.run.id,'completed','','',{input_tokens:1000,cached_input_tokens:900,output_tokens:10,context_input_tokens:12000});
    const session=c.runtime.a3.session(c.gm.id);assert.equal(session.last_input_tokens,12000);assert.equal(session.cached_input_tokens,900);assert.equal(session.input_tokens,1000);
    c.runtime.finish(lease.run.id,'completed','','',{input_tokens:1000,cached_input_tokens:900,output_tokens:10,context_input_tokens:12000});
    assert.equal(c.runtime.a3.session(c.gm.id).cached_input_tokens,900);assert.equal(c.runtime.a3.session(c.gm.id).input_tokens,1000);
  }finally{await c.close();}
});

test("B2.1: migration 14 lowers default caps, preserves custom caps/ledger and cancels old Director preparation",async()=>{
  const c=await setup();let reopened:Awaited<ReturnType<typeof createApp>>|undefined;try{
    c.settings({dailyTokenBudget:3000000,chainTokenBudget:1500000,director:{...defaultSettings.director!,dailyTokenBudget:300000}});
    c.store.db.prepare('UPDATE agents SET policy=? WHERE id=?').run(JSON.stringify({...defaultPolicy,inputTokenBudget:400000}),c.a.id);
    await c.runtime.director.ledger('Kalıcı açık iş ve sahip kararı korunacak.');
    const old=c.runtime.a3.session(c.gm.id);old.provider_id=randomUUID();old.renewing=true;c.runtime.a3.saveSession(old);
    const prep=c.runtime.enqueue(c.gm.id,'Oturum yenileme hazırlığı','Eski konuşmayı özetle')!;c.store.db.prepare("UPDATE runs SET session_action='renew' WHERE id=?").run(prep.id);
    c.store.db.exec('DROP TABLE factory_resets; DROP TABLE reset_gate; ALTER TABLE runtime_settings DROP COLUMN language_initialized; ALTER TABLE runtime_settings DROP COLUMN email_domain_seeded; DROP TABLE director_followups; ALTER TABLE director_watches DROP COLUMN owned; ALTER TABLE runs DROP COLUMN director_followup; ALTER TABLE runs DROP COLUMN context_peak; DELETE FROM migrations WHERE version>=14;');await c.app.close();
    reopened=await createApp(c.config,{fetcher:c.fake.fetcher,background:false});
    assert.equal(reopened.runtime.settings().dailyTokenBudget,750000);assert.equal(reopened.runtime.settings().chainTokenBudget,375000);
    assert.equal(reopened.runtime.settings().director!.dailyTokenBudget,300000);assert.equal(reopened.runtime.settings().cachedInputWeight,.1);
    assert.equal(reopened.office.agent(c.a.id).policy!.inputTokenBudget,100000);
    assert.match(reopened.runtime.director.state().ledger,/Kalıcı açık iş/);
    assert.equal(reopened.runtime.run(prep.id).state,'stopped');assert.equal(reopened.runtime.a3.session(c.gm.id).provider_id,null);assert.equal(reopened.runtime.a3.session(c.gm.id).renewing,false);
    assert.equal(reopened.runtime.a3.session(c.gm.id).generation,old.generation+1);
  }finally{if(reopened)await reopened.app.close();else await c.app.close();cleanup(c.config);}
});
