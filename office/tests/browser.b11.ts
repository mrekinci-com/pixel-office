import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createApp } from "../server/app.js";
import { testConfig, fakeTududi, cleanup } from "./helpers.js";
import { demoSnapshot } from "../src/demo.js";
import { auditAnnotations, auditPage, auditSeats } from "./visual.audit.js";
import { checkActors } from "./layout.browser.js";
import type { Snapshot } from "../shared/types.js";
const visual = process.argv.includes("--visual"), updating = process.argv.includes("--update-baselines");
const cache = resolve(".cache/runtime"); mkdirSync(cache, {recursive:true});
process.env.TMPDIR = cache; process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(".cache/browsers");
const {chromium} = await import("playwright");
const config = testConfig(), fake = fakeTududi(), {app} = await createApp(config, {fetcher:fake.fetcher, background:false});
const browser = await chromium.launch({headless:true, ignoreDefaultArgs:["--hide-scrollbars"], args:["--no-sandbox"], downloadsPath:cache,
  env:{...process.env, LD_LIBRARY_PATH:[resolve(".cache/system-libs/usr/lib/x86_64-linux-gnu"),process.env.LD_LIBRARY_PATH].filter(Boolean).join(":")}});
const seed = demoSnapshot({departments:[],agents:[],messages:[],events:[],handoffs:[],rules:""},0);
const baseline = resolve("tests/__screenshots__"), current = resolve(".test-data/visual-b11/current"); mkdirSync(current,{recursive:true});
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
  const crop=name+"-yakin-2x.png";await page.locator(".office-viewport").screenshot({path:resolve(current,crop),scale:"device",animations:"disabled",caret:"hide"});files.push(crop);
  if(updating)for(const f of [file,crop])copyFileSync(resolve(current,f),resolve(baseline,f));
}
try {
  for(const size of [{width:1920,height:1080},{width:1366,height:768},{width:1280,height:640},{width:390,height:844}])for(const theme of ["light","dark"]){
    const context=await browser.newContext({viewport:size,locale:"tr-TR",deviceScaleFactor:2,reducedMotion:"reduce"});
    await context.addInitScript({content:`window.__name=value=>value;localStorage.setItem('po-tema','${theme}');${visual ? "const NativeDate=Date;globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:['2026-10-12T06:00:00Z']));}static now(){return 1791784800000;}};let randomSeed=17;Math.random=()=>{randomSeed=Math.imul(randomSeed,16807)>>>0;return randomSeed/4294967296;};const request=window.requestAnimationFrame.bind(window);performance.now=()=>10000;window.requestAnimationFrame=cb=>request(()=>cb(10000));" : ""}`});
    let snapshot:Snapshot=seed;
    await context.route("**/*",async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin!=="http://ofis.test"){failures.push("External request: "+url.origin);await route.abort();return;}
      if(url.pathname==="/api/snapshot"){await route.fulfill({json:snapshot});return;}
      if(url.pathname==="/api/live"){await route.fulfill({headers:{"content-type":"text/event-stream"},body:"retry: 60000\nevent: ready\ndata: {}\n\n"});return;}
      const response=await app.inject({method:request.method() as any,url:url.pathname+url.search,remoteAddress:`127.0.0.${Math.floor(size.width/100)+(theme === "dark" ? 50 : 0)}`,headers:{...await request.allHeaders(),host:url.host},payload:request.postData()||undefined});
      if(response.statusCode>=400 && url.pathname!=="/api/session")failures.push(url.pathname+": "+response.statusCode);
      await route.fulfill({status:response.statusCode,headers:Object.fromEntries(Object.entries(response.headers).filter(([,v])=>v!==undefined).map(([k,v])=>[k,Array.isArray(v)?v.join("\n"):String(v)])),body:response.rawPayload});
    });
    const page=await context.newPage();page.on("pageerror",e=>failures.push(e.message));
    await page.goto("http://ofis.test");await page.getByLabel("Sahip şifresi").fill(config.ownerPassword);await page.getByRole("button",{name:"Ofisi aç",exact:true}).click();
    const suffix=`${size.width}x${size.height}-${theme==="light" ? "aydinlik" : "koyu"}`;
    for(const count of [4,14,24]){
      snapshot={...seed,departments:seed.departments.slice(0,3),agents:Array.from({length:count},(_,i)=>({...seed.agents[i%6],id:`b11-${i}`,name:i===0 ? "Defne" : i===1 ? "Uzun adlı çalışma arkadaşı" : `Ekip ${i+1}`,
        department_id:seed.departments[i%3].id,desk_x:0,desk_y:0,status:(["bosta","calisiyor","bekliyor","kapali"] as const)[i%4],current_job:"Kaynakları inceliyorum"})),messages:[],events:[]};
      await page.reload();await page.waitForFunction(n=>document.querySelectorAll(".agent-hit[data-x]").length===n,count);await page.locator(".art-loading").waitFor({state:"hidden"});await settleScene(page);
      const audit=await auditAnnotations(page,snapshot);assert.equal(audit!.labels,count);await auditPage(page);await auditSeats(page,snapshot);
      measurements.push({size,theme,count,mode:"normal",audit});await capture(page,`b11-adlar-${count}-${suffix}`);
      await page.getByRole("button",{name:"Büyüt",exact:true}).click();
      await page.waitForTimeout(100);await settleScene(page);await auditAnnotations(page,snapshot);await capture(page,`b11-buyuk-${count}-${suffix}`);
      await page.getByRole("button",{name:"Küçült",exact:true}).click();await page.waitForFunction(()=>!document.fullscreenElement && !document.querySelector(".office-expanded"));await settleScene(page);
      if(size.width>900){
        // Exercise the actual camera controls, keeping the viewport on screen.
        for(let attempt=0;attempt<30;attempt++) {
          const scale=Number(await page.locator(".office-viewport").getAttribute("data-scale"));
          if(Math.abs(scale-.48)<.051)break;
          await page.getByRole("button",{name:scale<.48 ? "Yakınlaştır" : "Uzaklaştır",exact:true}).click();
        }
        const scale=Number(await page.locator(".office-viewport").getAttribute("data-scale"));
        assert.ok(Math.abs(scale-.48)<.051,"Camera scale should be about 0.48×");
        await settleScene(page);
        await auditAnnotations(page,snapshot);await capture(page,`b11-kucuk-${count}-${suffix}`);
        await page.getByRole("button",{name:"Sığdır",exact:true}).click();await settleScene(page);
      }
      if(!visual && count===14){await checkActors(page,snapshot,30);await auditAnnotations(page,snapshot);}
    }
    await page.getByRole("button",{name:"Ofis işlemleri",exact:true}).click();const toggle=page.getByRole("switch",{name:"Adları göster",exact:false});assert.equal(await toggle.getAttribute("aria-checked"),"true");await toggle.click();await page.getByRole("button",{name:"Ofis işlemleri",exact:true}).click();
    await page.mouse.move(0,0);await page.waitForTimeout(100);assert.equal((await auditAnnotations(page,snapshot))!.labels,0);
    await page.reload();await page.waitForFunction(()=>document.querySelectorAll(".agent-hit[data-x]").length===24);assert.equal((await auditAnnotations(page,snapshot))!.labels,0);
    const hit=page.locator('[data-agent-id="b11-0"]');await hit.focus();await page.waitForTimeout(100);assert.equal((await auditAnnotations(page,snapshot))!.labels,1);
    await hit.click();if(size.width<=900)await page.getByRole("tab",{name:"Ofis",exact:true}).click();await page.mouse.move(0,0);await page.locator(".agent-hit").evaluateAll(els=>els.forEach(el=>(el as HTMLElement).blur()));await page.waitForTimeout(100);assert.equal((await auditAnnotations(page,snapshot))!.labels,1);
    if(size.width>900){await page.locator('[data-agent-id="b11-1"]').hover();await page.waitForTimeout(100);assert.equal((await auditAnnotations(page,snapshot))!.labels,2);}
    await capture(page,`b11-secilen-ad-${suffix}`);
    await page.getByRole("button",{name:"Ofis işlemleri",exact:true}).click();assert.equal(await toggle.getAttribute("aria-checked"),"false");await toggle.click();await capture(page,`b11-ad-anahtari-${suffix}`);
    await context.close();console.log(`B1.1 passed: ${suffix}, 4/14/24 agents, name preferences and appearance.`);
  }
  assert.deepEqual(failures,[]);
  if(visual){const manifest=resolve(baseline,"b11-taban.json");if(updating)writeFileSync(manifest,JSON.stringify({browser:browser.version(),files:files.toSorted()},null,2)+"\n");else{assert.deepEqual(files.toSorted(),JSON.parse(readFileSync(manifest,"utf8")).files);const comparison=spawnSync("python3",["scripts/compare-visual.py",baseline,current,...files],{encoding:"utf8",env:{...process.env,PYTHONPATH:resolve(".cache/python")},maxBuffer:8*1024*1024});assert.equal(comparison.status,0,comparison.stdout+comparison.stderr);console.log(comparison.stdout.trim());}}
  writeFileSync(resolve(visual ? ".test-data/b11-visual.json" : ".test-data/b11-browser.json"),JSON.stringify({visual,updating,files,measurements},null,2)+"\n");
}finally{await browser.close();await app.close();cleanup(config);}
