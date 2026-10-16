import {mkdirSync,writeFileSync,readFileSync,copyFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import type {Page} from 'playwright';
import {createApp} from '../server/app.js';
import {testConfig,fakeTududi,cleanup,input} from './helpers.js';
import {demoSnapshot} from '../src/demo.js';
import {auditPage,auditFocus,auditAnnotations} from './visual.audit.js';
import type {Snapshot} from '../shared/types.js';
import {defaultSettings} from '../shared/runtime.js';
const visual=process.argv.includes('--visual'),updating=process.argv.includes('--update-baselines');
const cache=resolve('.cache/runtime');mkdirSync(cache,{recursive:true});process.env.TMPDIR=cache;process.env.PLAYWRIGHT_BROWSERS_PATH=resolve('.cache/browsers');
const {chromium}=await import('playwright');
let scheduleAt=Date.parse('2026-10-12T06:00:00Z');
const config=testConfig(),fake=fakeTududi(),c=await createApp(config,{fetcher:fake.fetcher,background:false,scheduleClock:()=>scheduleAt});
const dept=randomUUID();c.store.db.prepare('INSERT INTO departments(id,name,description,color,sort_order) VALUES (?,?,?,?,?)').run(dept,'Genel ekip','','#498f87',0);const agent=await c.office.createAgent({...input(dept),name:'Deniz'});
const browser=await chromium.launch({headless:true,ignoreDefaultArgs:['--hide-scrollbars'],args:['--no-sandbox'],downloadsPath:cache,env:{...process.env,LD_LIBRARY_PATH:[resolve('.cache/system-libs/usr/lib/x86_64-linux-gnu'),process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')}});
const failures:string[]=[],files:string[]=[],measurements:unknown[]=[];
const baseline=resolve('tests/__screenshots__'),current=resolve('.test-data/visual-b1/current');mkdirSync(current,{recursive:true});
let page!:Page;
async function checkBubbles(p:Page,data:Snapshot){
 const result=await p.evaluate((agents)=>{
  const problems:string[]=[],boxes:{id:string;left:number;right:number;top:number;bottom:number;text:string;font:number}[]=[];
  const intersects=(a:{left:number;right:number;top:number;bottom:number},b:{left:number;right:number;top:number;bottom:number})=>a.left<b.right-1 && a.right>b.left+1 && a.top<b.bottom-1 && a.bottom>b.top+1;
  const viewport=document.querySelector('.office-viewport')!.getBoundingClientRect(),scale=Number((document.querySelector('.office-viewport') as HTMLElement).dataset.scale);
  for(const agent of agents.filter(a=>a.status==='calisiyor')){
   const el=document.querySelector<HTMLElement>(`[data-agent-id="${agent.id}"] .agent-bubble`)!;const b=el.getBoundingClientRect(),s=getComputedStyle(el),text=el.textContent || '',font=parseFloat(s.fontSize)*scale;
   if(s.visibility!=='visible' || s.display==='none' || b.width<=0 || b.height<=0)problems.push(agent.id+": bubble is not visible");
   if(font<11)problems.push(agent.id+": text is too small");
   if(b.left<viewport.left-1 || b.right>viewport.right+1 || b.top<viewport.top-1 || b.bottom>viewport.bottom+1)problems.push(agent.id+": bubble overflows the scene");
   const lines=text.replace(/^◷ /,'').split('\n');if(lines.length>2)problems.push(agent.id+": more than two lines");
   const words=lines.join(' ').replace(/…/g,'').split(' ').filter(Boolean),source=agent.current_job.trim().split(/\s+/);
   if(!words.length || !words.some(w=>source.includes(w)))problems.push(agent.id+": no complete word");
   for(const w of words)if(!source.includes(w))problems.push(agent.id+": split word: "+w);
   // Range boxes detect actual rendered line endings, independent of textContent.
   const node=el.firstChild;if(node?.nodeType===Node.TEXT_NODE){const ranges=new Map<number,string>();for(let i=0;i<text.length;i++){const r=document.createRange();r.setStart(node,i);r.setEnd(node,i+1);const rect=r.getBoundingClientRect();if(text[i]!=='\n'){const y=Math.round(rect.top);ranges.set(y,(ranges.get(y)||'')+text[i]);}}if(ranges.size>2)problems.push(agent.id+": browser rendered a third line");for(const line of ranges.values())for(const word of line.replace(/^◷ /,'').replace(/…/g,'').trim().split(' '))if(word && !source.includes(word))problems.push(agent.id+": rendered line ending splits a word");}
   if(!el.dataset.tail)problems.push(agent.id+': missing bubble tail');
   boxes.push({id:agent.id,left:b.left,right:b.right,top:b.top,bottom:b.bottom,text,font});
  }
  const signs=[...document.querySelectorAll('.department-plaque,.scene-sign')].map(el=>el.getBoundingClientRect());
  for(let i=0;i<boxes.length;i++)for(const other of [...signs,...boxes.slice(i+1)])if(intersects(boxes[i],other))problems.push(boxes[i].id+": intersects a sign or bubble");
  return {problems,boxes,scale,viewport:{left:viewport.left,right:viewport.right,top:viewport.top,bottom:viewport.bottom}};
 },data.agents);
 if(result.problems.length){console.log(JSON.stringify(result));await p.screenshot({path:resolve(".test-data/b15-bubble-failure.png"),scale:"css"});}
 assert.deepEqual(result.problems,[],result.problems.join('\n'));assert.equal(result.boxes.length,data.agents.filter(a=>a.status==='calisiyor').length);measurements.push(result);
 await auditAnnotations(p,data);return result;
}
async function capture(p:Page,name:string,crop?:string){if(!visual)return;
 await p.evaluate(async()=>{
  await document.fonts.ready;
  const root=document.documentElement,previous=root.style.transform;
  const frame=()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done())));
  root.style.transform='translate(1px, 1px)';await frame();root.style.transform=previous;await frame();
 });
 const options={scale:'css',animations:'disabled',caret:'hide'} as const;
 let shot=await p.screenshot(options),stable=false;
 for(let i=0;i<5;i++){await p.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));const next=await p.screenshot(options);if(shot.equals(next)){stable=true;break;}shot=next;}
 assert.ok(stable,name+": stable screenshot");const file=name+'.png';writeFileSync(resolve(current,file),shot);files.push(file);if(updating)copyFileSync(resolve(current,file),resolve(baseline,file));
 if(crop){const file=name+'-yakin-2x.png';await p.locator(crop).first().screenshot({path:resolve(current,file),scale:'device',animations:'disabled',caret:'hide'});files.push(file);if(updating)copyFileSync(resolve(current,file),resolve(baseline,file));}
}
try{
 for(const size of [{width:1920,height:1000},{width:1366,height:768},{width:1280,height:640},{width:390,height:844}])for(const theme of ['light','dark']){
  const ctx=await browser.newContext({viewport:size,locale:'tr-TR',deviceScaleFactor:2,reducedMotion:'reduce'});
  await ctx.addInitScript({content:`window.__name = value => value; {const Native=EventSource;window.b1Streams=[];window.EventSource=class extends Native {constructor(...args){super(...args);window.b1Streams.push(this);}};} localStorage.setItem('po-tema','${theme}'); { let n=17; Math.random=()=>{n=Math.imul(n,16807)>>>0;return n/4294967296;}; const OriginalDate=Date;globalThis.Date=class extends OriginalDate {constructor(...args){super(...(args.length ? args : ['2026-10-12T06:00:00Z']));} static now(){return 1791784800000;}};const request=window.requestAnimationFrame.bind(window);performance.now=()=>10000;window.requestAnimationFrame=cb=>request(()=>cb(10000)); }`});
  let snapshot:Snapshot|undefined,serverVersion:string|undefined;
  await ctx.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!=='http://ofis.test'){failures.push('External request: '+url.origin);await route.abort();return;}
   if(url.pathname==='/api/snapshot' && snapshot){await route.fulfill({json:snapshot});return;}
   if(url.pathname==='/api/session' && serverVersion){await route.fulfill({json:{ok:true,build_id:serverVersion}});return;}
   if(url.pathname==='/api/live'){await route.fulfill({headers:{'content-type':'text/event-stream'},body:'retry: 60000\nevent: ready\ndata: {}\n\n'});return;}
   const result=await c.app.inject({method:req.method() as any,url:url.pathname+url.search,remoteAddress:`127.0.0.${Math.floor(size.width/100)+ (theme==='dark' ? 50 : 0)}`,headers:{...await req.allHeaders(),host:url.host},payload:req.postData() || undefined});
   if(result.statusCode>=400 && url.pathname!=='/api/session')failures.push(url.pathname+': '+result.statusCode);
   await route.fulfill({status:result.statusCode,headers:Object.fromEntries(Object.entries(result.headers).filter(([,v])=>v!==undefined).map(([k,v])=>[k,Array.isArray(v)?v.join('\n'):String(v)])),body:result.rawPayload});
  });
  page=await ctx.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>failures.push(e.message));
  await page.goto('http://ofis.test');await page.getByLabel('Sahip şifresi').fill(config.ownerPassword);await page.getByRole('button',{name:'Ofisi aç',exact:true}).click();await page.getByRole('navigation',{name:size.width<=900 ? 'Telefon gezinmesi' : 'Ana gezinme',exact:true}).waitFor();
  const suffix=`${size.width}x${size.height}-${theme==='light' ? 'aydinlik' : 'koyu'}`;
  if(size.width>900)for(const count of [6,14,24]){
   const seed=demoSnapshot({departments:[],agents:[],messages:[],events:[],handoffs:[],rules:''},0);
   const agents=Array.from({length:count},(_,i)=>({...seed.agents[i%6],id:`demo-b1-${i}`,name:`Çalışan ${i+1}`,department_id:seed.departments[i%3].id,status:'calisiyor' as const,current_job:['Kaynakları inceliyorum','Notları hazırlıyorum ve kaynakları karşılaştırıyorum','Bulguları karşılaştırıyorum'][i%3]}));
   snapshot={...seed,departments:seed.departments.slice(0,3),agents,messages:[],events:[],runtime:{...c.runtime.snapshot(),connected:true,settings: {...defaultSettings, language: 'tr' as const},runs:[{id:'b1-clock',agent_id:agents[0].id,scheduled_task_id:'b1-fixture',chain_id:'b1-fixture',depth:0,trigger:'Zamanlanmış görev: Deneme',summary:agents[0].current_job,conversation_type:'agent',conversation_id:agents[0].id,state:'running',created_at:'2026-10-12T06:00:00Z',started_at:'2026-10-12T06:00:00Z',finished_at:null,output:'',reason:'',calls:0,retry:0,duration_ms:0,usage:{}}]}};
   await page.reload();await page.locator('.agent-hit').last().waitFor();await page.waitForFunction(()=>document.querySelectorAll('.agent-bubble:not(:empty)').length===document.querySelectorAll('.agent-hit').length);
   await checkBubbles(page,snapshot);assert.equal(await page.locator(`[data-agent-id="${agents[0].id}"] .agent-bubble`).getAttribute("data-clock"),"true");await auditPage(page);await capture(page,`b1-balon-${count}-${suffix}`,'.office-viewport');
  }
  snapshot=undefined;await page.reload();
  const nav=async(label:string)=>{if(size.width<=900 && ['Ofis','Ajanlar'].includes(label))await page.getByRole('navigation',{name:'Telefon gezinmesi',exact:true}).getByRole('button',{name:label,exact:true}).click();else if(size.width<=900){await page.getByRole('button',{name:'Diğer',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:label,exact:true}).click();}else await page.getByRole('navigation',{name:'Ana gezinme',exact:true}).getByRole('button',{name:label,exact:true}).click();};
  await nav('Zamanlanmış görevler');await page.getByRole('button',{name:'Görev ekle',exact:true}).click();await page.getByLabel('Ajan',{exact:true}).selectOption(agent.id);await page.getByLabel('Görev adı',{exact:true}).fill('Düzenli belge kontrolü');await page.getByLabel('Her çalıştırmada verilecek talimat').fill('Belgeleri incele ve kısa, doğrulanmış bir durum notu yaz.');
  await page.getByLabel('Zamanlama',{exact:true}).selectOption('weekly');await page.getByRole('heading',{name:'Sonraki 3 çalışma zamanı'}).waitFor();await page.waitForFunction(()=>document.querySelectorAll('.schedule-preview li').length===3);await auditPage(page);await auditFocus(page.getByLabel('Görev adı',{exact:true}));await capture(page,`b1-gorev-formu-${suffix}`,'.schedule-form');
  for(const kind of ['daily','interval','monthly','once']){await page.getByLabel('Zamanlama',{exact:true}).selectOption(kind);if(kind==='once')await page.getByLabel('Çalışma tarihi').fill('2026-10-14');await page.waitForFunction(()=>document.querySelectorAll('.schedule-preview li').length>0);await auditPage(page);}
  await page.getByLabel('Zamanlama',{exact:true}).selectOption('weekly');await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/schedules') && r.request().method()==='POST'),page.getByRole('button',{name:'Kaydet',exact:true}).click()]);await page.locator('.schedule-card').last().waitFor();await auditPage(page);await capture(page,`b1-gorev-listesi-${suffix}`,'.schedule-card');
  const card=page.locator('.schedule-card').last();await card.getByRole('button',{name:'Şimdi çalıştır',exact:true}).click();await card.getByRole('button',{name:'Geçmiş',exact:true}).click();await page.getByRole('region',{name:'Görev geçmişi'}).getByText('Atlandı',{exact:true}).waitFor();await auditPage(page);
  const task=c.runtime.scheduler.tasks().at(-1)!;assert.equal(task.agent_id,agent.id);assert.equal(c.office.agent(agent.id).tududi_state,'ready');c.runtime.heartbeat('b1-browser');c.runtime.scheduler.launch(task,'2026-10-12T06:00:00Z');const lease=c.runtime.claim('b1-browser')!;assert.equal(lease.run.agent_id,agent.id);
  await c.runtime.tool(lease.run,'is_notu_yaz',{metin:'Belgeler doğrulandı; bir sonraki çalışmada yeniden karşılaştır.'});c.runtime.finish(lease.run.id,'completed','Belgeler incelendi, yeni bir değişiklik doğrulanmadı.','',{input_tokens:1000,output_tokens:40});c.runtime.scheduler.reconcile();c.runtime.disconnect('b1-browser');
  assert.match(c.runtime.scheduler.note(task.id),/Belgeler doğrulandı/);console.log(`B1 scheduled agent work and notebook write passed: ${suffix}`);
  await page.reload();await nav('Zamanlanmış görevler');await page.locator('.schedule-card').last().getByRole('button',{name:'Geçmiş',exact:true}).click();await page.getByRole('region',{name:'Görev geçmişi'}).getByText('Tamamlandı',{exact:true}).waitFor();await auditPage(page);await capture(page,`b1-gorev-gecmisi-${suffix}`,'.schedule-history');
  await page.getByRole('button',{name:'Çalışma dökümünü aç',exact:true}).click();await page.getByRole('heading',{name:'Çalışmanın dökümü',exact:true}).waitFor();await auditPage(page);await capture(page,`b1-gorev-dokumu-${suffix}`,'.schedule-history');
  await nav('Ajanlar');await page.getByRole('button',{name:'Deniz için diğer işlemler',exact:true}).click();await page.getByRole('tab',{name:'Zamanlanmış görevler',exact:true}).click();await page.locator('.agent-work .schedule-card').last().waitFor();await auditPage(page);await capture(page,`b1-ajan-gorevleri-${suffix}`,'.agent-work');await page.getByRole('button',{name:'Pencereyi kapat',exact:true}).click();await nav('Zamanlanmış görevler');
  await card.getByRole('button',{name:'Düzenle',exact:true}).click();await page.getByLabel('Görev adı',{exact:true}).fill('Güncellenen kontrol');await page.getByRole('button',{name:'Kaydet',exact:true}).click();await page.getByRole('heading',{name:'Güncellenen kontrol',exact:true}).waitFor();
  await page.locator('.schedule-card').last().getByLabel('Güncellenen kontrol etkin').uncheck();await page.locator('.schedule-card').last().getByRole('button',{name:'Düzenle',exact:true}).click();await page.getByRole('button',{name:'Görevi sil',exact:true}).click();await page.getByRole('heading',{name:'Güncellenen kontrol',exact:true}).waitFor({state:'hidden'});
  // Old open tab: keep the JS loaded, change only the server identity, reopen SSE.
  await page.getByRole('navigation',{name:size.width<=900 ? 'Telefon gezinmesi' : 'Ana gezinme',exact:true}).getByRole('button',{name:'Ofis',exact:true}).click();
  if(size.width<=900)await page.getByRole('tab',{name:'Sohbet',exact:true}).click();
  const message=page.getByRole('textbox',{name:'Mesajınız',exact:true});await message.fill('Yenilenince korunacak taslak');
  serverVersion='farkli-yayin-kimligi';await page.evaluate(()=>{for(const stream of (window as unknown as {b1Streams?:EventSource[]}).b1Streams || [])stream.dispatchEvent(new MessageEvent('ready',{data:'{}'}));});
  // Trigger the same reconnect event through captured EventSource instances.
  // App reuses a session check on browser reconnect; the test dispatches ready.
  await page.locator('.version-notice').waitFor();const overlapsControls=await page.evaluate(()=>{const notice=document.querySelector('.version-notice')!.getBoundingClientRect();return [...document.querySelectorAll('.chat-compose,.tabbar')].some(el=>{const box=el.getBoundingClientRect();return box.width>0 && box.height>0 && notice.left<box.right && notice.right>box.left && notice.top<box.bottom && notice.bottom>box.top;});});if(size.width<=900)assert.equal(overlapsControls,false);await capture(page,`b1-yeni-surum-${suffix}`,'.version-notice');await page.getByRole('button',{name:'Yenile',exact:true}).click();await page.getByRole('textbox',{name:'Mesajınız',exact:true}).waitFor();assert.equal(await page.getByRole('textbox',{name:'Mesajınız',exact:true}).inputValue(),'Yenilenince korunacak taslak');
  // Storage refusal must block renewal rather than destroy the current draft.
  await page.getByRole('textbox',{name:'Mesajınız',exact:true}).fill('Saklanamayan taslak korunmalı');
  await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='po-sohbet-taslaklari')throw new Error("Test: storage disabled");return original.call(this,key,value);};});
  await page.getByRole('button',{name:'Yenile',exact:true}).click();await page.getByText('Taslak saklanamadı. Mesajınızı gönderin veya kopyalayın; sonra yenileyin.',{exact:true}).waitFor();assert.equal(await page.getByRole('textbox',{name:'Mesajınız',exact:true}).inputValue(),'Saklanamayan taslak korunmalı');
  if(size.width===390 && theme==='dark'){
    await page.getByRole('button',{name:'Uyarıyı kapat',exact:true}).click();
    const task=c.runtime.scheduler.upsert({name:'Canlı atlama denetimi',agent_id:agent.id,instruction:'Deneme kontrolü.',timing:{kind:'once',date:'2026-10-12',time:'09:01'}});
    await nav('Zamanlanmış görevler');const liveCard=page.locator('.schedule-card').filter({hasText:'Canlı atlama denetimi'});await liveCard.getByText('Henüz çalışmadı',{exact:true}).waitFor();
    const before=JSON.stringify(c.runtime.runs());scheduleAt+=120000;c.runtime.heartbeat('b1-live-update');c.store.db.prepare('UPDATE runtime_settings SET paused=1').run();c.runtime.scheduler.tick();assert.equal(JSON.stringify(c.runtime.runs()),before);
    await page.evaluate(()=>{for(const stream of (window as unknown as {b1Streams:EventSource[]}).b1Streams)stream.dispatchEvent(new MessageEvent('update',{data:'{}'}));});
    await liveCard.getByText('Atlandı',{exact:true}).waitFor();await liveCard.getByText('Sonraki: Yeni çalışma yok',{exact:true}).waitFor();
    c.store.db.prepare('UPDATE runtime_settings SET paused=0').run();c.store.db.prepare('DELETE FROM scheduled_tasks WHERE id=?').run(task.id);c.store.db.prepare('DELETE FROM work_items WHERE id=?').run('schedule:'+task.id);c.runtime.disconnect('b1-live-update');
  }
  await ctx.close();
 }
 assert.deepEqual(failures,[]);
 if(visual){const manifest=resolve(baseline,'b1-taban.json');if(updating)writeFileSync(manifest,JSON.stringify({browser:browser.version(),files:files.toSorted()},null,2)+'\n');else {assert.ok(existsSync(manifest));assert.deepEqual(files.toSorted(),JSON.parse(readFileSync(manifest,'utf8')).files);const comparison=spawnSync('python3',['scripts/compare-visual.py',baseline,current,...files],{encoding:'utf8',env:{...process.env,PYTHONPATH:resolve('.cache/python')},maxBuffer:8*1024*1024});assert.equal(comparison.status,0,comparison.stdout+comparison.stderr);console.log(comparison.stdout.trim());}}
 writeFileSync(resolve(visual ? '.test-data/b1-visual.json' : '.test-data/b1-browser.json'),JSON.stringify({visual,updating,files,measurements},null,2)+'\n');console.log(`B1 browser audit passed: bubbles for 6/14/24 agents × 3 sizes × 2 themes; task form/list/history and draft-preserving version warning. Screenshots: ${files.length}`);
}catch(e){if(page && !page.isClosed())await page.screenshot({path:resolve('.test-data/b1-browser-failure.png'),scale:'css'});throw e;}finally{await browser.close();await c.app.close();cleanup(config);}
