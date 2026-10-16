import {readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {parseEnv} from 'node:util';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const repo=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const ensure=(ok,message)=>{if(!ok)throw new Error(message);};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
// Only Claude/operator runs this script against the separate, already-running
// test office. It never starts a service/container and cannot target live 9400.
export async function runDirectorSmoke({api,timeoutMs=300000,report=console.log,pause:wait=pause}){
 const initial=await api('/snapshot'),gm=initial.agents.find(a=>a.builtin==='director');ensure(gm,"Built-in Director not found.");ensure(!initial.runtime.runs.some(r=>['running','queued'].includes(r.state) || (r.state==='waiting' && initial.runtime.approvals.some(a=>a.run_id===r.id && a.state==='pending'))),"The test office must be idle.");ensure(!initial.runtime.director.auto,"Disable automatic mode in the test office first.");
 ensure(initial.runtime.settings.emailDomain==='deneme.piksel-ofis.local',"The test Office Tududi email domain must be deneme.piksel-ofis.local.");
 const settings=initial.runtime.settings,tag='GM Deneme '+randomUUID().slice(0,8),names=[tag+' Deniz',tag+' Ece'];
 const gmFields=Object.fromEntries(['name','username','title','department_id','prompt','runner','model','effort','appearance','policy','session_mode','watch_tasks','watch_due','tool_groups','active','desk_x','desk_y','status','current_job'].filter(k=>gm[k]!==undefined).map(k=>[k,gm[k]]));
 const initialRuns=new Set(initial.runtime.runs.map(r=>r.id)),scenarioByRun=new Map();const rows=[],known=new Set(initial.agents.map(a=>a.id)),knownDepartments=new Set(initial.departments.map(d=>d.id));
 const result={tag,rows,calismalar:[],asama:"Preparation",sonuc:"FAIL"};let lastSnapshot=initial;
 const until=async(predicate,message)=>{const end=Date.now()+timeoutMs;while(Date.now()<end){const s=await api('/snapshot');lastSnapshot=s;const newRuns=s.runtime.runs.filter(r=>!initialRuns.has(r.id));const crew=s.agents.filter(a=>names.includes(a.name));const completed=newRuns.filter(r=>crew.some(a=>a.id===r.agent_id) && r.state==='completed');result.asama=crew.length<2?"Create department and two agents":completed.length<2?"Wait for both initial results":completed.length<3?"Merge task and result":"Owner-only spending approval";if(!s.runtime.director.auto && !s.runtime.approvals.some(a=>a.title===tag+' harcama kararı' && a.state==='pending'))throw new Error("Automatic mode stopped. Stage: "+result.asama+". Status: "+s.runtime.director.status);const value=predicate(s);if(value)return value;await wait(1000);}throw new Error(message+" Stage: "+result.asama+". Recent runs: "+lastSnapshot.runtime.runs.filter(r=>!initialRuns.has(r.id)).map(r=>r.trigger+': '+r.state+(r.reason?' ('+r.reason+')':'')).join('; '));};
 const oneTurn=async(scenario,text)=>{
  result.asama=scenario;const before=await api('/snapshot'),ids=new Set(before.runtime.runs.map(r=>r.id));await api('/director/input','POST',{text});
  const end=Date.now()+timeoutMs;
  while(Date.now()<end){const snapshot=await api('/snapshot');lastSnapshot=snapshot;const turns=snapshot.runtime.runs.filter(r=>r.agent_id===gm.id && !ids.has(r.id));for(const r of turns)scenarioByRun.set(r.id,scenario);
   const done=turns.find(r=>['completed','failed','budget_exceeded','stopped','interrupted'].includes(r.state));
   if(done){ensure(turns.length===1,scenario+" opened an extra turn automatically.");ensure(done.state==='completed',scenario+" did not complete: "+done.reason);rows.push({senaryo:scenario,sonuc:"PASS"});return {snapshot,run:done,before};}await wait(500);
  }throw new Error(scenario+" did not complete before the timeout.");
 };
 const captureUsage=async()=>{
  try{
   result.calismalar=[];const snapshot=await api('/snapshot');const newRuns=snapshot.runtime.runs.filter(r=>!initialRuns.has(r.id));const scenarios=new Map();
   for(const run of newRuns){const detail=await api(`/runs/${run.id}`),u=run.usage || {};const input=(u.input_tokens || 0)+(u.cache_read_input_tokens || 0)+(u.cache_creation_input_tokens || 0),cached=Math.min(input,(u.cached_input_tokens || 0)+(u.cache_read_input_tokens || 0)),output=u.output_tokens || 0;
    const row={id:run.id,senaryo:run.agent_id===gm.id ? run.director_followup?"Owned-work follow-up (automatic mode off)":scenarioByRun.get(run.id) || (run.director_auto?"Automatic follow-up and owner decision":"Create team and assign initial work"):"Agent work",durum:run.state,neden:run.reason,kullanim_biliniyor:['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'].some(k=>Object.hasOwn(u,k)),arac:detail.logs.filter(l=>l.kind==='tool').length,toplam:input+output,onbellekten:cached,agirlikli:input-cached+output+cached*0.1,son_istek_baglami:u.context_input_tokens ?? null,sure_ms:run.duration_ms ?? null};result.calismalar.push(row);
    const group=scenarios.get(row.senaryo) || {senaryo:row.senaryo,calisma:0,arac:0,toplam:0,onbellekten:0,agirlikli:0,bilinmeyen:0};group.calisma++;if(!row.kullanim_biliniyor)group.bilinmeyen++;for(const key of ['arac','toplam','onbellekten','agirlikli'])group[key]+=row[key];scenarios.set(row.senaryo,group);
   }
   result.kullanim=[{senaryo:"Local terminal commands",calisma:0,arac:0,toplam:0,onbellekten:0,agirlikli:0,bilinmeyen:0},...scenarios.values()];
   report(["Scenario | Runs | Tools | Total | Cached | Weighted | Unknown usage",...result.kullanim.map(r=>[r.senaryo,r.calisma,r.arac,r.toplam,r.onbellekten,Math.round(r.agirlikli),r.bilinmeyen].join(' | '))].join('\n'));
   report(["Turn | Scenario | State | Tools | Total | Cached | Weighted | Last request context",...result.calismalar.map(r=>[r.id,r.senaryo,r.durum,r.arac,r.toplam,r.onbellekten,Math.round(r.agirlikli),r.son_istek_baglami ?? "Unknown"].join(' | '))].join('\n'));
   if(result.hata)report("Remaining step: "+result.hata);
  }catch(error){result.rapor_hatasi=String(error?.message || error);report("Could not collect usage table: "+result.rapor_hatasi);}
 };
 try{
  await api('/runtime/settings','PUT',{...settings,cachedInputWeight:0.1,director:{...settings.director,batchSeconds:2,dailyTokenBudget:150000,hourlyRuns:12}});
  result.asama="Local terminal commands";const before=await api('/snapshot');for(const text of ['/durum','/ajanlar','/kuyruk','/kullanim','/onaylar','/yardim'])await api('/director/input','POST',{text});const after=await api('/snapshot');ensure(after.runtime.runs.length===before.runtime.runs.length,"Local commands created a run.");rows.push({senaryo:"Local terminal commands",sonuc:"PASS"});
  await api('/director/input','POST',{text:'/yenile'});
  const hello=await oneTurn("Simple chat (greeting)",'merhaba');const helloDetail=await api(`/runs/${hello.run.id}`);ensure(!helloDetail.logs.some(l=>l.kind==='tool' && l.text?.startsWith('yonetim_defteri:')),"The greeting turn unnecessarily updated the ledger.");
  result.ilk_sohbet={son_istek_baglami:hello.run.usage?.context_input_tokens ?? null,hedef:20000,olcum:"Real provider metadata; unknown if absent"};
  await oneTurn("Status question",'Ne durumdayız, hangi modeli kullanıyorsun?');
  const product=await oneTurn("Product request",`Deneme ürün isteği: Piksel Ofis'e rapor ekranı geliştirmek istiyorum. Kaynak klasörü, doğrulama komutu ve iş belgesi henüz atanmadı. İş açmadan önce eksikleri tek soruyla iste; bu denemede ajan, görev veya özellik oluşturma.`);
  const oldProductRuns=new Set(product.before.runtime.runs.map(r=>r.id));ensure(!product.snapshot.runtime.runs.some(r=>r.agent_id!==gm.id && !oldProductRuns.has(r.id)),"Product work was assigned before resources were ready.");ensure(product.snapshot.agents.length===product.before.agents.length,"The product request created an unnecessary agent.");
  result.asama="Owned-work follow-up (automatic mode off)";const beforeLight=await api('/snapshot'),lightIds=new Set(beforeLight.runtime.runs.map(r=>r.id)),lightName=tag+' Takip';
  await api('/director/input','POST',{text:`Otomatik mod kapalı kalsın. ${lightName} adlı tek deneme ajanını Yönetim bölümünde oluştur; mevcut model ve hafif efor kullan. Ona tek satırlık selamlama hazırlama işi ver. ajan_calistir için kaynaklar:{klasorler:[],komutlar:[],belgeler:[]} ve kabul:'Tek satır Türkçe selamlama' kullan. İşin sonucu gelince hafif takip turunda sahibine kısa rapor ver. Yeni iş, devir veya onay başlatma.`});
  const lightEnd=Date.now()+timeoutMs;let lightDone=false;
  while(Date.now()<lightEnd){const snapshot=await api('/snapshot');lastSnapshot=snapshot;ensure(!snapshot.runtime.director.auto,"Light follow-up enabled automatic mode.");const turns=snapshot.runtime.runs.filter(r=>r.agent_id===gm.id && !lightIds.has(r.id));for(const r of turns)scenarioByRun.set(r.id,"Owned-work follow-up (automatic mode off)");const follow=turns.filter(r=>r.director_followup);ensure(follow.length<=1,"One task created multiple light follow-ups.");
   const failed=turns.find(r=>['failed','budget_exceeded','stopped','interrupted'].includes(r.state));ensure(!failed,"Hafif takip did not complete: "+(failed?.reason || ''));
   if(follow.length===1 && follow[0].state==='completed'){lightDone=true;break;}await wait(500);
  }ensure(lightDone,"Owned-work light follow-up did not complete with automatic mode disabled.");rows.push({senaryo:"Owned-work follow-up (automatic mode off)",sonuc:"PASS"});
  result.asama="Create team, two steps, automatic follow-up and owner approval";await api('/director/auto','POST',{enabled:true});
  await api('/director/input','POST',{text:`Bu yalnız deneme ofisindeki dar bir kontrol işidir. ${tag} adlı bölüm oluştur. ${names[0]} ve ${names[1]} adlarında iki ajan oluştur; çalıştırıcının bildirdiği mevcut modelle, hafif eforla çalışsınlar. Bölümü, iki ajanı ve ilk işlerini yonetim_islem islemler listesinde tek çağrıda topla; önceki sonuç kimliklerine $1.id gibi başvur. Durumu yalnız gerektiğinde sor. Her birine tek satırlık doğrulanmış selamlama hazırlama işi ver; veri.kaynaklar:{klasorler:[],komutlar:[],belgeler:[]} ve veri.kabul:'Tek satır Türkçe selamlama' belirt. İki işin bitişini otomatik takip et. İkisi bitince yalnız ikinci ajana aynı boş kaynak listeleri ve kabul:'İki selamlamanın kısa birleşimi' ile birleştirme işi ver. Sonuç gelince sahibe kısa rapor ver, durum defterini güncelle. Son olarak spending türünde '${tag} harcama kararı' başlıklı sahibe ayrılmış onay iste ve bekle. Gerçek ödeme, dış işlem, yeni klasör, yayın veya sunucu komutu yapma. Bu koşuda yalnız belirtilen bölüm ve iki ajanı oluştur.`});
  const end=await until(s=>s.runtime.approvals.find(a=>a.title===tag+' harcama kararı' && a.type==='spending' && a.state==='pending') && s,"The Director did not reach two-step completion and owner approval.");
  const crew=end.agents.filter(a=>names.includes(a.name));ensure(crew.length===2,"The expected two test agents were not created.");const completed=end.runtime.runs.filter(r=>crew.some(a=>a.id===r.agent_id) && r.state==='completed' && !initialRuns.has(r.id));ensure(completed.length>=3 && crew.every(a=>completed.some(r=>r.agent_id===a.id)) && completed.filter(r=>r.agent_id===crew.find(a=>a.name===names[1]).id).length>=2,"The two initial jobs and second step did not complete.");ensure(end.runtime.runs.some(r=>r.agent_id===gm.id && r.director_auto),"No automatic Director run was recorded.");ensure((await api('/director')).director.ledger,"The status ledger is empty.");rows.push({senaryo:"Create team, two steps and automatic follow-up",sonuc:"PASS"});rows.push({senaryo:"Owner-only spending approvalnda bekleme",sonuc:"PASS"});
  result.sonuc="PASS";result.asama="Waiting for owner approval verified";report("Director smoke passed: local commands, team, two steps, automatic follow-up and owner approval.");return result;
 }catch(error){result.hata=String(error?.message || error);rows.push({senaryo:result.asama,sonuc:"FAIL",neden:result.hata});throw Object.assign(error,{report:result});}finally{
  try{
  await api('/director/auto','POST',{enabled:false}).catch(()=>{});let s=await api('/snapshot');const crew=s.agents.filter(a=>!known.has(a.id));
  for(const a of [gm,...crew])await api(`/agents/${a.id}/stop`,'POST',{}).catch(()=>{});
  s=await api('/snapshot');for(const a of s.runtime.approvals.filter(a=>a.state==='pending' && (a.agent_id===gm.id || crew.some(c=>c.id===a.agent_id))))await api(`/approvals/${a.id}/decision`,'POST',{approved:false,note:'Deneme tamamlandı; gerçek işlem yapılmayacak.'}).catch(()=>{});
  for(const a of [gm,...crew])await api(`/agents/${a.id}/stop`,'POST',{}).catch(()=>{});
  const processEnd=Date.now()+30000;
  while(true){const snapshot=await api('/snapshot');const runs=snapshot.runtime.runs.filter(r=>!initialRuns.has(r.id) && [gm.id,...crew.map(a=>a.id)].includes(r.agent_id) && r.started_at);let active=false;
    for(const r of runs){const detail=await api(`/runs/${r.id}`);if(detail.logs.some(l=>l.kind==='diagnostic' && l.text.includes('"olay":"process_start"')) && !detail.logs.some(l=>l.kind==='diagnostic' && l.text.includes('"olay":"process_exit"')))active=true;}
    if(!active)break;ensure(Date.now()<processEnd,"Test child-process exit could not be verified; an operator must check before deleting agents.");await wait(500);
  }
  await captureUsage();
  for(const a of crew)await api(`/agents/${a.id}?account=delete&profile=delete`,'DELETE');
  s=await api('/snapshot');for(const d of s.departments.filter(d=>!knownDepartments.has(d.id)))await api(`/departments/${d.id}`,'DELETE');
  await api(`/agents/${gm.id}`,'PUT',gmFields);await api('/runtime/settings','PUT',settings);await api('/director/ledger','PUT',{metin:initial.runtime.director.ledger || ''});
  const clean=await api('/snapshot');ensure(!clean.agents.some(a=>!known.has(a.id)),"A test agent remains.");ensure(!clean.runtime.pendingDeletions?.length,"Tududi test-account deletion is pending; clean up accounts separately.");
  result.temizlik="PASS";report("Temporary agents, Tududi accounts and department removed; Director and Office settings restored.");
  }catch(error){if(!result.kullanim)await captureUsage();result.temizlik="FAIL";result.sonuc="FAIL";result.temizlik_hatasi=String(error?.message || error);throw Object.assign(error,{report:result});}
 }
}
async function main(){
 ensure(process.argv.slice(2).length===0,"Usage: npm run smoke:director");
 const envPath=join(repo,'office/.env.test');ensure(existsSync(envPath),"Test Office settings not found.");const env=parseEnv(readFileSync(envPath,'utf8'));ensure(env.TUDUDI_BASE_URL==='http://127.0.0.1:9393',"Only the agent Tududi instance on 9393 is allowed.");ensure(env.OFIS_OWNER_PASSWORD,"The test Office owner password is not configured.");ensure(env.TUDUDI_EMAIL_DOMAIN==='deneme.piksel-ofis.local',"Test settings must use TUDUDI_EMAIL_DOMAIN=deneme.piksel-ofis.local.");
 const secrets=Object.entries(env).filter(([k])=>/key|password|secret|token/i.test(k)).map(([,v])=>v);let cookie='';
 const safe=value=>{let text=String(value);for(const secret of secrets.filter(Boolean))text=text.split(secret).join('[gizlendi]');return text.replace(/(?:sk-[\w-]{16,}|Bearer\s+[\w.-]+)/g,'[gizlendi]');};
 const api=async(path,method='GET',body)=>{ensure(path.startsWith('/') && !path.startsWith('//'),"Invalid Office path.");const r=await fetch('http://127.0.0.1:9401/api'+path,{method,redirect:'error',signal:AbortSignal.timeout(20000),headers:{'X-Ofis-Islem':'1',...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});if(path==='/login'){cookie=(r.headers.get('set-cookie') || '').split(';')[0];secrets.push(cookie.split('=').slice(1).join('='));}const value=await r.json();if(!r.ok)throw new Error(safe(value.error || "Test request failed."));return value;};
 await api('/login','POST',{password:env.OFIS_OWNER_PASSWORD});let result;try{result=await runDirectorSmoke({api,report:text=>console.log(safe(text))});}catch(error){result=error.report;throw error;}finally{if(result){const dir=join(repo,'runner/.smoke');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'gm-sonuc.json'),safe(JSON.stringify(result,null,2))+'\n',{mode:0o600});}await api('/logout','POST',{}).catch(()=>{});}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error("Director smoke failed: "+String(e?.message || '').replace(/[A-Za-z0-9_-]{24,}/g,'***').slice(0,300));process.exitCode=1;});
