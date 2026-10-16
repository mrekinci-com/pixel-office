import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { testConfig,cleanup,fakeTududi,input } from './helpers.js';
import { randomUUID } from 'node:crypto';
import { defaultSettings } from '../shared/runtime.js';
async function setup(){let now=Date.now();const config={...testConfig(),runnerKey:'fake-b2-runner-key-'.repeat(3)},fake=fakeTududi(),c=await createApp(config,{fetcher:fake.fetcher,background:false,scheduleClock:()=>now});const login=await c.app.inject({method:'POST',url:'/api/login',headers:{'x-ofis-islem':'1'},payload:{password:config.ownerPassword}});const headers={cookie:String(login.headers['set-cookie']).split(';')[0],'x-ofis-islem':'1'};const api=(url:string,method:any='GET',payload?:any)=>c.app.inject({url,method,headers,payload});const department=randomUUID();c.store.db.prepare('INSERT INTO departments(id,name,description,color,sort_order) VALUES (?,?,?,?,?)').run(department,'Ekip','','#498f87',1);const a=await c.office.createAgent({...input(department),name:'Deniz'});c.runtime.heartbeat('runner',{codex:['gpt-6.1-sol','secilen-model'],claude:['sonnet']});return {...c,config,fake,a,department,api,advance:(ms:number)=>{now+=ms;c.runtime.heartbeat('runner');},gm:c.runtime.director.agent(),close:async()=>{await c.app.close();cleanup(config);}};}
test("B2: one undeletable Director; management schemas/calls require its run key",async()=>{const c=await setup();try{
 assert.equal(c.store.agents().filter(a=>a.builtin==='director').length,1);assert.equal(c.gm.session_mode,'persistent');assert.equal((await c.api(`/api/agents/${c.gm.id}?account=keep`,'DELETE')).statusCode,403);
 c.runtime.enqueue(c.a.id,'Elle','Yetki');const l=c.runtime.claim('runner')!;assert.ok(!l.toolNames?.includes('yonetim_islem'));await assert.rejects(()=>c.runtime.tool(l.run,'yonetim_durum',{}),/yalnız yetkili/);
 const list=await c.app.inject({url:'/api/agent-tools/catalog',headers:{authorization:`Bearer ${l.key}`}});assert.ok(!list.json().names.some((n:string)=>n.startsWith('yonetim_')));c.runtime.finish(l.run.id,'completed','Bitti','');
 c.runtime.enqueue(c.gm.id,'Elle','Yönet');const gm=c.runtime.claim('runner')!;assert.ok(gm.toolNames?.includes('yonetim_islem'));
 const made:any=await c.runtime.tool(gm.run,'yonetim_islem',{islem:'bolum_olustur',veri:{name:'Tasarım',color:'#336699'}});assert.ok(made.id);
 assert.equal((await c.api('/api/departments','POST',{name:'',color:'kötü'})).statusCode,400);await assert.rejects(()=>c.runtime.tool(gm.run,'yonetim_islem',{islem:'bolum_olustur',veri:{name:'',color:'kötü'}}),/Alanları/);
 assert.ok(c.store.events().some(e=>e.kind==='director_action' && e.text.includes('Bölüm oluşturuldu')));assert.equal(c.store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n,1);
}finally{await c.close();}});
test("B2: shortcuts call no model; persistent conversation and ledger survive renewal",async()=>{const c=await setup();try{
 for(const text of ['/durum','/ajanlar','/kuyruk','/kullanim','/onaylar','/yardim','/yenile','/oto aç','/oto kapat']){const res=await c.api('/api/director/input','POST',{text});assert.equal(res.statusCode,200,res.body);assert.equal(res.json().local,true);}assert.equal(c.runtime.runs().length,0);
 await c.runtime.director.ledger('Açık iş: Deniz. Sıradaki: ölçümü incele.');await c.api('/api/director/input','POST',{text:'Bu işi yap'});const l=c.runtime.claim('runner')!;assert.equal(l.agent.id,c.gm.id);assert.match(l.prompt,/Açık iş: Deniz/);const provider=randomUUID();c.runtime.a3.recordSession(l.run,provider,1);await c.runtime.tool(l.run,'yonetim_defteri',{metin:'Deniz için ilk cevap doğrulandı; sıradaki adım devam etmek.'});c.runtime.finish(l.run.id,'completed','İlk cevap','');
 await c.api('/api/director/input','POST',{text:'Devam et'});const next=c.runtime.claim('runner')!;assert.equal(next.session?.provider_id,provider);await c.runtime.tool(next.run,'yonetim_defteri',{metin:'Deniz için ikinci cevap doğrulandı; açık iş yok.'});c.runtime.finish(next.run.id,'completed','İkinci cevap','');await c.api('/api/director/input','POST',{text:'/yenile'});
 const transcript=(await c.api('/api/director')).json();assert.ok(transcript.logs.some((l:any)=>l.text.includes('İlk cevap')));assert.ok(c.runtime.director.state().ledger.includes('Deniz'));
}finally{await c.close();}});
test("B2: owner decisions, destructive approvals and 24-hour trash/restore",async()=>{const c=await setup();try{
 c.runtime.enqueue(c.gm.id,'Elle','Yönet');let l=c.runtime.claim('runner')!;const p:any=await c.runtime.tool(l.run,'yonetim_islem',{islem:'ajan_sil',kimlik:c.a.id});assert.ok(p.onay);assert.ok(c.store.agents().some(a=>a.id===c.a.id));const pending=c.runtime.approvals().find(a=>a.id===p.onay)!;
 assert.throws(()=>c.runtime.decide(pending.id,true,'','director'),/sahibe/);const decided=await c.api(`/api/approvals/${pending.id}/decision`,'POST',{approved:true});assert.equal(decided.statusCode,200,decided.body);assert.ok(!c.store.agents().some(a=>a.id===c.a.id));assert.equal((await c.api('/api/trash')).json().length,1);
 assert.equal((await c.api(`/api/trash/${c.a.id}/restore`,'POST',{})).statusCode,200);assert.ok(c.store.agents().some(a=>a.id===c.a.id));l=c.runtime.claim('runner')!;
 await assert.rejects(()=>c.runtime.tool(l.run,'yonetim_islem',{islem:'ayarlar_duzenle',veri:{director:{ownerApprovalTypes:[]}}}),/yalnız sahip/);
 const a={...pending,id:randomUUID(),type:'spending',state:'pending' as const};c.runtime.saveApproval(a);await assert.rejects(()=>c.runtime.tool(l.run,'yonetim_islem',{islem:'onay_karari',kimlik:a.id,veri:{approved:true}}),/sahibe/);
}finally{await c.close();}});
test("B2: merged event batches, one Director, daily token brake and third redirection",async()=>{const c=await setup();try{
 await c.api('/api/runtime/settings','PUT',{...defaultSettings,language:'tr',director:{...defaultSettings.director!,batchSeconds:1,hourlyRuns:1,dailyTokenBudget:10}});c.runtime.director.setAuto(true);c.runtime.director.signal('work_result','bir','Bitti');c.runtime.director.signal('work_result','bir','Son bilgi');c.runtime.director.signal('agent_blocker','iki','Engel');assert.equal(c.runtime.director.pending().length,2);
 const r=c.runtime.director.flush()!;assert.ok(r);assert.equal(c.runtime.director.pending().length,0);c.runtime.director.signal('work_result','uc','Yeni');assert.equal(c.runtime.director.flush(),null);const l=c.runtime.claim('runner')!;c.runtime.finish(l.run.id,'completed','Kontrol edildi','',{input_tokens:10});assert.equal(c.runtime.director.state().auto,false);assert.ok(c.store.events().some(e=>e.text.includes('günlük token')));
 c.advance(86400000);c.runtime.director.setAuto(true);c.runtime.director.redirect('aynı iş');c.runtime.director.redirect('aynı iş');c.runtime.director.redirect('aynı iş');assert.throws(()=>c.runtime.director.redirect('aynı iş'),/Üçüncü/);assert.equal(c.runtime.director.state().auto,false);c.runtime.director.setAuto(true);c.runtime.stop();assert.equal(c.runtime.director.state().auto,false);
}finally{await c.close();}});
test("B2: ordinary agents cannot use management tools; server enforces tool groups",async()=>{const c=await setup();try{
 c.store.db.prepare('UPDATE agents SET tool_groups=? WHERE id=?').run(JSON.stringify(['messages']),c.a.id);c.runtime.enqueue(c.a.id,'Elle','Dar araçlar');const l=c.runtime.claim('runner')!;
 assert.ok(!l.toolNames?.some(n=>n.startsWith('tududi_') || n.startsWith('hafiza_')));
 for(const name of ['yonetim_durum','yonetim_islem','yonetim_defteri','yonetim_izle'] as const){const r=await c.app.inject({method:'POST',url:'/api/agent-tools/'+name,headers:{authorization:`Bearer ${l.key}`},payload:{arguments:{}}});assert.equal(r.statusCode,403,r.body);}
 await assert.rejects(()=>c.runtime.tool(l.run,'hafiza_yaz',{metin:'Kaçak araç'}),/yalnız yetkili/);assert.equal(c.runtime.memory(c.a.id),'');
 const forged=await c.api('/api/agents','POST',{...input(c.department),name:'Sahte Müdür',builtin:'director'});assert.equal(forged.statusCode,400);assert.equal(c.store.agents().filter(a=>a.builtin==='director').length,1);
}finally{await c.close();}});
test("B2: model/effort/prepared input are run-scoped; MCP replies include the 80-percent warning",async()=>{const c=await setup();try{
 c.runtime.models.codex.push('ucuz-model');c.runtime.enqueue(c.gm.id,'Elle','Dar bir iş ver');const gm=c.runtime.claim('runner')!;
 const r:any=await c.runtime.tool(gm.run,'yonetim_islem',{islem:'ajan_calistir',kimlik:c.a.id,veri:{kaynaklar:{klasorler:[],komutlar:[],belgeler:[]},kabul:'Kontrol sonucu raporlandı',text:'Dosyayı kontrol et',secenekler:{model:'ucuz-model',effort:'low',prepared:'İlgili dosya: deneme.ts. Ölçüm: sıfır hata.'},is:'dar-is'}});
 const l=c.runtime.claim('runner')!;assert.equal(l.run.id,r.id);assert.equal(l.agent.model,'ucuz-model');assert.equal(l.agent.effort,'low');assert.equal(c.office.agent(c.a.id).model,'secilen-model');assert.match(l.prompt,/İlgili dosya: deneme.ts/);
 c.runtime.update(l.run.id,'usage','Kullanım',{input_tokens:80000});const answer=await c.app.inject({method:'POST',url:'/api/agent-tools/hafiza_oku',headers:{authorization:`Bearer ${l.key}`},payload:{arguments:{}}});assert.equal(answer.statusCode,200);assert.match(answer.json().notice,/toparla ve bitir/);assert.deepEqual(answer.json().result,{metin:''});
 const again=await c.app.inject({method:'POST',url:'/api/agent-tools/hafiza_oku',headers:{authorization:`Bearer ${l.key}`},payload:{arguments:{}}});assert.equal(again.json().notice,undefined);assert.equal(c.runtime.run(l.run.id).state,'running');
 await assert.rejects(()=>c.runtime.tool(gm.run,'yonetim_islem',{islem:'ajan_calistir',kimlik:c.a.id,veri:{kaynaklar:{klasorler:[],komutlar:[],belgeler:[]},kabul:'Sonuç',text:'Yanlış model',secenekler:{model:'bildirilmemis-model'}}}),/bildirdiği modellerden/);
}finally{await c.close();}});
test("B2: folder proposals require owner approval through shared panel validation",async()=>{const c=await setup();try{
 c.runtime.enqueue(c.gm.id,'Elle','Klasör öner');const l=c.runtime.claim('runner')!;
 const proposal:any=await c.runtime.tool(l.run,'yonetim_islem',{islem:'klasor_oner',veri:{name:'Deneme',path:'/yalniz-deneme/kod',access:'read',agent_ids:[c.a.id]}});assert.ok(proposal.onay);assert.equal(c.runtime.links().length,0);
 assert.equal((await c.api(`/api/approvals/${proposal.onay}/decision`,'POST',{approved:true})).statusCode,200);assert.equal(c.runtime.links().length,1);assert.equal(c.runtime.links()[0].validation,'pending');
 const next=c.runtime.claim('runner')!;await assert.rejects(()=>c.runtime.tool(next.run,'yonetim_islem',{islem:'komut_olustur',veri:{name:'Kontrol',folder_id:c.runtime.links()[0].id,command:'test',agent_ids:[c.a.id]}}),/doğrulanmış/);
 assert.equal(c.runtime.a3.commands().length,0);
}finally{await c.close();}});
test("B2: hourly brake preserves events; agent messages cannot start the Director with auto off",async()=>{const c=await setup();try{
 await c.api('/api/runtime/settings','PUT',{...defaultSettings,language:'tr',director:{...defaultSettings.director!,batchSeconds:1,hourlyRuns:1}});c.runtime.director.setAuto(true);c.runtime.director.signal('work_result','ilk','Bitti');const root=c.runtime.director.flush()!;assert.ok(root);const l=c.runtime.claim('runner')!;await c.runtime.tool(l.run,'yonetim_defteri',{metin:'İlk sonuç kontrol edildi; sıradaki sonuç bekleniyor.'});c.runtime.finish(l.run.id,'completed','Kontrol edildi','');c.advance(2000);c.runtime.director.signal('work_result','ikinci','Bitti');assert.equal(c.runtime.director.flush(),null);assert.equal(c.runtime.director.pending().length,1);c.advance(3600000);assert.ok(c.runtime.director.flush());
 c.runtime.director.setAuto(false);c.runtime.enqueue(c.a.id,'Elle','GM mesajı');const a=c.runtime.claim('runner')!;await c.runtime.tool(a.run,'mesaj_gonder',{kime:c.gm.id,metin:'Bana cevap ver',cevap_bekleniyor:true});assert.ok(!c.runtime.runs().some(r=>r.agent_id===c.gm.id && ['queued','running'].includes(r.state)));
}finally{await c.close();}});
test("B2: sessions and ledger survive server restart without duplicate accounts",async()=>{const c=await setup();let second:Awaited<ReturnType<typeof createApp>>|undefined;try{
 await c.office.provision(c.gm.id);await c.runtime.director.ledger('Açık iş: kalıcı kayıt; sıradaki adım: inceleme.');c.runtime.director.entry('text','Yenilemeden önceki cevap');const noteCount=(await c.office.tududi.read(c.office.token(c.gm.id))).notes.filter(n=>n.title==='Durum defteri').length;assert.equal(noteCount,1);
 await c.app.close();second=await createApp(c.config,{fetcher:c.fake.fetcher,background:false});assert.equal(second.runtime.director.agent().id,c.gm.id);assert.match(second.runtime.director.state().ledger,/kalıcı kayıt/);assert.equal(second.store.agents().filter(a=>a.builtin==='director').length,1);assert.equal(c.fake.users.length,2);assert.equal(second.store.db.prepare("SELECT COUNT(*) AS n FROM director_terminal WHERE text='Yenilemeden önceki cevap'").get()!.n,1);
 await second.runtime.director.ledger('Açık iş: yok; inceleme tamamlandı.');assert.equal((await second.office.tududi.read(second.office.token(c.gm.id))).notes.filter(n=>n.title==='Durum defteri').length,1);
}finally{if(second)await second.app.close();else await c.app.close();cleanup(c.config);}});
test("B2: third redirection waits for the owner; owner decision releases the brake",async()=>{const c=await setup();try{
 c.runtime.enqueue(c.gm.id,'Elle','Tekrarlayan iş');const l=c.runtime.claim('runner')!;for(let i=0;i<3;i++)c.runtime.director.redirect('tekrar-is',l.run);assert.throws(()=>c.runtime.director.redirect('tekrar-is',l.run),/Üçüncü/);
 const a=c.runtime.approvals().find(a=>a.type==='director_retry')!;assert.ok(a);assert.equal(c.runtime.run(l.run.id).state,'waiting');assert.equal(c.runtime.director.ownerOnly(a),true);const res=await c.api(`/api/approvals/${a.id}/decision`,'POST',{approved:true,note:'Kapsamı daraltarak bir kez daha dene.'});assert.equal(res.statusCode,200,res.body);assert.equal(c.store.db.prepare('SELECT 1 FROM director_redirects WHERE work_key=?').get('tekrar-is'),undefined);assert.ok(c.runtime.runs().some(r=>r.agent_id===c.gm.id && r.state==='queued' && !r.director_auto));
}finally{await c.close();}});
test("B2: added acceptance-command approval requirements are checked before work starts",async()=>{const c=await setup();try{
 c.store.db.prepare('UPDATE agents SET policy=? WHERE id=?').run(JSON.stringify({...c.a.policy,permission:'folders'}),c.a.id);
 const folder={id:randomUUID(),name:'Deneme',path:'/yalniz-deneme/kod',access:'read',approved_write:true,validation:'valid',agent_ids:[c.a.id],detail:''};c.store.db.prepare('INSERT INTO folder_links VALUES (?,?)').run(folder.id,JSON.stringify(folder));
 const cmd={id:randomUUID(),name:'Kabul',folder_id:folder.id,directory:'.',command:'sabit-kontrol',timeout_seconds:30,write:false,approval:false,agent_ids:[c.a.id]};c.store.db.prepare('INSERT INTO command_links VALUES (?,?)').run(cmd.id,JSON.stringify(cmd));const r=c.runtime.enqueue(c.a.id,'Elle','Kabul kapısı')!;c.runtime.setWorkOptions(r.id,{acceptance:[cmd.id]});c.store.db.prepare('UPDATE command_links SET json=? WHERE id=?').run(JSON.stringify({...cmd,approval:true}),cmd.id);
 assert.equal(c.runtime.claim('runner'),null);assert.equal(c.runtime.run(r.id).state,'failed');assert.equal(c.runtime.run(r.id).started_at,null);assert.match(c.runtime.run(r.id).reason,/onaysız/);
}finally{await c.close();}});
test("B2: acceptance evidence supports release-ready cards; the owner still decides",async()=>{const c=await setup();try{
 c.runtime.enqueue(c.gm.id,'Elle','Kanıtlı rapor');const l=c.runtime.claim('runner')!;c.runtime.log(l.run.id,'acceptance_result',JSON.stringify({command:randomUUID(),ad:'Kabul',cikis:0,cikti:'Geçti'}));const card:any=await c.runtime.tool(l.run,'yayina_hazir',{karar:'KABUL — kayıtlı kabul ölçütü geçti.'});assert.equal(card.type,'release_ready');assert.equal(c.runtime.director.ownerOnly(card),true);assert.throws(()=>c.runtime.decide(card.id,true,'','director'),/sahibe/);
}finally{await c.close();}});
test("B2: Director can update all agents' tasks/projects/notes and its own memory",async()=>{const c=await setup();try{
 const token=c.office.token(c.a.id),task=await c.office.tududi.task(token,{name:'Eski görev'}),project=await c.office.tududi.project(token,'Eski proje'),note=await c.office.tududi.note(token,{title:'Eski not',content:'Önceki içerik'});c.runtime.enqueue(c.gm.id,'Elle','Verileri düzenle');const l=c.runtime.claim('runner')!;
 await c.runtime.tool(l.run,'yonetim_islem',{islem:'gorev_guncelle',ajan:c.a.id,kimlik:task.uid,veri:{name:'Yeni görev',description:'Dar ve doğrulanmış kapsam',status:1,project_uid:project.uid}});
 await c.runtime.tool(l.run,'yonetim_islem',{islem:'proje_duzenle',ajan:c.a.id,kimlik:project.uid,veri:{name:'Yeni proje',description:'Yeni kapsam'}});
 await c.runtime.tool(l.run,'yonetim_islem',{islem:'not_duzenle',ajan:c.a.id,kimlik:note.uid,veri:{title:'Yeni not',content:'Doğrulanmış yeni içerik'}});
 await c.runtime.tool(l.run,'yonetim_islem',{islem:'ajan_hafiza_yaz',kimlik:c.a.id,veri:{text:'Doğrulanmış kısa hafıza'}});
 const d=await c.office.tududi.read(token);assert.equal(d.tasks[0].name,'Yeni görev');assert.match(d.tasks[0].description!,/Dar ve doğrulanmış/);assert.equal(d.projects.find(p=>p.uid===project.uid)?.name,'Yeni proje');assert.equal(d.notes.find(n=>n.uid===note.uid)?.content,'Doğrulanmış yeni içerik');assert.equal(c.runtime.memory(c.a.id),'Doğrulanmış kısa hafıza');
}finally{await c.close();}});
test("B2: delegated folder decisions apply pending proposals through the same validation",async()=>{const c=await setup();try{
 c.runtime.enqueue(c.gm.id,'Elle','Klasör');const l=c.runtime.claim('runner')!;const proposal:any=await c.runtime.tool(l.run,'yonetim_islem',{islem:'klasor_oner',veri:{name:'Deneme',path:'/yalniz-deneme/kod',access:'read',agent_ids:[c.a.id]}});await c.api('/api/runtime/settings','PUT',{...defaultSettings,language:'tr',director:{...defaultSettings.director!,ownerApprovalTypes:[]}});
 c.runtime.enqueue(c.gm.id,'Elle','Bekleyen öneriyi uygula');const next=c.runtime.claim('runner')!;await c.runtime.tool(next.run,'yonetim_islem',{islem:'onay_karari',kimlik:proposal.onay,veri:{approved:true}});assert.equal(c.runtime.links().length,1);assert.equal(c.runtime.approvals().find(a=>a.id===proposal.onay)?.state,'applied');
}finally{await c.close();}});
test("B2: automatic Director completion requires a ledger and informs the owner without looping",async()=>{const c=await setup();try{
 c.runtime.director.setAuto(true);c.runtime.director.signal('work_result','defter-denemesi','Kontrol gerekli');const root=c.runtime.director.flush()!;const l=c.runtime.claim('runner')!;assert.equal(l.run.id,root.id);c.runtime.finish(l.run.id,'completed','Bitti iddiası','');assert.equal(c.runtime.run(l.run.id).state,'failed');assert.equal(c.runtime.director.state().auto,false);assert.match(c.runtime.run(l.run.id).reason,/durum defterini/);assert.equal(c.runtime.runs().filter(r=>r.state==='queued').length,0);
}finally{await c.close();}});
test("B2: after 24 hours delete only the selected test account and disable restore",async()=>{const c=await setup();try{
 assert.equal((await c.api(`/api/agents/${c.a.id}?account=delete&profile=delete&trash=1`,'DELETE')).statusCode,200);assert.equal(c.fake.users.length,1);c.advance(86400001);await c.runtime.director.expireTrash();assert.equal(c.fake.users.length,0);assert.equal(c.store.agent(c.a.id),undefined);assert.equal((await c.api(`/api/trash/${c.a.id}/restore`,'POST',{})).statusCode,404);assert.ok(c.store.db.prepare('SELECT 1 FROM profile_deletions WHERE agent_id=?').get(c.a.id));assert.equal(c.runtime.director.agent().id,c.gm.id);
}finally{await c.close();}});
test("B2: invalid or Director-deleting destructive proposals fail before asking the owner",async()=>{const c=await setup();try{
 c.runtime.enqueue(c.gm.id,'Elle','Öneri doğrulaması');const l=c.runtime.claim('runner')!;
 await assert.rejects(()=>c.runtime.tool(l.run,'yonetim_islem',{islem:'ajan_sil',kimlik:c.gm.id}),/silinemez/);
 await assert.rejects(()=>c.runtime.tool(l.run,'yonetim_islem',{islem:'bolum_sil',kimlik:c.department}),/ajan var/);
 await assert.rejects(()=>c.runtime.tool(l.run,'yonetim_islem',{islem:'kurallar_duzenle',veri:{text:42}}));
 await assert.rejects(()=>c.runtime.tool(l.run,'yonetim_islem',{islem:'klasor_oner',veri:{name:'',path:'/deneme',access:'read',agent_ids:[]}}));
 assert.equal(c.runtime.approvals().length,0);assert.equal(c.runtime.run(l.run.id).state,'running');
}finally{await c.close();}});
