import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import {testConfig,fakeTududi,input,cleanup} from './helpers.js';
import {defaultPolicy,type FolderLink,type CommandLink} from '../shared/runtime.js';
import {promptFolders} from '../shared/folder-prompt.js';

async function setup(){
  const config=testConfig(),c=await createApp(config,{fetcher:fakeTududi().fetcher,background:false});
  const a=await c.office.createAgent({...input(c.store.departments()[0].id),name:'Kerem',policy:{...defaultPolicy,permission:'folders',commands:false}});
  await c.office.provision(c.runtime.director.agent().id);
  c.runtime.heartbeat('runner',{codex:['secilen-model','gpt-6.1-sol'],claude:[]});
  const folder:FolderLink={id:randomUUID(),name:'Çalışma kopyası (yazılabilir)',path:'/yalniz-deneme/kod',access:'write',approved_write:false,validation:'valid',agent_ids:[a.id],detail:'',documents:['docs/is.md'],documents_truncated:false};
  const command:CommandLink={id:randomUUID(),name:'Testler',folder_id:folder.id,directory:'ofis',command:'npm test',timeout_seconds:30,write:false,approval:false,agent_ids:[a.id]};
  const save=()=>{c.store.db.prepare('INSERT OR REPLACE INTO folder_links VALUES (?,?)').run(folder.id,JSON.stringify(folder));c.store.db.prepare('INSERT OR REPLACE INTO command_links VALUES (?,?)').run(command.id,JSON.stringify(command));};save();
  c.runtime.enqueue(c.runtime.director.agent().id,'Elle','Dar hata düzeltme');const gm=c.runtime.claim('runner')!;
  const job=(belgeler?:{klasor:string;yol:string}[],extra:Record<string,unknown>={})=>({islem:'ajan_calistir' as const,kimlik:a.id,veri:{text:'Yeni özellik geliştir',kabul:'Testler geçsin',kaynaklar:{klasorler:[folder.id],komutlar:[command.id],...(belgeler===undefined?{}:{belgeler}),...extra}}});
  const send=(action:ReturnType<typeof job>)=>c.runtime.tool(gm.run,'yonetim_islem',action);
  return {...c,a,folder,command,save,gm,job,send,close:async()=>{await c.app.close();cleanup(config);}};
}

test("E2BIG: prompts include only the first 200 documents; resource validation keeps the complete catalog",async()=>{
  const c=await setup();try{
    c.folder.documents=Array.from({length:1000},(_,i)=>`docs/belge-${i}.md`);c.folder.documents_truncated=true;c.save();
    const r:any=await c.send(c.job([{klasor:c.folder.id,yol:'docs/belge-999.md'}]));assert.ok(r.id);assert.ok(!r.uyarilar);
    c.runtime.finish(c.gm.run.id,'completed','','');const lease=c.runtime.claim('runner')!;
    const match=lease.prompt.match(/Klasörler: ([^\n]+)\nOnaylı/);assert.ok(match);
    const folders=JSON.parse(match[1]);assert.equal(folders[0].documents.length,200);
    assert.match(folders[0].belge_ozeti,/800 dosya daha/);assert.equal(folders[0].documents_truncated,true);
    assert.equal(lease.links[0].documents!.length,1000);assert.equal(c.runtime.links()[0].documents!.length,1000);
  }finally{await c.close();}
});

test("E2BIG: long Turkish document names obey byte caps; unknown catalogs are not marked complete",()=>{
  const folder={id:'deneme',documents:Array.from({length:1000},(_,i)=>`docs/${'ş'.repeat(200)}-${i}.md`),documents_truncated:false} as FolderLink;
  const short=promptFolders([folder])[0];assert.ok(short.documents!.length<200);assert.ok(short.documents!.length>0);
  assert.ok(Buffer.byteLength(JSON.stringify(short.documents))<17*1024);assert.equal(short.documents_truncated,true);
  assert.equal(folder.documents!.length,1000);assert.equal(folder.documents_truncated,false);
  const unknown=promptFolders([{id:'bilinmeyen'} as FolderLink])[0];assert.equal(unknown.documents,undefined);assert.match(unknown.belge_ozeti,/henüz alınmadı/);
});

test("B2.3.2: registered tests run without documents even when the legacy commands flag is off",async()=>{
  const c=await setup();try{
    const job=c.job([]);Object.assign(job.veri,{secenekler:{acceptance:[c.command.id]}});
    const r:any=await c.send(job);assert.ok(r.id);assert.equal(c.office.agent(c.a.id).policy?.commands,false);
    assert.deepEqual(c.runtime.workOptions(r.id).acceptance,[c.command.id]);
    assert.match(c.runtime.run(r.id).summary,/"belgeler":\[\]/);assert.ok(!r.uyarilar);
    c.runtime.finish(c.gm.run.id,'completed','İş verildi','');const lease=c.runtime.claim('runner')!;assert.equal(lease.run.id,r.id);
    assert.ok(lease.toolNames?.includes('komut_calistir'));
    assert.equal(lease.acceptanceCommands?.[0].id,c.command.id);
    const result:any=await c.runtime.tool(lease.run,'komut_calistir',{ad:'Testler'});assert.ok(result.komut_is);
    const actual=c.runtime.a3.jobs().find(j=>j.id===result.komut_is)!;assert.equal(actual.command.directory,'ofis');assert.equal(actual.folder.id,c.folder.id);
  }finally{await c.close();}
});
test("B2.3.2: development work can omit the documents field",async()=>{
  const c=await setup();try{const r:any=await c.send(c.job());assert.ok(r.id);assert.match(c.runtime.run(r.id).summary,/"belgeler":\[\]/);}finally{await c.close();}
});
test("B2.3.2: unknown paths in a truncated 1000-file catalog warn the Director and agent instead of rejecting",async()=>{
  const c=await setup();try{
    c.folder.documents=Array.from({length:1000},(_,i)=>`a/${i}.md`);c.folder.documents_truncated=true;c.save();
    const doc={klasor:c.folder.id,yol:'docs/kurulum-notlari.md'};
    const catalogue:any=await c.runtime.tool(c.gm.run,'yonetim_durum',{alan:'baglantilar',kimlik:c.folder.id,ayrinti:true,tur:doc.yol});
    assert.equal(catalogue.klasorler[0].belge_sayisi,1000);assert.equal(catalogue.klasorler[0].documents_truncated,true);assert.deepEqual(catalogue.klasorler[0].documents,[]);
    const r:any=await c.send(c.job([doc]));assert.ok(r.id);assert.match(r.uyarilar[0],/kurulum-notlari.md.*Çalışma kopyası.*kesildiği.*doğrulanamadı/);
    assert.match(c.runtime.run(r.id).summary,/Kaynak uyarıları:.*doğrulanamadı/);assert.match(c.runtime.run(r.id).summary,/Kaynak eksikse dur/);
  }finally{await c.close();}
});
test("B2.3.2: empty truncated catalogs warn for unknown documents but not known ones",async()=>{
  const c=await setup();try{
    c.folder.documents=[];c.folder.documents_truncated=true;c.save();const r:any=await c.send(c.job([{klasor:c.folder.id,yol:'docs/is.md'}]));assert.ok(r.id);assert.match(r.uyarilar[0],/doğrulanamadı/);
    c.folder.documents=['docs/is.md'];c.save();const prepared=c.runtime.director.prepareAssignment(c.job([{klasor:c.folder.id,yol:'docs/is.md'}]));assert.deepEqual(prepared.uyarilar,[]);
  }finally{await c.close();}
});
test("B2.3.2: complete catalogs reject missing documents, commands and folders with names/reasons",async()=>{
  const c=await setup();try{
    await assert.rejects(()=>c.send(c.job([{klasor:c.folder.id,yol:'docs/yok.md'}])),/Belge “docs\/yok.md”, klasör “Çalışma kopyası \(yazılabilir\)”:.*tam listede.*bulunamadı/);
    c.store.db.prepare('DELETE FROM command_links WHERE id=?').run(c.command.id);
    await assert.rejects(()=>c.send(c.job([])),e=>{assert.ok(e instanceof Error);assert.ok(e.message.includes(c.command.id));assert.match(e.message,/komut kaydı bulunamadı/);return true;});
    c.save();const absent=randomUUID();await assert.rejects(()=>c.send(c.job([],{klasorler:[absent]})),e=>{assert.ok(e instanceof Error);assert.ok(e.message.includes(absent));assert.match(e.message,/klasör kaydı bulunamadı/);return true;});
    assert.equal(c.runtime.runs().length,1);assert.equal(c.runtime.a3.jobs().length,0);
  }finally{await c.close();}
});
test("B2.3.2: wrong agents, invalid folders, tool groups and write permissions produce named command errors",async()=>{
  const c=await setup();try{
    c.command.agent_ids=[];c.save();await assert.rejects(()=>c.send(c.job([])),/Komut “Testler”: Kerem adlı ajana atanmamış/);
    c.command.agent_ids=[c.a.id];c.folder.validation='pending';c.save();await assert.rejects(()=>c.send(c.job([])),/Komut “Testler”, klasör “Çalışma kopyası.*doğrulaması bekleniyor/);
    c.folder.validation='valid';c.folder.agent_ids=[];c.save();await assert.rejects(()=>c.send(c.job([])),/Komut “Testler”, klasör “Çalışma kopyası.*Kerem adlı ajana atanmamış/);
    c.folder.agent_ids=[c.a.id];c.save();c.store.db.prepare('UPDATE agents SET tool_groups=? WHERE id=?').run(JSON.stringify(['messages']),c.a.id);await assert.rejects(()=>c.send(c.job([])),/Komut “Testler”: Kerem adlı ajanın kayıtlı komut aracı kapalı/);
    c.store.db.prepare('UPDATE agents SET tool_groups=NULL WHERE id=?').run(c.a.id);c.command.write=true;c.folder.approved_write=true;c.save();await assert.rejects(()=>c.send(c.job([])),/Komut “Testler”, klasör “Çalışma kopyası.*doğrudan yazma izni yok/);
    c.folder.approved_write=false;c.save();assert.ok((await c.send(c.job([])) as any).id);
  }finally{await c.close();}
});
test("B2.3.2: approved registered commands may open work but execution approval cannot be bypassed",async()=>{
  const c=await setup();try{
    c.command.approval=true;c.save();const r:any=await c.send(c.job([]));assert.ok(r.id);assert.match(r.uyarilar[0],/Testler.*onay istenecek/);
    c.runtime.finish(c.gm.run.id,'completed','','');const lease=c.runtime.claim('runner')!;const result:any=await c.runtime.tool(lease.run,'komut_calistir',{ad:'Testler'});
    assert.ok(result.onay);assert.equal(c.runtime.run(r.id).state,'waiting');assert.equal(c.runtime.a3.jobs().length,0);
  }finally{await c.close();}
});
test("B2.3.2: truncated catalogs still reject unsafe paths and identify missing fields",async()=>{
  const c=await setup();try{
    c.folder.documents=[];c.folder.documents_truncated=true;c.save();
    for(const yol of ['../disari.md','/disari.md','C:\\disari.md','docs/../disari.md'])await assert.rejects(()=>c.send(c.job([{klasor:c.folder.id,yol}])),/Belge.*güvenli bir göreli yol değil/);
    for(const yol of ['.env','docs/.env.local','.codex/ayarlar'])await assert.rejects(()=>c.send(c.job([{klasor:c.folder.id,yol}])),/Belge.*gizli dosya veya klasör/);
    const job=c.job([]);delete (job.veri as any).kabul;await assert.rejects(()=>c.send(job),/kabul: bitiş ölçütü eksik veya geçersiz/);
    const invalid=c.job([]);(invalid.veri.kaynaklar as any).komutlar=['Testler'];await assert.rejects(()=>c.send(invalid),/kaynaklar.komutlar.0: alan eksik veya geçersiz/);
  }finally{await c.close();}
});
test("B2.3.2: missing write and linked-folder access identify the rejected folder",async()=>{
  const c=await setup();try{
    c.folder.access='read';c.save();await assert.rejects(()=>c.send(c.job([])),/Klasör “Çalışma kopyası \(yazılabilir\)”:.*yazma izni eksik/);
    c.folder.access='write';c.save();c.store.db.prepare('UPDATE agents SET policy=? WHERE id=?').run(JSON.stringify({...defaultPolicy,permission:'workspace'}),c.a.id);
    await assert.rejects(()=>c.send(c.job([])),/Komut “Testler”, klasör “Çalışma kopyası.*Kerem adlı ajanın bağlı klasör erişimi kapalı/);
  }finally{await c.close();}
});
test("B2.3.2: batch assignment preserves truncated-catalog warnings in the Director reply",async()=>{
  const c=await setup();try{
    c.folder.documents=[];c.folder.documents_truncated=true;c.save();
    const result:any=await c.runtime.tool(c.gm.run,'yonetim_islem',{islemler:[c.job([{klasor:c.folder.id,yol:'docs/is.md'}])]});
    assert.equal(result.tamamlandi,true);assert.ok(result.sonuclar[0].sonuc.id);assert.match(result.sonuclar[0].sonuc.uyarilar[0],/docs\/is.md.*doğrulanamadı/);
  }finally{await c.close();}
});
test("B2.3.2: missing or approval-protected acceptance commands report names and distinct reasons",async()=>{
  const c=await setup();try{
    c.command.approval=true;c.save();const job=c.job([]);Object.assign(job.veri,{secenekler:{acceptance:[c.command.id]}});
    await assert.rejects(()=>c.send(job),/Kabul komutu “Testler”:.*otomatik bitiş kontrolü onaysız olmalı/);
    const absent=randomUUID();Object.assign(job.veri,{secenekler:{acceptance:[absent]}});
    await assert.rejects(()=>c.send(job),e=>{assert.ok(e instanceof Error);assert.ok(e.message.includes(absent));assert.match(e.message,/komut kaydı bulunamadı/);return true;});
    assert.equal(c.runtime.runs().length,1);
  }finally{await c.close();}
});
