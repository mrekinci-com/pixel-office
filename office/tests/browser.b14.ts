import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createApp } from "../server/app.js";
import { testConfig, fakeTududi, cleanup } from "./helpers.js";
import { demoSnapshot } from "../src/demo.js";
import { auditAnnotations, auditPage, auditSeats } from "./visual.audit.js";
import type { Snapshot } from "../shared/types.js";
const visual = process.argv.includes("--visual"), updating = process.argv.includes("--update-baselines");
const cache = resolve(".cache/runtime"); mkdirSync(cache, {recursive:true});
process.env.TMPDIR = cache; process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(".cache/browsers");
const {chromium} = await import("playwright");
const config = testConfig(), fake = fakeTududi(), {app} = await createApp(config, {fetcher:fake.fetcher, background:false});
const browser = await chromium.launch({headless:true, ignoreDefaultArgs:["--hide-scrollbars"], args:["--no-sandbox"], downloadsPath:cache,
  env:{...process.env, LD_LIBRARY_PATH:[resolve(".cache/system-libs/usr/lib/x86_64-linux-gnu"),process.env.LD_LIBRARY_PATH].filter(Boolean).join(":")}});
const seed = demoSnapshot({departments:[],agents:[],messages:[],events:[],handoffs:[],rules:""},0);
const baseline = resolve("tests/__screenshots__"), current = resolve(".test-data/visual-b14/current"); mkdirSync(current,{recursive:true});
const files:string[]=[], measurements:unknown[]=[], failures:string[]=[];
async function settleScene(page:import("playwright").Page) {
  await page.waitForFunction(() => {
    const view=document.querySelector<HTMLElement>(".office-viewport"),canvas=document.querySelector<HTMLElement>(".office-canvas");
    if(!view || !canvas || canvas.dataset.renderedCols!==view.dataset.cols || canvas.dataset.renderedRows!==view.dataset.rows)return false;
    const scale=Number(view.dataset.scale);
    return [...document.querySelectorAll<HTMLElement>(".agent-label,.agent-bubble")].filter(el=>getComputedStyle(el).display!=="none" && getComputedStyle(el).visibility==="visible")
      .every(el=>Math.abs(parseFloat(getComputedStyle(el).fontSize)*scale-12)<.01);
  });
  await page.evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));
}
async function capture(page:import("playwright").Page, name:string) {
  if(!visual)return;
  await page.evaluate(async()=>{await document.fonts.ready; const frame=()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done())));
    document.documentElement.style.transform="translate(1px,1px)";await frame();document.documentElement.style.transform="";await frame();});
  const options={scale:"css",animations:"disabled",caret:"hide"} as const;
  let shot=await page.screenshot(options), stable=false;
  for(let i=0;i<8;i++){const next=await page.screenshot(options);if(shot.equals(next)){stable=true;break;}shot=next;}
  assert.ok(stable,name+": two consecutive captures must match");
  const file=name+".png";writeFileSync(resolve(current,file),shot);files.push(file);
  const crop=name+"-yakin-2x.png";await page.locator(".floating-chat,.chat-launcher").screenshot({path:resolve(current,crop),scale:"device",animations:"disabled",caret:"hide"});files.push(crop);
  if(updating)for(const f of [file,crop])copyFileSync(resolve(current,f),resolve(baseline,f));
}
try {
  for(const size of [{width:1920,height:1080},{width:1366,height:768},{width:1280,height:640}])for(const theme of ["light","dark"]) {
    const context=await browser.newContext({viewport:size,locale:"tr-TR",deviceScaleFactor:2,reducedMotion:"reduce"});
    await context.addInitScript({content:`window.__name=value=>value;localStorage.setItem('po-tema','${theme}');const NativeDate=Date;globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:['2026-10-13T10:00:00Z']));}static now(){return 1791885600000;}};const raf=requestAnimationFrame.bind(window);performance.now=()=>10000;window.requestAnimationFrame=cb=>raf(()=>cb(10000));`});
    const snapshot:Snapshot={...seed,agents:seed.agents.map(a=>({...a,status:"bosta"})),messages:[{
      id:"b14-sohbet",sender_agent_id:null,sender_type:"user",recipient_type:"everyone",recipient_id:null,
      text:"Ofisteki sohbet burada görünür.",created_at:"2026-10-13T10:00:00Z",read_at:null,
    }],events:[]};
    await context.route("**/*",async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin!=="http://ofis.test"){failures.push("External request: "+url.origin);await route.abort();return;}
      if(url.pathname==="/api/snapshot"){await route.fulfill({json:snapshot});return;}
      if(url.pathname==="/api/live"){await route.fulfill({headers:{"content-type":"text/event-stream"},body:"retry: 60000\nevent: ready\ndata: {}\n\n"});return;}
      if(url.pathname.endsWith("/read")){await route.fulfill({json:{ok:true}});return;}
      const response=await app.inject({method:request.method() as any,url:url.pathname+url.search,remoteAddress:`127.0.0.${Math.floor(size.width/100)+(theme==="dark" ? 50:0)}`,headers:{...await request.allHeaders(),host:url.host},payload:request.postData()||undefined});
      await route.fulfill({status:response.statusCode,headers:Object.fromEntries(Object.entries(response.headers).filter(([,v])=>v!==undefined).map(([k,v])=>[k,Array.isArray(v)?v.join("\n"):String(v)])),body:response.rawPayload});
    });
    const page=await context.newPage();page.on("pageerror",e=>failures.push(e.message));
    await page.goto("http://ofis.test");await page.getByLabel("Sahip şifresi").fill(config.ownerPassword);await page.getByRole("button",{name:"Ofisi aç",exact:true}).click();
    await page.locator(".art-loading").waitFor({state:"hidden"});await settleScene(page);
    assert.equal(await page.locator('.agent-hit[data-seated="true"]').count(),snapshot.agents.length);
    await auditSeats(page,snapshot);await auditAnnotations(page,snapshot);
    await page.evaluate(()=>{document.addEventListener('office:director-screen',()=>document.documentElement.dataset.directorEvent='yes',{once:true});});
    await page.getByRole('button',{name:'Genel Müdür masası ekranı',exact:true}).focus();
    await page.getByRole('button',{name:'Genel Müdür masası ekranı',exact:true}).click();
    assert.equal(await page.locator('html').getAttribute('data-director-event'),'yes');
    await page.evaluate(()=>{document.documentElement.dataset.directorEvent='';document.addEventListener('office:director-screen',()=>document.documentElement.dataset.directorEvent='keyboard',{once:true});});
    await page.getByRole('button',{name:'Genel Müdür masası ekranı',exact:true}).focus();await page.keyboard.press('Enter');
    assert.equal(await page.locator('html').getAttribute('data-director-event'),'keyboard');
    await page.getByRole('button',{name:'Ofis işlemleri',exact:true}).click();
    await page.getByRole('radio',{name:'Hareket: durgun',exact:false}).click();
    assert.equal(await page.evaluate(()=>localStorage.getItem('po-hareket')),'durgun');
    await page.getByRole('button',{name:'Ofis işlemleri',exact:true}).click();
    await page.getByRole('button',{name:'Büyüt',exact:true}).click();await settleScene(page);
    const suffix=`${size.width}x${size.height}-${theme}`;
    async function visibleChat(open:boolean) {
      const boxes=await page.evaluate(open=>{
        const selectors=open ? ['.floating-chat','.conversation-heading','.chat-compose','.chat-compose textarea'] : ['.chat-launcher'];
        const controls=['.camera-controls','.office-status-pill'].map(s=>document.querySelector(s)!.getBoundingClientRect());
        return selectors.map(selector=>{
          const el=document.querySelector<HTMLElement>(selector)!,b=el.getBoundingClientRect();
          const inside=b.width>0 && b.height>0 && b.left>=0 && b.top>=0 && b.right<=innerWidth && b.bottom<=innerHeight;
          const unobscured=!controls.some(c=>b.left<c.right && b.right>c.left && b.top<c.bottom && b.bottom>c.top);
          const point=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);
          return {selector,inside,unobscured,clickable:!!point && (el.contains(point)||point.contains(el)),box:{x:b.x,y:b.y,w:b.width,h:b.height}};
        });
      },open);
      for(const box of boxes){assert.ok(box.inside,JSON.stringify(box));assert.ok(box.unobscured,JSON.stringify(box));assert.ok(box.clickable,JSON.stringify(box));}
      measurements.push({size,theme,open,boxes});
    }
    if(await page.locator(".chat-launcher").count()) await page.getByRole("button",{name:/^Sohbeti aç/}).click();
    await visibleChat(true);await auditPage(page);
    assert.ok(await page.getByText('Ofisteki sohbet burada görünür.',{exact:true}).isVisible());
    const textarea=page.getByPlaceholder('Mesaj yazın… @ ile ajan seçin');await textarea.fill('Taslak korunuyor');
    await capture(page,`b14-sohbet-acik-${suffix}`);
    await page.getByRole('button',{name:'Sohbeti küçült',exact:true}).click();await visibleChat(false);
    await capture(page,`b14-sohbet-kapali-${suffix}`);
    await page.getByRole('button',{name:/^Sohbeti aç/}).click();await visibleChat(true);assert.equal(await textarea.inputValue(),'Taslak korunuyor');
    await page.getByRole('button',{name:'Küçült',exact:true}).click();await settleScene(page);assert.equal(await textarea.inputValue(),'Taslak korunuyor');
    await context.close();console.log(`B1.4 chat/screens/seating passed: ${suffix}`);
  }
  assert.deepEqual(failures,[]);
  if(visual){const manifest=resolve(baseline,"b14-taban.json");if(updating)writeFileSync(manifest,JSON.stringify({browser:browser.version(),files:files.toSorted()},null,2)+"\n");else{assert.deepEqual(files.toSorted(),JSON.parse(readFileSync(manifest,"utf8")).files);const comparison=spawnSync("python3",["scripts/compare-visual.py",baseline,current,...files],{encoding:"utf8",env:{...process.env,PYTHONPATH:resolve(".cache/python")},maxBuffer:8*1024*1024});assert.equal(comparison.status,0,comparison.stdout+comparison.stderr);console.log(comparison.stdout.trim());}}
  writeFileSync(resolve(".test-data/b14-browser.json"),JSON.stringify({visual,updating,files,measurements},null,2)+"\n");
}finally{await browser.close();await app.close();cleanup(config);}
