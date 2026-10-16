// Focused B1.9 scene check without ports, real accounts or model jobs.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'vite';
import type { Page } from 'playwright';
import type { HTTPMethods } from 'fastify';
import { createApp } from '../server/app.js';
import { testConfig, fakeTududi, cleanup } from './helpers.js';
import { demoSnapshot } from '../src/demo.js';
import { auditAnnotations, auditSeats, auditPage } from './visual.audit.js';
import { auditSeatVariants } from './seated.browser.js';
import { checkActors } from './layout.browser.js';
import type { Snapshot } from '../shared/types.js';
import { makeWorld, TILE } from '../src/pixel/world.js';

const output=resolve('.test-data/b19-browser'), cache=resolve('.cache/runtime');
mkdirSync(output,{recursive:true});mkdirSync(cache,{recursive:true});
process.env.TMPDIR=cache;process.env.PLAYWRIGHT_BROWSERS_PATH=resolve('.cache/browsers');
const {chromium}=await import('playwright');
const staticDir=resolve('.test-data/b19-client');
await build({envFile:false,logLevel:'warn',build:{outDir:staticDir,emptyOutDir:true}});
const config=testConfig(), fake=fakeTududi();
const {app,runtime}=await createApp(config,{fetcher:fake.fetcher,background:false,staticDir});
const browser=await chromium.launch({headless:true,ignoreDefaultArgs:['--hide-scrollbars'],args:['--no-sandbox'],downloadsPath:cache,
  env:{...process.env,LD_LIBRARY_PATH:resolve('.cache/system-libs/usr/lib/x86_64-linux-gnu')}});
const seed=demoSnapshot({departments:[],agents:[],messages:[],events:[],handoffs:[],rules:''},0);
const failures:string[]=[], measurements:unknown[]=[];
let snapshot:Snapshot=seed, externalRequests=0;
function fixture(count:number,moving=false):Snapshot {
  return {...seed,agents:Array.from({length:count},(_,i)=>({...seed.agents[i%6],id:`b19-${i}`,name:i===1?'Uzun adı olan çalışma arkadaşı':`Ekip ${i+1}`,
    department_id:seed.departments[i%6].id,current_job:'Kaynakları inceliyorum',status:moving?'bosta':(['calisiyor','bosta','bekliyor','kapali'] as const)[i%4]})),messages:[],events:[],runtime:runtime.snapshot()};
}
async function routeContext(context:import('playwright').BrowserContext, address:string) {
  await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.origin!=='http://ofis.test'){externalRequests++;await route.abort();return;}
    if(url.pathname==='/api/snapshot'){await route.fulfill({json:snapshot});return;}
    if(url.pathname==='/api/live'){await route.fulfill({contentType:'text/event-stream',body:'retry: 60000\nevent: ready\ndata: {}\n\n'});return;}
    if(url.pathname.endsWith('/read')){await route.fulfill({json:{ok:true}});return;}
    const r=await app.inject({method:req.method() as HTTPMethods,url:url.pathname+url.search,remoteAddress:address,
      headers:{...await req.allHeaders(),host:url.host},payload:req.postData()||undefined});
    await route.fulfill({status:r.statusCode,body:r.rawPayload,headers:Object.fromEntries(Object.entries(r.headers).filter(([,v])=>v!==undefined).map(([k,v])=>[k,Array.isArray(v)?v.join('\n'):String(v)]))});
  });
}
async function login(page:Page) {
  await page.goto('http://ofis.test');await page.getByLabel('Sahip şifresi',{exact:true}).fill(config.ownerPassword);
  await page.getByRole('button',{name:'Ofisi aç',exact:true}).click();await settle(page);
}
async function settle(page:Page) {
  await page.locator('.art-loading').waitFor({state:'hidden'});
  await page.waitForFunction(()=>{const v=document.querySelector<HTMLElement>('.office-viewport'),c=document.querySelector<HTMLElement>('.office-canvas');
    return v&&c&&v.dataset.cols===c.dataset.renderedCols&&v.dataset.rows===c.dataset.renderedRows&&document.querySelector('.agent-hit[data-x]');});
  await page.evaluate(async()=>{await document.fonts.ready;await new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done())));});
}
async function chatBox(page:Page,open:boolean) {
  const result=await page.evaluate(open=>{
    const el=document.querySelector<HTMLElement>(open?'.floating-chat':'.chat-launcher')!,b=el.getBoundingClientRect();
    const host=document.querySelector('.office-scene')!.getBoundingClientRect(), controls=document.querySelector('.camera-controls')!.getBoundingClientRect();
    const status=document.querySelector('.office-status-pill')!.getBoundingClientRect(),heading=document.querySelector('.scene-heading')!.getBoundingClientRect();
    const director=document.querySelector('.gm-minimized')?.getBoundingClientRect();
    const hit=(a:DOMRect,c:DOMRect)=>a.left<c.right&&a.right>c.left&&a.top<c.bottom&&a.bottom>c.top;
    return {right:host.right-b.right,bottom:host.bottom-b.bottom,inside:b.left>=0&&b.top>=0&&b.right<=innerWidth&&b.bottom<=innerHeight,
      controlsOverlap:hit(b,controls),statusOverlap:hit(b,status),controlsWidth:controls.width,statusInHeader:status.top>=heading.top&&status.bottom<=heading.bottom,
      directorGap:director?director.top-b.bottom:null,directorOverlap:director?hit(b,director):false};
  },open);
  assert.ok(result.inside);assert.ok(result.right<=25&&result.right>=0,"Chat must align with the right edge");
  if(result.directorGap===null)assert.ok(result.bottom<=25&&result.bottom>=0,"Chat must align with the bottom edge");
  else assert.ok(result.directorGap>=8&&!result.directorOverlap,"Chat must stay above the minimized terminal card");
  assert.ok(!result.controlsOverlap&&!result.statusOverlap);assert.ok(result.controlsWidth<200,"Zoom controls must not span the scene");
  assert.ok(result.statusInHeader,"Status badge must stay in the scene heading");
  return result;
}
try {
  let index=0;
  for(const size of [{width:1920,height:1000},{width:1366,height:768},{width:1280,height:640},{width:390,height:844}]) for(const theme of ['light','dark']) {
    const context=await browser.newContext({viewport:size,locale:'tr-TR',deviceScaleFactor:2,reducedMotion:'reduce',serviceWorkers:'block'});
    await context.addInitScript({content:`window.__name=v=>v;localStorage.setItem('po-tema','${theme}');localStorage.setItem('po-gm-window','hidden');const raf=requestAnimationFrame.bind(window);performance.now=()=>10000;requestAnimationFrame=cb=>raf(()=>cb(10000));`});
    await routeContext(context,`192.0.2.${++index}`);
    const page=await context.newPage();page.on('pageerror',e=>failures.push(e.message));snapshot=fixture(4);await login(page);
    if(size.width===1920&&theme==='light') {
      await auditSeatVariants(page);
      for(const selector of ['.director-screen','.director-character']) for(const action of ['click','keyboard']) {
        const button=page.locator(selector);if(action==='click')await button.click();else{await button.focus();await page.keyboard.press('Enter');}
        await page.getByRole('dialog',{name:'Genel Müdür terminali',exact:true}).waitFor({state:'visible'});
        await page.getByLabel('Genel Müdür terminalini küçült',{exact:true}).click();
      }
      await page.evaluate(()=>localStorage.setItem('po-gm-window','hidden'));await page.reload();await settle(page);
    }
    for(const count of [4,14,24]) {
      snapshot=fixture(count);await page.reload();
      if(size.width<=900)await page.getByRole('tab',{name:'Ofis',exact:true}).click();
      await settle(page);
      assert.equal(await page.locator('.director-label').count(),0);
      const suffix=`${count}-${size.width}x${size.height}-${theme}`;
      for(const expanded of [false,true]) {
        if(expanded){await page.getByRole('button',{name:'Büyüt',exact:true}).click();await settle(page);}
        try {await auditSeats(page,snapshot);} catch(error) {
          const layout=await page.locator('.office-viewport').getAttribute('data-layout');
          const world=makeWorld(snapshot.departments,snapshot.agents,layout==='wide'?'wide':'balanced');
          const seated=snapshot.agents.filter(a=>a.status!=='kapali').map(a=>({id:a.id,appearance:a.appearance}));
          writeFileSync(resolve(output,'oturma-hatasi.json'),JSON.stringify(await page.evaluate(({world,seated})=>window.officeSeatProbe.scene(world,seated,10000),{world,seated}),null,2));
          throw error;
        }
        await auditAnnotations(page,snapshot);await auditPage(page);
        const layout=await page.locator('.office-viewport').getAttribute('data-layout');
        const world=makeWorld(snapshot.departments,snapshot.agents,layout==='wide'?'wide':'balanced');
        const tableCenters=world.rooms.map(r=>(r.x+r.w/2)*TILE);
        const actual=await page.locator('.department-hit').evaluateAll(els=>els.map(el=>parseFloat((el as HTMLElement).style.left)+parseFloat((el as HTMLElement).style.width)/2));
        assert.deepEqual(actual,tableCenters,"Signs must align with island centers");
        const contained=await page.evaluate(({rugs,tables})=>{
          const stage=document.querySelector('.pixel-stage')!.getBoundingClientRect(),scale=Number(document.querySelector<HTMLElement>('.office-viewport')!.dataset.scale);
          return [...document.querySelectorAll<HTMLElement>('.agent-label')].map(label=>{
            const id=label.closest<HTMLElement>('.agent-hit')!.dataset.agentId!,table=tables.find(t=>t.seatAgentIds?.includes(id))!,rug=rugs.find(r=>r.x===(table.x-1)*16&&r.y===(table.y-1)*16)!;
            const box=label.getBoundingClientRect();return {id,inside:box.left>=stage.left+rug.x*scale-.5&&box.right<=stage.left+(rug.x+rug.w)*scale+.5&&box.top>=stage.top+rug.y*scale-.5&&box.bottom<=stage.top+(rug.y+rug.h)*scale+.5};
          });
        },{rugs:world.rugs,tables:world.furniture.filter(f=>f.kind==='desk')});
        assert.ok(contained.every(l=>l.inside),`Names must stay inside rugs: ${JSON.stringify(contained.filter(l=>!l.inside))}`);
        await page.screenshot({path:resolve(output,`${expanded?'buyuk':'normal'}-${suffix}.png`),animations:'disabled',scale:'css'});
        if(expanded) {
          if(await page.locator('.chat-launcher').count())await page.getByRole('button',{name:/^Sohbeti aç/}).click();
          const open=await chatBox(page,true);const draft=page.getByLabel('Mesajınız',{exact:true});await draft.fill('Taslak sağdaki sohbette korunur.');
          await auditPage(page);await page.getByRole('button',{name:'Sohbeti küçült',exact:true}).click();const closed=await chatBox(page,false);
          await page.getByRole('button',{name:/^Sohbeti aç/}).click();assert.equal(await draft.inputValue(),'Taslak sağdaki sohbette korunur.');
          await page.getByRole('button',{name:'Küçült',exact:true}).click();await settle(page);
          if(size.width>900)assert.equal(await draft.inputValue(),'Taslak sağdaki sohbette korunur.');
          measurements.push({size,theme,count,open,closed});
        }
      }
      if(count===4) {
        await page.evaluate(()=>window.dispatchEvent(new CustomEvent('office:director-screen')));
        await page.getByRole('dialog',{name:'Genel Müdür terminali',exact:true}).waitFor({state:'visible'});
        await page.getByLabel('Genel Müdür terminalini küçült',{exact:true}).click();
        await page.getByRole('button',{name:'Büyüt',exact:true}).click();await settle(page);
        if(await page.locator('.chat-launcher').count())await page.getByRole('button',{name:/^Sohbeti aç/}).click();
        const directorOpen=await chatBox(page,true);
        await page.screenshot({path:resolve(output,`terminal-karti-sohbet-acik-${suffix}.png`),animations:'disabled',scale:'css'});
        await page.getByRole('button',{name:'Sohbeti küçült',exact:true}).click();const directorClosed=await chatBox(page,false);
        await page.screenshot({path:resolve(output,`terminal-karti-${suffix}.png`),animations:'disabled',scale:'css'});
        measurements.push({size,theme,directorOpen,directorClosed});
        await page.getByRole('button',{name:'Küçült',exact:true}).click();await settle(page);
      }
    }
    await context.close();console.log(`B1.9 scene/right chat passed: ${size.width}×${size.height}, ${theme}, 4/14/24 agents`);
  }
  const context=await browser.newContext({viewport:{width:1920,height:1000},locale:'tr-TR',reducedMotion:'no-preference'});
  await context.addInitScript({content:"window.__name=v=>v;localStorage.setItem('po-hareket','sakin');let clock=0;performance.now=()=>clock;cancelAnimationFrame=id=>clearTimeout(id);requestAnimationFrame=cb=>setTimeout(()=>cb(clock+=100),0);"});
  await routeContext(context,'192.0.2.99');const page=await context.newPage();page.on('pageerror',e=>failures.push(e.message));snapshot=fixture(14,true);await login(page);
  for(const count of [14,24])for(const expanded of [false,true]) {
    snapshot=fixture(count,true);await page.reload();await settle(page);if(expanded){await page.getByRole('button',{name:'Büyüt',exact:true}).click();await settle(page);}
    await checkActors(page,snapshot,60);console.log(`B1.9 real walking passed: ${count} agents, ${expanded?'wide':'balanced'}`);
    if(expanded)await page.getByRole('button',{name:'Küçült',exact:true}).click();
  }
  await context.close();assert.deepEqual(failures,[]);assert.equal(externalRequests,0);
  writeFileSync(resolve(output,'olcumler.json'),JSON.stringify({measurements,externalRequests,failures},null,2)+'\n');
} finally {await browser.close();await app.close();cleanup(config);}
