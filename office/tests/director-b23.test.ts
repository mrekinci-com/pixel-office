import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createApp} from '../server/app.js';
import {testConfig,fakeTududi,input,cleanup} from './helpers.js';
import {defaultPolicy,defaultSettings} from '../shared/runtime.js';
import {directorOperations} from '../shared/director.js';
import {boundedManagement} from '../server/director-output.js';
import {toolsForNames} from '../../runner/src/tools.js';
const kaynaklar={klasorler:[],komutlar:[],belgeler:[]};
async function setup(){
 const config=testConfig(),fake=fakeTududi(),c=await createApp(config,{fetcher:fake.fetcher,background:false});
 const did=randomUUID();c.store.db.prepare('INSERT INTO departments(id,name,description,color,sort_order) VALUES (?,?,?,?,?)').run(did,'Ekip','','#336699',1);
 const a=await c.office.createAgent(input(did));await c.office.provision(c.runtime.director.agent().id);c.runtime.heartbeat('runner',{codex:['gpt-6.1-sol','secilen-model'],claude:['sonnet']});
 const login=await c.app.inject({method:'POST',url:'/api/login',headers:{'x-ofis-islem':'1'},payload:{password:config.ownerPassword}}),headers={cookie:String(login.headers['set-cookie']).split(';')[0],'x-ofis-islem':'1'};
 return {...c,a,fake,config,gm:c.runtime.director.agent(),api:(url:string,method:any='GET',payload?:any)=>c.app.inject({url,method,headers,payload}),settings:(extra:any)=>c.store.db.prepare('UPDATE runtime_settings SET json=?').run(JSON.stringify({...defaultSettings,language:'tr',...extra})),close:async()=>{await c.app.close();cleanup(config);}};
}
test("B2.3: management replies enforce hard bounds, including individual records; actions still complete",async()=>{
 const c=await setup();try{
 c.store.db.prepare('UPDATE agents SET prompt=? WHERE id=?').run('UZUN TALİMAT '.repeat(5000),c.a.id);c.runtime.enqueue(c.gm.id,'Elle','Durum');const gm=c.runtime.claim('runner')!;
 for(let i=0;i<40;i++)c.office.event(c.a.id,'deneme','Uzun sonuç '.repeat(1000));
 for(const args of [{alan:'ofis',ayrinti:true},{alan:'ajan',kimlik:c.a.id,ayrinti:true},{alan:'olaylar',ayrinti:true},{alan:'ayarlar',ayrinti:true},{alan:'ajan'}]){const reply=await c.runtime.tool(gm.run,'yonetim_durum',args);assert.ok(JSON.stringify(reply).length<=3000);assert.ok(!JSON.stringify(reply).includes('UZUN TALİMAT '.repeat(100)));}
 const list:any=await c.runtime.tool(gm.run,'yonetim_durum',{alan:'olaylar',ayrinti:true});assert.match(list.kisaltma,/kayıt daha.*filtreyle iste/);
 const large=boundedManagement(Array.from({length:100},(_,i)=>({id:String(i),text:'x'.repeat(2000)})),500);assert.ok(JSON.stringify(large).length<=500);
 const batch:any=await c.runtime.tool(gm.run,'yonetim_islem',{islemler:Array.from({length:20},(_,i)=>({islem:'bolum_olustur',veri:{name:'Bölüm '+i,color:'#336699'}}))});assert.ok(JSON.stringify(batch).length<=3000);assert.equal(batch.tamamlandi,true);assert.equal(c.store.departments().length,22);
 assert.ok(!directorOperations.some(x=>/ajan_sifirla|ofisi_sifirla|urun_istegi/.test(x)));
 }finally{await c.close();}
});
test("B2.3: last-request context above 60k renews the next turn without a model; total input does not trigger it",async()=>{
 const c=await setup();try{
 await c.runtime.director.ledger('Korunan kısa defter');c.runtime.enqueue(c.gm.id,'Elle','merhaba');let l=c.runtime.claim('runner')!;const provider=randomUUID();c.runtime.a3.recordSession(l.run,provider,1);
 c.runtime.finish(l.run.id,'completed','Merhaba','',{input_tokens:400000,cached_input_tokens:390000,context_input_tokens:59000});c.runtime.enqueue(c.gm.id,'Elle','hangi model');l=c.runtime.claim('runner')!;assert.equal(l.session?.provider_id,provider);
 c.runtime.finish(l.run.id,'completed','Model','',{input_tokens:70000,cached_input_tokens:65000,context_input_tokens:60001});c.runtime.enqueue(c.gm.id,'Elle','durum');const count=c.runtime.runs().length;l=c.runtime.claim('runner')!;
 assert.equal(l.session?.provider_id,null);assert.equal(c.runtime.runs().length,count);assert.match(l.prompt,/Korunan kısa defter/);assert.ok(!c.runtime.runs().some(r=>r.trigger==='Oturum yenileme hazırlığı'));
 }finally{await c.close();}
});
test("B2.3: doubled context peak renews even after later shrinking or late metadata",async()=>{
 const c=await setup();try{
 c.runtime.enqueue(c.gm.id,'Elle','ölçüm');const l=c.runtime.claim('runner')!;c.runtime.a3.recordSession(l.run,randomUUID(),1);c.runtime.update(l.run.id,'usage','',{input_tokens:2000,context_input_tokens:120001});c.runtime.update(l.run.id,'usage','',{input_tokens:3000,context_input_tokens:10000});c.runtime.finish(l.run.id,'completed','Sonuç','');assert.equal(c.runtime.a3.session(c.gm.id).provider_id,null);assert.equal(c.runtime.a3.session(c.gm.id).generation,l.session!.generation+1);
 c.runtime.enqueue(c.gm.id,'Elle','geç ölçüm');const late=c.runtime.claim('runner')!;c.runtime.a3.recordSession(late.run,randomUUID(),1);c.runtime.finish(late.run.id,'completed','','');c.runtime.finish(late.run.id,'completed','','',{input_tokens:1000,context_input_tokens:120001});assert.equal(c.runtime.a3.session(c.gm.id).provider_id,null);
 }finally{await c.close();}
});
test("B2.3: Director budget stops never retry automatically; one final answer/notice; resume opens a fresh turn",async()=>{
 const c=await setup();try{
 c.store.db.prepare('UPDATE agents SET policy=? WHERE id=?').run(JSON.stringify({...defaultPolicy,inputTokenBudget:100}),c.gm.id);c.runtime.enqueue(c.gm.id,'Elle','Dar iş');const l=c.runtime.claim('runner')!;c.runtime.update(l.run.id,'text','Son cevap');c.runtime.update(l.run.id,'usage','',{input_tokens:101,context_input_tokens:100});assert.equal(c.runtime.run(l.run.id).state,'budget_exceeded');assert.equal(c.runtime.runs().length,1);c.runtime.retryRun(l.run,'Komut satırı yeniden denemesi');assert.equal(c.runtime.runs().length,1);
 c.runtime.finish(l.run.id,'completed','Son cevap','',{input_tokens:102});c.runtime.finish(l.run.id,'completed','Son cevap','',{input_tokens:103});assert.equal(c.store.messages().filter(m=>m.sender_agent_id===c.gm.id && m.text==='Son cevap').length,1);assert.equal(c.store.db.prepare("SELECT COUNT(*) AS n FROM director_terminal WHERE run_id=? AND kind='budget_stop'").get(l.run.id)!.n,1);assert.match(String(c.store.db.prepare("SELECT text FROM director_terminal WHERE run_id=? AND kind='budget_stop'").get(l.run.id)!.text),/103 token.*\/devam/);
 assert.equal((await c.api('/api/director/input','POST',{text:'/devam'})).statusCode,200);assert.equal(c.runtime.runs().length,2);assert.equal(c.runtime.claim('runner')!.session?.provider_id,null);
 }finally{await c.close();}
});
test("B2.3: automatic Director budget stops do not retry; event batches persist",async()=>{
 const c=await setup();try{
 c.settings({director:{...defaultSettings.director!,batchSeconds:1}});c.store.db.prepare('UPDATE agents SET policy=? WHERE id=?').run(JSON.stringify({...defaultPolicy,inputTokenBudget:100}),c.gm.id);c.runtime.director.setAuto(true);c.runtime.director.signal('work_result','is','Sonuç');c.runtime.director.flush();const l=c.runtime.claim('runner')!;c.runtime.update(l.run.id,'usage','',{input_tokens:101});assert.equal(c.runtime.director.state().auto,false);assert.equal(c.runtime.director.flush(),null);assert.equal(c.runtime.runs().length,1);assert.equal(c.runtime.director.pending().length,1);
 }finally{await c.close();}
});
test("B2.3: chat needs no ledger but automatic follow-up does; effort settings apply",async()=>{
 const c=await setup();try{
 for(const [text,effort] of [['merhaba','low'],['hangi model, ne durumdayız?','low'],['Ekip kur ve iş planla','medium'],['Açıkça zor iş, derinlemesine analiz yap','high']]){c.runtime.enqueue(c.gm.id,'Elle',text);const l=c.runtime.claim('runner')!;assert.equal(l.agent.effort,effort);c.runtime.finish(l.run.id,'completed','Kısa cevap','');assert.equal(c.runtime.run(l.run.id).state,'completed');}
 c.settings({director:{...defaultSettings.director!,chatEffort:'medium',workEffort:'low',batchSeconds:1}});c.runtime.enqueue(c.gm.id,'Elle','merhaba');const chat=c.runtime.claim('runner')!;assert.equal(chat.agent.effort,'medium');c.runtime.finish(chat.run.id,'completed','','');c.runtime.director.setAuto(true);c.runtime.director.signal('work_result','ilk','Bitti');c.runtime.director.flush();const auto=c.runtime.claim('runner')!;assert.equal(auto.agent.effort,'low');c.runtime.finish(auto.run.id,'completed','Deftersiz','');assert.equal(c.runtime.run(auto.run.id).state,'failed');
 }finally{await c.close();}
});
test("B2.3: platform work requires assigned folders, commands, documents and acceptance criteria",async()=>{
 const c=await setup();try{
 c.runtime.enqueue(c.gm.id,'Elle','Platform özelliği');const gm=c.runtime.claim('runner')!,job={islem:'ajan_calistir',kimlik:c.a.id,veri:{text:'Piksel Ofis için yeni özellik geliştir',kaynaklar,kabul:'Tür denetimi ve ilgili test geçsin.'}};await assert.rejects(()=>c.runtime.tool(gm.run,'yonetim_islem',job),/İş açılmadı.*eksik/);assert.equal(c.runtime.runs().length,1);
 const folder={id:randomUUID(),name:'Kod',path:'/yalniz-deneme/kod',access:'write',approved_write:true,validation:'valid',agent_ids:[c.a.id],detail:'',documents:['docs/is.md']};c.store.db.prepare('INSERT INTO folder_links VALUES (?,?)').run(folder.id,JSON.stringify(folder));const command={id:randomUUID(),name:'Kontrol',folder_id:folder.id,directory:'.',command:'sabit-kontrol',timeout_seconds:30,write:false,approval:false,agent_ids:[c.a.id]};c.store.db.prepare('INSERT INTO command_links VALUES (?,?)').run(command.id,JSON.stringify(command));c.store.db.prepare('UPDATE agents SET policy=? WHERE id=?').run(JSON.stringify({...defaultPolicy,permission:'folders',commands:true}),c.a.id);
 const linked={klasorler:[folder.id],komutlar:[command.id],belgeler:[{klasor:folder.id,yol:'docs/is.md'}]};await assert.rejects(()=>c.runtime.tool(gm.run,'yonetim_islem',{...job,veri:{...job.veri,kaynaklar:{...linked,belgeler:[{klasor:folder.id,yol:'../disari'}]}}}),/İş açılmadı/);await assert.rejects(()=>c.runtime.tool(gm.run,'yonetim_islem',{...job,veri:{...job.veri,kaynaklar:{...linked,belgeler:[{klasor:folder.id,yol:'docs/yok.md'}]}}}),/mevcut belge/);const r:any=await c.runtime.tool(gm.run,'yonetim_islem',{...job,veri:{...job.veri,kaynaklar:linked}});assert.ok(r.id);assert.match(c.runtime.run(r.id).summary,/Kabul ölçütü:.*test geçsin/);assert.match(c.runtime.run(r.id).summary,/Kaynak eksikse dur ve Genel Müdür/);assert.equal(c.store.db.prepare('SELECT owned FROM director_watches WHERE run_id=?').get(r.id)!.owned,1);const catalogue:any=await c.runtime.tool(gm.run,'yonetim_durum',{alan:'baglantilar',kimlik:folder.id,ayrinti:true,tur:'docs/is'});assert.deepEqual(catalogue.klasorler[0].documents,['docs/is.md']);const reassigned:any=await c.runtime.tool(gm.run,'yonetim_islem',{islem:'baglanti_ata',kimlik:folder.id,veri:{agent_ids:[c.a.id]}});assert.equal(reassigned.id,folder.id);assert.equal(c.runtime.links()[0].validation,'pending');
 }finally{await c.close();}
});
for(const state of ['completed','failed','budget_exceeded'] as const)test(`B2.3: with auto off, owned work ending ${state} gets one light follow-up, a separate budget and no new assignments`,async()=>{
 const c=await setup();try{
 c.runtime.enqueue(c.gm.id,'Elle','İş ver');const gm=c.runtime.claim('runner')!,r:any=await c.runtime.tool(gm.run,'yonetim_islem',{islem:'ajan_calistir',kimlik:c.a.id,veri:{text:'Kısa rapor hazırla',kaynaklar,kabul:'Tek satır sonuç',is:'tek-is'}});c.runtime.finish(gm.run.id,'completed','İş verildi','');const agent=c.runtime.claim('runner')!;assert.equal(agent.run.id,r.id);c.runtime.finish(agent.run.id,state,'Sonuç','Deneme');assert.ok(c.runtime.director.flush()!.director_followup);assert.equal(c.runtime.director.state().auto,false);const l=c.runtime.claim('runner')!;assert.equal(l.agent.effort,'low');await assert.rejects(()=>c.runtime.tool(l.run,'yonetim_islem',{islem:'ajan_calistir',kimlik:c.a.id,veri:{text:'Yeni iş',kaynaklar,kabul:'Sonuç'}}),/Hafif takip/);await assert.rejects(()=>c.runtime.tool(l.run,'gorev_devret',{}),/Hafif takip/);c.runtime.finish(l.run.id,'completed','Takip raporu','',{input_tokens:1000,cached_input_tokens:900,output_tokens:10});assert.equal(c.runtime.director.followupUsage(),200);assert.equal(c.runtime.director.autoUsage(),0);c.runtime.director.observeRun(c.runtime.run(agent.run.id));assert.equal(c.runtime.director.flush(),null);assert.equal(c.runtime.runs().filter(r=>r.director_followup).length,1);
 }finally{await c.close();}
});
test("B2.3: daily follow-up cap preserves results; the smaller in-run cap stops work",async()=>{
 const c=await setup();try{
 c.settings({director:{...defaultSettings.director!,followupTokenBudget:100}});c.runtime.enqueue(c.a.id,'Elle','İlk');const a=c.runtime.claim('runner')!;c.runtime.director.watch(a.run.id,'bir',true);c.runtime.finish(a.run.id,'completed','Bitti','');c.runtime.director.flush();const f=c.runtime.claim('runner')!;c.runtime.update(f.run.id,'usage','',{input_tokens:101});assert.equal(c.runtime.run(f.run.id).state,'budget_exceeded');c.runtime.enqueue(c.a.id,'Elle','İkinci');const b=c.runtime.claim('runner')!;c.runtime.director.watch(b.run.id,'iki',true);c.runtime.finish(b.run.id,'completed','Bitti','');assert.equal(c.runtime.director.flush(),null);assert.ok(c.runtime.director.pending().some(e=>e.kind==='owned_result' && e.subject==='iki'));c.settings({director:{...defaultSettings.director!,followupTokenBudget:100000}});assert.ok(c.runtime.director.flush());const big=c.runtime.claim('runner')!;c.runtime.update(big.run.id,'usage','',{input_tokens:20001});assert.equal(c.runtime.run(big.run.id).state,'budget_exceeded');
 }finally{await c.close();}
});
test("B2.3: email domains isolate offices; conflicting accounts cannot be claimed; linked accounts recover",async()=>{
 const c=await setup(),config={...testConfig(),tududiEmailDomain:'deneme.piksel-ofis.local'};let other:Awaited<ReturnType<typeof createApp>>|undefined;try{
 other=await createApp(config,{fetcher:c.fake.fetcher,background:false});await other.office.provision(other.runtime.director.agent().id);assert.equal(other.runtime.director.agent().tududi_state,'ready');assert.match(other.runtime.director.agent().tududi_email,/@deneme\.piksel-ofis\.local$/);const uid=c.office.agent(c.a.id).tududi_user_id!;c.store.db.prepare("UPDATE agents SET tududi_state='pending',tududi_token_encrypted=NULL WHERE id=?").run(c.a.id);assert.equal((await c.office.provision(c.a.id)).tududi_user_id,uid);
 await other.office.tududi.createUser('conflit@deneme.piksel-ofis.local','only-test','Autre');const conflict=await other.office.createAgent({...input(other.store.departments()[0].id),username:'conflit'});assert.equal(conflict.tududi_state,'pending');assert.equal(conflict.tududi_user_id,null);assert.ok(other.store.events().some(e=>e.agent_id===conflict.id && /başka bir hesapta kullanılıyor/.test(e.text)));const unowned=c.fake.users.find(u=>u.email==='conflit@deneme.piksel-ofis.local')!.id;await other.office.removeAgent(conflict.id,true);assert.ok(c.fake.users.some(u=>u.id===unowned),"Conflicting accounts from other offices cannot be deleted.");
 }finally{if(other)await other.app.close();cleanup(config);await c.close();}
});
test("B2.3: tool errors explain reasons in Turkish, deduplicate notices and hide secrets",async()=>{
 const c=await setup();try{
 c.runtime.enqueue(c.gm.id,'Elle','Kontrol');const l=c.runtime.claim('runner')!;for(let i=0;i<2;i++){const reply=await c.app.inject({method:'POST',url:'/api/agent-tools/yonetim_durum',headers:{authorization:`Bearer ${l.key}`},payload:{arguments:{alan:'yanlis'}}});assert.equal(reply.statusCode,400);}const errors=c.store.db.prepare("SELECT text FROM director_terminal WHERE run_id=? AND kind='error'").all(l.run.id);assert.equal(errors.length,1);assert.match(String(errors[0].text),/yonetim durum: Alanlar eksik veya geçersiz/);assert.ok(!String(errors[0].text).includes(l.key));
 }finally{await c.close();}
});
test("B2.3: initial greeting and tool schemas together stay below 20k estimated tokens",async()=>{
 const c=await setup();try{
 c.runtime.enqueue(c.gm.id,'Elle','merhaba');const l=c.runtime.claim('runner')!,schema=JSON.stringify(toolsForNames(l.toolNames));const m={istem_karakter:l.prompt.length,arac_semasi_karakter:schema.length,toplam_karakter:l.prompt.length+schema.length,tahmini_token:Math.ceil((l.prompt.length+schema.length)/4),yontem:'4 karakter ≈ 1 token; sağlayıcının yerleşik araç ve sistem ekleri dahil değil',gercek_model:false};assert.ok(m.tahmini_token<=20000);mkdirSync('.test-data/b23-validation',{recursive:true});writeFileSync('.test-data/b23-validation/ilk-girdi.json',JSON.stringify(m,null,2));
 }finally{await c.close();}
});
test("B2.3: ordinary-agent budget retries persist without duplicating the final chat response",async()=>{
 const c=await setup();try{
 c.store.db.prepare('UPDATE agents SET policy=? WHERE id=?').run(JSON.stringify({...defaultPolicy,inputTokenBudget:100}),c.a.id);c.runtime.enqueue(c.a.id,'Elle','Normal iş');const first=c.runtime.claim('runner')!;c.runtime.update(first.run.id,'usage','',{input_tokens:101});assert.equal(c.runtime.runs().length,2);c.runtime.finish(first.run.id,'completed','Aynı son metin','');const retry=c.runtime.claim('runner')!;assert.equal(retry.run.trigger,'Token sınırı sonrası taze oturumla tek yeniden deneme');c.runtime.finish(retry.run.id,'completed','Aynı son metin','');assert.equal(c.store.messages().filter(m=>m.sender_agent_id===c.a.id && m.text==='Aynı son metin').length,1);
 }finally{await c.close();}
});
test("B2.3: file handoffs cannot bypass resource checks; owned work is watched with auto off",async()=>{
 const c=await setup();try{
 c.runtime.enqueue(c.gm.id,'Elle','Devir');const l=c.runtime.claim('runner')!;await assert.rejects(()=>c.runtime.tool(l.run,'gorev_devret',{kime:c.a.id,baslik:'Kod',aciklama:'Özellik geliştir',kaynaklar,kabul:'Testler geçsin'}),/İş açılmadı/);assert.equal(c.store.snapshot().handoffs.length,0);
 const note=await c.office.tududi.note(c.office.token(c.gm.id),{title:'İş belgesi',content:'Tek satır selamlama hazırla'});const h:any=await c.runtime.tool(l.run,'gorev_devret',{kime:c.a.id,baslik:'Selam',aciklama:'Tek satır selamlama hazırla. '+'.'.repeat(400),not_kimligi:note.uid,kaynaklar,kabul:'Türkçe bir satır'});assert.ok(h.id);assert.match(h.description,/Kabul ölçütü: Türkçe bir satır/);assert.match(h.description,/Kaynak eksikse dur ve Genel Müdür/);c.runtime.finish(l.run.id,'completed','Verildi','');const a=c.runtime.claim('runner')!;c.runtime.finish(a.run.id,'completed','Hazır','');assert.ok(c.runtime.director.flush()!.director_followup);
 }finally{await c.close();}
});
test("B2.3: real event timers start light follow-ups; restart cannot duplicate a task's follow-up",async()=>{
 const c=await setup();let reopened:Awaited<ReturnType<typeof createApp>>|undefined;try{
 c.runtime.enqueue(c.a.id,'Elle','İzlenecek');const a=c.runtime.claim('runner')!;c.runtime.director.watch(a.run.id,'kalici-is',true);await c.runtime.tool(a.run,'engel_bildir',{engel:'Kaynak belge yok'});
 const deadline=Date.now()+1000;while(!c.runtime.runs().some(r=>r.director_followup) && Date.now()<deadline)await new Promise(r=>setTimeout(r,10));assert.equal(c.runtime.runs().filter(r=>r.director_followup).length,1);c.runtime.finish(a.run.id,'failed','','Belge eksik');const report=c.runtime.claim('runner')!;assert.ok(report.run.director_followup);assert.ok(!report.toolNames?.includes('yonetim_islem'));assert.ok(!report.toolNames?.includes('gorev_devret'));c.runtime.finish(report.run.id,'completed','Kaynak belge bekleniyor','');
 await c.app.close();reopened=await createApp(c.config,{fetcher:c.fake.fetcher,background:false});reopened.runtime.director.observeRun(reopened.runtime.run(a.run.id));assert.equal(reopened.runtime.director.flush(),null);assert.equal(reopened.runtime.runs().filter(r=>r.director_followup).length,1);
 }finally{if(reopened)await reopened.app.close();else await c.app.close();cleanup(c.config);}
});
test("B2.3: late usage exhausting follow-up budget preserves queued reports and allows other agents",async()=>{
 const c=await setup();try{
 c.settings({director:{...defaultSettings.director!,followupTokenBudget:100}});c.runtime.enqueue(c.a.id,'Elle','Bir');let a=c.runtime.claim('runner')!;c.runtime.director.watch(a.run.id,'ilk',true);c.runtime.finish(a.run.id,'completed','Bitti','');c.runtime.director.flush();const f=c.runtime.claim('runner')!;c.runtime.finish(f.run.id,'completed','Rapor','');
 c.runtime.enqueue(c.a.id,'Elle','İki');a=c.runtime.claim('runner')!;c.runtime.director.watch(a.run.id,'ikinci',true);c.runtime.finish(a.run.id,'completed','Bitti','');const queued=c.runtime.director.flush()!;c.runtime.finish(f.run.id,'completed','','',{input_tokens:101});assert.equal(c.runtime.claim('runner'),null);assert.equal(c.runtime.run(queued.id).state,'queued');assert.match(c.runtime.run(queued.id).reason,/İş takibinin günlük/);c.runtime.enqueue(c.a.id,'Elle','Başka iş');assert.equal(c.runtime.claim('runner')!.agent.id,c.a.id);
 c.settings({director:{...defaultSettings.director!,followupTokenBudget:1000}});assert.equal(c.runtime.claim('runner')!.run.id,queued.id);
 }finally{await c.close();}
});
test("B2.3: email domain initializes once from environment; panel choice survives restart",async()=>{
 const config={...testConfig(),tududiEmailDomain:'deneme.piksel-ofis.local'},fake=fakeTududi();let c=await createApp(config,{fetcher:fake.fetcher,background:false});try{
 assert.equal(c.runtime.settings().emailDomain,'deneme.piksel-ofis.local');assert.match(c.runtime.director.agent().tududi_email,/@deneme\.piksel-ofis\.local$/);c.store.db.prepare('UPDATE runtime_settings SET json=?').run(JSON.stringify({...c.runtime.settings(),emailDomain:'ozel.example'}));await c.app.close();c=await createApp(config,{fetcher:fake.fetcher,background:false});assert.equal(c.runtime.settings().emailDomain,'ozel.example');
 }finally{await c.app.close();cleanup(config);}
});
