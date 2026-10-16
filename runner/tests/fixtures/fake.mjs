import { readFileSync, writeFileSync,existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn,spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
const [profile,summary,runner,retry]=process.argv.slice(2);
if(runner==='codex' || runner==='claude') {
 process.stdin.setEncoding('utf8');let input='';for await(const chunk of process.stdin)input+=chunk;
 if(input!==readFileSync(profile+'/scheduled-prompt.txt','utf8'))throw new Error("Task input did not arrive intact through stdin.");
}
const sessionPath=profile+'/fake-session.json';
const session=existsSync(sessionPath) ? JSON.parse(readFileSync(sessionPath,'utf8')) : {id:randomUUID()};
if(process.env.FAKE_RESUME && session.id!==process.env.FAKE_RESUME)throw new Error("The fake provider started with the wrong session.");
writeFileSync(sessionPath,JSON.stringify(session),{mode:0o600});
console.log(JSON.stringify(runner==='codex' ? {type:'thread.started',thread_id:session.id} : {type:'system',subtype:'init',session_id:session.id}));
if(summary==='utf8-parca'){
 const record=Buffer.from(JSON.stringify({type:'result',result:'Şirketin işi: ığüşöç İĞÜŞÖÇ.',is_error:false,usage:{input_tokens:10,output_tokens:5}})+'\n');
 for(const byte of record){process.stdout.write(Buffer.from([byte]));await new Promise(r=>setTimeout(r,2));}
 process.exit(0);
}
if(summary==='kota'){process.stderr.write('usage limit reached retry after 60 seconds');process.exit(1);}
if(summary==='kota-son-satir'){process.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'usage limit reached retry after 60 seconds'}}));process.exit(1);}
if(summary.includes('\"scenario\":\"sure\"')||summary==='uyku'||summary.includes('\"scenario\":\"uzun\"')){setInterval(()=>{},1000);await new Promise(()=>{});}
if(summary.startsWith('cokus-')) {
 const final={type:'item.completed',item:{type:'agent_message',text:'Son cevap.'}};
 const turn={type:'turn.completed',usage:{input_tokens:12,output_tokens:3}};
 if(['cokus-sonra','cokus-satirsonusuz','cokus-hata-sonra','cokus-bekle'].includes(summary))process.stdout.write(JSON.stringify(final)+(summary==='cokus-satirsonusuz'?'':'\n'));
 if(summary==='cokus-tur'||(summary==='cokus-once'&&retry==='1')) console.log(JSON.stringify(turn));
 if(summary==='cokus-hata-sonra') console.log(JSON.stringify({type:'turn.failed',error:{message:'MCP server failed'}}));
 if(summary==='cokus-bekle'){setInterval(()=>{},1000);await new Promise(()=>{});}
 process.stderr.write('notify inotify.rs SendError: panic in a destructor during cleanup\n');
 process.exit(summary==='cokus-once'&&retry==='1'?0:134);
}
if(summary==='gecici-mcp') { process.stderr.write('MCP failed to start: Resource temporarily unavailable (os error 11)\n'); process.exit(1); }
if(summary==='token-akis') { console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Bütçe öncesi son cevap.'}})); console.log(JSON.stringify({type:'usage',usage:{input_tokens:100001,output_tokens:4}})); setInterval(()=>{},1000); await new Promise(()=>{}); }
if(summary==='hata'){
 const key=JSON.parse(readFileSync(profile+'/codex/auth.json','utf8')).OPENAI_API_KEY;
 process.stderr.write('unknown config key\n'+key+' sk-abcdefghijklmnopqrstuv password="sahte-parola"\n');
 process.exit(1);
}
const config=JSON.parse(readFileSync(profile+'/mcp.json','utf8')).mcpServers.ofis;
const mcp=spawn(config.command,config.args,{env:{...config.env,BRIDGE_DIR:process.env.BRIDGE_DIR,NODE_OPTIONS:process.env.NODE_OPTIONS},stdio:['pipe','pipe','ignore']});
let id=0;const responses=new Map();
createInterface({input:mcp.stdout}).on('line',line=>{const r=JSON.parse(line);responses.get(r.id)?.(r);responses.delete(r.id);});
const rpc=(method,params)=>new Promise(resolve=>{const n=++id;responses.set(n,resolve);mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n');});
const call=async(name,args)=>{const r=await rpc('tools/call',{name,arguments:args});if(r.result?.isError)throw new Error("Fake tool call rejected.");return JSON.parse(r.result.content[0].text);};
try {
 await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'sahte',version:'1'}});await rpc('tools/list',{});
 let message='İş tamamlandı.';
 const matched=summary.match(/^DUMAN (\{.*\})$/m);
 const plan=matched?JSON.parse(matched[1]):null;
 let decision;try{decision=JSON.parse(summary);}catch{}
 if(plan){
  if(plan.scenario==='zamanlanmis'){
   if(plan.expect && !readFileSync(profile+'/scheduled-prompt.txt','utf8').includes(plan.expect))throw new Error("The previous final status is missing from the input.");
   await call('is_notu_yaz',{metin:plan.note});message=plan.reply;
  }else if(plan.scenario==='temel'){
   await call('hafiza_yaz',{metin:plan.memory});
   await call('tududi_gorev_ekle',{name:plan.tag});
   await call('tududi_not_yaz',{baslik:plan.tag,icerik:'Deneme'});
   if(runner==='codex'){
    writeFileSync(config.env.OFIS_AGENT_WORK+'/merhaba.txt',plan.content);
    await call('teslim_et',{baslik:'Merhaba',ozet:'Selam',dosyalar:['merhaba.txt']});
   }
  }else if(plan.scenario==='oturum-ilk' || plan.scenario==='karsilastirma-ilk'){
   session.remember=plan.memory;writeFileSync(sessionPath,JSON.stringify(session));
   await call('is_notu_yaz',{metin:'Doğrulanmış deneme bilgisi: '+plan.memory});
   await call('tududi_not_yaz',{baslik:'Kararlar',icerik:'2026-10-11: doğrulanan deneme bilgisi '+plan.memory});
  }else if(plan.scenario==='oturum-sonraki'||plan.scenario==='karsilastirma-sonraki'){message=session.remember || (await call('tududi_not_oku',{baslik:'Kararlar'})).content;
   await call('is_notu_yaz',{metin:'Doğrulanmış kısa durum: '+message});
  }else if(plan.scenario==='sahip-girdi'){message=plan.memory;
  }else if(plan.scenario==='yenileme-sonraki'){message='Yenilemeden sonra kısa özetle devam';
  }else if(plan.scenario==='hatirla'){message=(await call('hafiza_oku',{})).metin;
  }else if(plan.scenario==='devir'){
   await call('gorev_devret',{kime:plan.to,baslik:plan.tag,aciklama:'DUMAN '+JSON.stringify({scenario:'devredilen',from:config.env.OFIS_AGENT_WORK.split('/').at(-1)})});
  }else if(plan.scenario==='dosyali-devir'){
   writeFileSync(config.env.OFIS_AGENT_WORK+'/inceleme.txt',plan.content);
   await call('gorev_devret',{kime:plan.to,baslik:plan.tag+' dosyalı',aciklama:'DUMAN '+JSON.stringify({scenario:'dosya-alindi',expected:plan.content}),dosyalar:['inceleme.txt']});
   writeFileSync(config.env.OFIS_AGENT_WORK+'/inceleme.txt','Sonradan değişti');
  }else if(plan.scenario==='onay'){
   writeFileSync(config.env.OFIS_AGENT_WORK+'/ek.txt','Deneme\r\n');
   await call('onay_iste',{baslik:plan.tag,ayrinti:'Devam planı',tur:'genel',dosyalar:['ek.txt']});
  }else if(plan.scenario==='klasor'){
   writeFileSync(config.env.OFIS_AGENT_WORK+'/sonuc.txt',readFileSync(plan.read+'/kaynak.txt'));
   await call('onay_iste',{baslik:'Klasör yazımı',ayrinti:'Kopyala',tur:'dosya',baglanti:plan.link,dosyalar:['sonuc.txt']});
  }else if(plan.scenario==='zincir'){
   await call('gorev_devret',{kime:plan.to,baslik:'Zincir',aciklama:'DUMAN '+JSON.stringify({scenario:'geri',to:plan.back})});
  }else if(plan.scenario==='devredilen'||plan.scenario==='geri'){
   if(plan.scenario==='geri')await call('gorev_devret',{kime:plan.to,baslik:'Geri',aciklama:'Tekrar'});
   const box=await call('gelen_kutusu',{});
   const h=box.gorevler[0];
   await call('gorev_durumu',{gorev:h.id,durum:'bitti',not:'Tamamlandı'});
   await call('is_notu_yaz',{metin:'İş tamamlandı; sonuç doğrulandı.'});
   await call('mesaj_gonder',{kime:h.from_agent_id,metin:'İş tamamlandı.',cevap_bekleniyor:false});
  }
 }else if(decision?.description?.includes('DUMAN ')){
  const p=JSON.parse(decision.description.split('DUMAN ')[1]);
  if(p.scenario==='dosya-alindi'){
   const box=await call('gelen_kutusu',{}); const path=box.dosyalar.find((p)=>p.endsWith('/inceleme.txt'));
   if(!path)throw new Error('Gelen dosya yok.');
   const content=readFileSync(config.env.OFIS_AGENT_WORK+'/'+path,'utf8');
   if(content!==p.expected)throw new Error("The frozen file changed.");
   writeFileSync(config.env.OFIS_AGENT_WORK+'/okunan.txt',content);
   await call('teslim_et',{baslik:'Okunan devir',ozet:'Gelen dosyadan okundu',dosyalar:['okunan.txt']});
  }
  if(p.scenario==='geri')await call('gorev_devret',{kime:p.to,baslik:'Geri',aciklama:'Tekrar'});
  await call('gorev_durumu',{gorev:decision.id,durum:'bitti',not:'Tamamlandı'});
  await call('is_notu_yaz',{metin:'İş tamamlandı; sonuç doğrulandı.'});
  await call('mesaj_gonder',{kime:decision.from_agent_id,metin:'İş tamamlandı.',cevap_bekleniyor:false});
 }else if(decision?.not?.includes('hafiza_yaz ile ONAY')){
  await call('hafiza_yaz',{metin:'ONAY'});
  await call('onay_iste',{baslik:decision.başlık+' Ret',ayrinti:'Reddedin',tur:'genel'});
 }else if(decision?.not?.includes('hafiza_yaz ile RET'))await call('hafiza_yaz',{metin:'RET'});
 else if(summary.includes('Konuşmayı yenilemeden önce')) {await call('hafiza_yaz',{metin:'Doğrulanmış oturum özeti'});await call('is_notu_yaz',{metin:'Doğrulanmış iş özeti; sıradaki adım yeni oturum.'});}
 else if(summary.includes('İş oturumu kapanacak'))await call('is_notu_yaz',{metin:'Doğrulanmış son durum; oturum kapanıyor.'});
 else if(summary.startsWith('devret:'))await call('gorev_devret',{kime:summary.slice(7),baslik:'Kaynakları incele',aciklama:'Sonucu bildir.'});
 else if(summary==='onay')await call('onay_iste',{baslik:'Paylaşım',ayrinti:'Sonucu paylaşmak için izin istiyorum.',tur:'dışarı'});
 else {await call('hafiza_yaz',{metin:'deneme'});await call('tududi_not_yaz',{baslik:'Deneme notu',icerik:'İlk sonuç'});if(runner==='codex' || process.env.FAKE_CLAUDE_FILES==='1'){
  if(runner==='claude'){
   const policy=JSON.parse(readFileSync(profile+'/claude-policy/managed-settings.json','utf8'));
   const guarded=spawnSync('/bin/sh',['-c',policy.hooks.PreToolUse[0].hooks[0].command],{env:process.env,input:JSON.stringify({tool_name:'Write',tool_input:{file_path:config.env.OFIS_AGENT_WORK+'/merhaba.txt'},permission_mode:'dontAsk'}),encoding:'utf8',timeout:3000});
   if(guarded.status!==0)throw new Error("Fake Claude file access denied.");
  }
  writeFileSync(config.env.OFIS_AGENT_WORK+'/merhaba.txt','Merhaba\n');await call('teslim_et',{baslik:'İlk dosya',ozet:'Kısa selamlama',dosyalar:['merhaba.txt']});
 }}

 const tokens=plan && /oturum-|karsilastirma-/.test(plan.scenario) ? Number(process.env.FAKE_PROMPT_TOKENS) : 10;
 if(runner==='codex'){console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:message}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:tokens,output_tokens:5}}));}
 else console.log(JSON.stringify({type:'result',result:message,is_error:false,usage:{input_tokens:tokens,output_tokens:5}}));
}finally{mcp.kill('SIGKILL');}
