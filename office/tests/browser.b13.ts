import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {defaultSettings, type Run} from '../shared/runtime.js';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import {spawnSync} from 'node:child_process';
import { resolve } from 'node:path';
import { createApp } from '../server/app.js';
import { testConfig, fakeTududi, cleanup } from './helpers.js';
import { demoSnapshot } from '../src/demo.js';
import { auditAnnotations, auditPage, auditSeats } from './visual.audit.js';
import { checkActors } from './layout.browser.js';
import type { Snapshot } from '../shared/types.js';
const cache=resolve('.cache/runtime');mkdirSync(cache,{recursive:true});process.env.TMPDIR=cache;process.env.PLAYWRIGHT_BROWSERS_PATH=resolve('.cache/browsers');
const { chromium }=await import('playwright');
const config=testConfig(),fake=fakeTududi(),{app}=await createApp(config,{fetcher:fake.fetcher,background:false});
const browser=await chromium.launch({headless:true,args:['--no-sandbox'],downloadsPath:cache,env:{...process.env,LD_LIBRARY_PATH:[resolve('.cache/system-libs/usr/lib/x86_64-linux-gnu'),process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')}});
const seed=demoSnapshot({departments:[],agents:[],messages:[],events:[],handoffs:[],rules:''},0);
const visual=process.argv.includes('--visual'),updating=process.argv.includes('--update-baselines');
const evidence=resolve(visual ? '.test-data/visual-b13/current' : '.test-data/b13');mkdirSync(evidence,{recursive:true});
const baseline=resolve('tests/__screenshots__'),files:string[]=[];
async function capture(page:import('playwright').Page,name:string,near:string) {
  if(visual) {
    await page.evaluate(async()=>{await document.fonts.ready;const frame=()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done())));document.documentElement.style.transform='translate(1px,1px)';await frame();document.documentElement.style.transform='';await frame();});
    const options={scale:'css',animations:'disabled',caret:'hide'} as const;
    let shot=await page.screenshot(options),stable=false;
    for(let i=0;i<8;i++){const next=await page.screenshot(options);if(shot.equals(next)){stable=true;break;}shot=next;}
    assert.ok(stable,name+": two consecutive captures must match");writeFileSync(resolve(evidence,name+'.png'),shot);
  } else await page.screenshot({path:resolve(evidence,name+'.png'),scale:'css'});
  await page.locator(near).screenshot({path:resolve(evidence,name+'-yakin-2x.png'),scale:'device',animations:'disabled',caret:'hide'});
  if(visual)for(const file of [name+'.png',name+'-yakin-2x.png']){files.push(file);if(updating)copyFileSync(resolve(evidence,file),resolve(baseline,file));}
}
const problems:string[]=[],measurements:unknown[]=[];
try {
  for(const size of [{width:1920,height:1000},{width:1366,height:768},{width:1280,height:640},{width:390,height:844}])for(const theme of ['light','dark']) {
    if(process.env.B13_FILTER && process.env.B13_FILTER!==`${size.width}x${size.height}-${theme}`)continue;
    const context=await browser.newContext({viewport:size,locale:'tr-TR',deviceScaleFactor:2,reducedMotion:visual ? 'reduce':'no-preference'});
    // Accelerate the RAF clock without changing production motion; run the same simulation in canvas.
    await context.addInitScript({content:`window.__name=value=>value;localStorage.setItem('po-tema','${theme}');${visual ? '' : "localStorage.setItem('po-hareket','canli');"}const nativeRAF=requestAnimationFrame.bind(window),nativeCancel=cancelAnimationFrame.bind(window);let motionClock=0;window.cancelAnimationFrame=id=>clearTimeout(id);window.requestAnimationFrame=callback=>setTimeout(()=>callback(motionClock+=100),0);${visual ? "const NativeDate=Date;globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:['2026-10-13T10:00:00Z']));}static now(){return 1791885600000;}};performance.now=()=>10000;window.cancelAnimationFrame=nativeCancel;window.requestAnimationFrame=callback=>nativeRAF(()=>callback(10000));" : ''}`});
    let snapshot:Snapshot=seed;
    let savedRun="";
    await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());
      if(url.origin!=='http://ofis.test'){problems.push("External request: "+url.origin);await route.abort();return;}
      if(/^\/api\/messages\/[^/]+\/read$/.test(url.pathname)){await route.fulfill({json:{ok:true}});return;}
      if(/^\/api\/runs\/[^/]+\/save-continue$/.test(url.pathname)){savedRun=url.pathname.split('/')[3];await route.fulfill({json:{ok:true}});return;}
      if(url.pathname==='/api/snapshot'){await route.fulfill({json:snapshot});return;}
      if(url.pathname==='/api/live'){await route.fulfill({headers:{'content-type':'text/event-stream'},body:'retry: 60000\nevent: ready\ndata: {}\n\n'});return;}
      const response=await app.inject({method:request.method() as any,url:url.pathname+url.search,remoteAddress:`127.0.0.${100+Math.floor(size.width/100)+(theme==="dark" ? 50:0)}`,headers:{...await request.allHeaders(),host:url.host},payload:request.postData()||undefined});
      if(response.statusCode>=400 && url.pathname!=='/api/session')problems.push(url.pathname+': '+response.statusCode);
      await route.fulfill({status:response.statusCode,headers:Object.fromEntries(Object.entries(response.headers).filter(([,v])=>v!==undefined).map(([k,v])=>[k,Array.isArray(v)?v.join('\n'):String(v)])),body:response.rawPayload});
    });
    const page=await context.newPage();page.on('pageerror',e=>{problems.push(e.message);console.error("Page error:",e.message);});
    await page.goto('http://ofis.test');await page.getByLabel('Sahip şifresi').fill(config.ownerPassword);await page.getByRole('button',{name:'Ofisi aç',exact:true}).click();
    if(!process.argv.includes("--recovery-only"))for(const count of (process.env.B13_COUNTS ? process.env.B13_COUNTS.split(",").map(Number) : [4,6,14,24])) {
      snapshot={...seed,departments:seed.departments.slice(0,3),agents:Array.from({length:count},(_,i)=>({...seed.agents[i%6],id:`b13-${i}`,name:['Selin','Kerem','Mert','Defne'][i%4]+(i>=4 ? ` ${i+1}`:''),status:'bosta',department_id:seed.departments[i%3].id,desk_x:0,desk_y:0})),messages:[],events:[]};
      console.log(`B1.3 denetleniyor: ${count} ajan, ${size.width}×${size.height}, ${theme}`);
      await page.reload();await page.waitForFunction(n=>document.querySelectorAll('.agent-hit[data-x]').length===n,count);
      if(!visual)await checkActors(page,snapshot,60);
      const live=await page.evaluate(async({count,visual})=>{
        const errors:string[]=[];let walking=0;
        for(let frame=0;frame<(visual ? 1:60);frame++) {
          if(frame)await new Promise(r=>setTimeout(r,50));
          const elements=[...document.querySelectorAll<HTMLElement>('.agent-hit')],scale=Number(document.querySelector<HTMLElement>('.office-viewport')!.dataset.scale);
          const actors=elements.map(el=>({el,box:el.getBoundingClientRect(),moving:el.dataset.walking==='true'}));
          const moving=actors.filter(a=>a.moving).length;walking+=moving;
          if(moving>Math.max(1,Math.floor(count/4)))errors.push("Concurrent idle-walker limit");
          for(let i=0;i<actors.length;i++)for(const b of actors.slice(i+1)) {
            const a=actors[i];if(a.moving || b.moving)continue;
            const xGap=Math.max(b.box.left-a.box.right,a.box.left-b.box.right),yGap=Math.max(b.box.top-a.box.bottom,a.box.top-b.box.bottom);
            if(Math.max(xGap,yGap)<16*scale-1)errors.push("One free tile between stationary agents");
          }
          const labels=elements.map(el=>el.querySelector<HTMLElement>('.agent-label')!).filter(el=>getComputedStyle(el).display!=='none');
          for(let i=0;i<labels.length;i++)for(const other of labels.slice(i+1)) {const a=labels[i].getBoundingClientRect(),b=other.getBoundingClientRect();
            if(a.left<b.right-1 && a.right>b.left+1 && a.top<b.bottom-1 && a.bottom>b.top+1 && Math.min(Number(getComputedStyle(labels[i]).opacity),Number(getComputedStyle(other).opacity))>=1)errors.push("One overlapping name must be muted: "+JSON.stringify({a:labels[i].closest<HTMLElement>('.agent-hit')!.dataset,b:other.closest<HTMLElement>('.agent-hit')!.dataset,boxA:a,boxB:b}));}
        }
        return {errors:[...new Set(errors)],walking};
      },{count,visual});
      if(live.errors.length)await page.screenshot({path:resolve(evidence,`b13-hata-${count}-${size.width}x${size.height}-${theme}.png`),scale:"css"});
      assert.deepEqual(live.errors,[]);await auditAnnotations(page,snapshot);
      const suffix=`${count}-${size.width}x${size.height}-${theme}`;
      if(!visual)await capture(page,`b13-hareket-${suffix}`,'.office-viewport');
      await page.emulateMedia({reducedMotion:'reduce'});await page.reload();await page.waitForFunction(n=>document.querySelectorAll('.agent-hit[data-x]').length===n,count);
      const before=await page.locator('.agent-hit').evaluateAll(els=>els.map(el=>[(el as HTMLElement).dataset.x,(el as HTMLElement).dataset.y]));
      await page.waitForTimeout(700);const after=await page.locator('.agent-hit').evaluateAll(els=>els.map(el=>[(el as HTMLElement).dataset.x,(el as HTMLElement).dataset.y]));
      assert.deepEqual(before,after);assert.equal(await page.locator('.agent-hit[data-walking="true"]').count(),0);
      await auditAnnotations(page,snapshot);await auditSeats(page,snapshot);await auditPage(page);
      await capture(page,`b13-dinlenme-${suffix}`,'.office-viewport');
      measurements.push({size,theme,count,live,reduced:true});console.log(`B1.3 ${visual ? "visual" : "live motion"}: ${suffix}, ${visual ? "fixed frames" : "120 frames"}, spacing/names/bounds and reduced motion passed.`);
      await page.emulateMedia({reducedMotion:visual ? 'reduce':'no-preference'});
    }
    await page.emulateMedia({reducedMotion:'reduce'});
    const agent=snapshot.agents[0], runId=randomUUID(), messageId=randomUUID(), at='2026-10-13T10:00:00Z';
    const run:Run={id:runId,agent_id:agent.id,chain_id:randomUUID(),depth:0,trigger:'Elle',summary:'Dosyaları düzenle',conversation_type:'everyone',conversation_id:null,state:'budget_exceeded',created_at:at,started_at:at,finished_at:at,output:'Dosyaları kaydettim. Kontrol adımı kaldı.',reason:'Token bütçesi aşıldı.',calls:1,retry:0,duration_ms:5000,usage:{input_tokens:101},message_id:messageId};
    const runtime={connected:true,paused:false,models:{claude:[],codex:[]},settings: {...defaultSettings, language: 'tr' as const},runs:[run],approvals:[],links:[],artifacts:[],messageRuns:[{...run,ahead:0}]};
    snapshot={...seed,agents:snapshot.agents.slice(0,4),departments:seed.departments.slice(0,3),runtime,messages:[{id:messageId,sender_type:'user',sender_agent_id:null,recipient_type:'everyone',recipient_id:null,text:'B1.3 dosyaları düzenle',created_at:at,read_at:at},{id:randomUUID(),sender_type:'agent',sender_agent_id:agent.id,recipient_type:'everyone',recipient_id:null,text:run.output,created_at:at,read_at:at}],events:[{id:randomUUID(),agent_id:agent.id,department_id:null,kind:'run_budget_exceeded',text:'Token bütçesi aşıldı. İş yarıda kalmış olabilir.',created_at:at,conversation_type:'everyone',conversation_id:null,run_id:runId,message_id:messageId}]};
    await page.reload();if(size.width<=900)await page.getByRole('tab',{name:'Sohbet',exact:true}).click();
    await page.locator('.message').filter({hasText:'B1.3 dosyaları düzenle'}).getByText(/bütçede kesildi/).waitFor();
    await page.getByText(run.output,{exact:true}).waitFor();await auditPage(page);
    await capture(page,`b13-butce-${size.width}x${size.height}-${theme}`,'.chat-messages');
    run.state='failed';run.reason='Kod klasöründe kaydedilmemiş değişiklikler var. Değişiklikleri kaydet ve devam et düğmesiyle bu işi sürdürebilirsiniz.';
    snapshot={...snapshot,messages:snapshot.messages.slice(0,1),events:[],runtime:{...runtime,runs:[run],messageRuns:[{...run,ahead:0}]}};
    await page.reload();if(size.width<=900)await page.getByRole('tab',{name:'Sohbet',exact:true}).click();
    const save=page.getByRole('button',{name:'Değişiklikleri kaydet ve devam et',exact:true});await save.waitFor();await auditPage(page);
    await capture(page,`b13-kaydet-${size.width}x${size.height}-${theme}`,'.chat-messages');
    await save.click();assert.equal(savedRun,runId);console.log(`B1.3 budget response and save/resume button passed: ${size.width}×${size.height}, ${theme}`);
    await context.close();
  }
  assert.deepEqual(problems,[]);
  if(visual){const manifest=resolve(baseline,'b13-taban.json');if(updating)writeFileSync(manifest,JSON.stringify({browser:browser.version(),files:files.toSorted()},null,2)+'\n');else {assert.deepEqual(files.toSorted(),JSON.parse(readFileSync(manifest,'utf8')).files);const comparison=spawnSync('python3',['scripts/compare-visual.py',baseline,evidence,...files],{encoding:'utf8',env:{...process.env,PYTHONPATH:resolve('.cache/python')},maxBuffer:8*1024*1024});assert.equal(comparison.status,0,comparison.stdout+comparison.stderr);console.log(comparison.stdout.trim());}}
  writeFileSync(resolve(evidence,'hareket.json'),JSON.stringify({measurements},null,2)+'\n');
}finally{await browser.close();await app.close();cleanup(config);}
