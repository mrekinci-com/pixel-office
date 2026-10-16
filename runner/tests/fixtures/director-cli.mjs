import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
const [profile,role,summary]=process.argv.slice(2),cfg=JSON.parse(readFileSync(profile+'/mcp.json','utf8')).mcpServers.ofis;
const path=profile+'/b2-session.json',session=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{id:randomUUID()};writeFileSync(path,JSON.stringify(session),{mode:0o600});
console.log(JSON.stringify({type:'thread.started',thread_id:session.id}));
const mcp=spawn(cfg.command,cfg.args,{env:{...cfg.env,BRIDGE_DIR:process.env.BRIDGE_DIR,NODE_OPTIONS:process.env.NODE_OPTIONS},stdio:['pipe','pipe','pipe']});
let id=0;const replies=new Map();createInterface({input:mcp.stdout}).on('line',line=>{const r=JSON.parse(line);replies.get(r.id)?.(r);replies.delete(r.id);});
const rpc=(method,params)=>new Promise(resolve=>{const n=++id;replies.set(n,resolve);mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n');});
const call=async(name,args)=>{const r=await rpc('tools/call',{name,arguments:args});if(r.result?.isError)throw new Error(r.result.content[0].text);return JSON.parse(r.result.content[0].text);};
const text=value=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:value}}));
try{
 await rpc('initialize',{});const catalog=(await rpc('tools/list',{})).result.tools;
 if(catalog.some(t=>t.name.startsWith('yonetim_'))!==(role==='director'))throw new Error("Management schemas were given to the wrong role.");
 if(role==='director'){
  const statePath=cfg.env.OFIS_AGENT_WORK+'/b2-plan.json';let state=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):{stage:0};
  const persist=()=>writeFileSync(statePath,JSON.stringify(state),{mode:0o600});
  if(state.stage===0){
   const team=await call('yonetim_islem',{islemler:[{islem:'bolum_olustur',veri:{name:'Deneme ekibi',color:'#336699'}},...['Deniz B2','Ece B2'].map(name=>({islem:'ajan_olustur',veri:{name,title:'Çalışan',department_id:'$1.id',runner:'codex',model:'gpt-6.1-sol',effort:'medium',appearance:{skin:'#d6a27c',hair:'#343038',shirt:'#27334b',style:'kisa'}}}))]});
   if(!team.tamamlandi)throw new Error("Could not create the team in a batch.");state.first=team.sonuclar[1].sonuc.id;state.second=team.sonuclar[2].sonuc.id;
   writeFileSync(cfg.env.OFIS_AGENT_WORK+'/kapsam.txt','Dar kapsam: doğrulanmış bir sonuç ve kısa iş notu.');
   for(const agent of [state.first,state.second])await call('gorev_devret',{kaynaklar:{klasorler:[],komutlar:[],belgeler:[]},kabul:'Kapsam doğrulandı, kısa sonuç ve iş notu yazıldı.',kime:agent,baslik:'B2 ilk adım',aciklama:'Kapsam dosyasını oku; kısa sonuç ver.',dosyalar:['kapsam.txt'],is:'ilk:'+agent,secenekler:{model:'gpt-6.1-sol',effort:'low',prepared:'Kabul: gelen kapsam dosyası ve kısa sonuç.'}});
   state.stage=1;persist();await call('yonetim_defteri',{metin:'Açık işler: Deniz ve Ece ilk adımı yapıyor. Sıradaki: iki sonucu kontrol et.'});text('Bölüm ve iki ajan oluşturuldu; ilk adım verildi.');
  }else if(state.stage===1){
   const office=await call('yonetim_durum',{alan:'ofis',ayrinti:true});
   if(office.kuyruk.some(r=>[state.first,state.second].includes(r.agent_id))){await call('yonetim_defteri',{metin:'İlk adımın kalan sonucu bekleniyor.'});text('Sonuçların tamamlanması bekleniyor.');}
   else{await call('gorev_devret',{kaynaklar:{klasorler:[],komutlar:[],belgeler:[]},kabul:'Kapsam doğrulandı, kısa sonuç ve iş notu yazıldı.',kime:state.second,baslik:'B2 ikinci adım',aciklama:'İki sonucu birleştir ve kısa rapor ver.',is:'ikinci',secenekler:{effort:'medium',prepared:'İlk adım iki ajanda tamamlandı; birleştirilecek kısa sonuçlar hazır.'}});state.stage=2;persist();await call('yonetim_defteri',{metin:'İlk iki sonuç kontrol edildi. Ece ikinci adımı birleştiriyor.'});text('Sonuçlar kontrol edildi; ikinci adım verildi.');}
  }else if(state.stage===2){
   state.stage=3;persist();await call('yonetim_defteri',{metin:'İki aşama tamamlandı. Bekleyen soru: harcama kararını sahip vermeli.'});await call('mesaj_gonder',{kime:'sahip',metin:'İki aşama tamamlandı; kayıtlı sonuçlar kontrol edildi. Harcama için kararınızı bekliyorum.'});text('İki aşama tamamlandı; harcama kararını size bıraktım.');await call('onay_iste',{baslik:'B2 harcama kararı',ayrinti:'Bu yalnız sahte koşu önerisidir; gerçek ödeme yapılmaz.',tur:'spending'});
  }else{await call('yonetim_defteri',{metin:'Sahibin harcama kararı kaydedildi; açık iş yok.'});text('Sahibin kararı kaydedildi.');}
 }else{
  const box=await call('gelen_kutusu',{}),handoff=box.gorevler[0];if(!handoff)throw new Error("Handed-off work not found.");
  if(handoff.title==='B2 ilk adım'){const file=box.dosyalar.find(p=>p.endsWith('/kapsam.txt'));if(!file || !readFileSync(cfg.env.OFIS_AGENT_WORK+'/'+file,'utf8').includes('Dar kapsam'))throw new Error("Prepared file input did not arrive.");}
  await call('gorev_durumu',{gorev:handoff.id,durum:'bitti',not:'Dar kapsam doğrulandı.'});await call('is_notu_yaz',{metin:'Yapılan: dar kapsam doğrulandı. Kalan: yok.'});text('Doğrulanmış sonuç hazır.');
 }
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:20,output_tokens:10}}));
}finally{mcp.kill('SIGKILL');}
