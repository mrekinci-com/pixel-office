import assert from 'node:assert/strict';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { resolve,extname } from 'node:path';
import { build } from 'esbuild';
import { createApp } from '../server/app.js';
import { testConfig,fakeTududi,cleanup } from './helpers.js';
// Bundle only for this source-level browser test. No application server, port,
// container, production build, or model is started.
const cache=resolve('.cache/runtime');mkdirSync(cache,{recursive:true});process.env.TMPDIR=cache;process.env.PLAYWRIGHT_BROWSERS_PATH=resolve('.cache/browsers');
const { chromium }=await import('playwright');
const bundle=await build({entryPoints:['src/main.tsx'],bundle:true,write:false,outdir:'.test-data/b23-browser',format:'esm',external:['/assets/*'],jsx:'automatic',define:{'import.meta.env.OFIS_BUILD_ID':'"b2-browser"'},logLevel:'silent'});
const js=bundle.outputFiles.find(f=>f.path.endsWith('.js'))!.text,css=bundle.outputFiles.find(f=>f.path.endsWith('.css'))!.text;
const config={...testConfig(),publicOrigin:'http://ofis.test',runnerKey:'b2-browser-runner-key-'.repeat(3)},fake=fakeTududi(),c=await createApp(config,{fetcher:fake.fetcher,background:false,buildId:'b2-browser'});
const browser=await chromium.launch({headless:true,args:['--no-sandbox'],downloadsPath:cache,env:{...process.env,LD_LIBRARY_PATH:[resolve('.cache/system-libs/usr/lib/x86_64-linux-gnu'),process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')}});
let ownerCookie='';const posts:{url:string;body:any}[]=[],errors:string[]=[];
try{
 c.runtime.heartbeat('browser-runner',{codex:['gpt-6.1-sol'],claude:['sonnet']});
 const context=await browser.newContext({locale:'tr-TR',viewport:{width:1440,height:900}});const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript({content:`class TestSource extends EventTarget {static OPEN=1;readyState=1;constructor(){super();(window.b2Sources ||= []).push(this);setTimeout(()=>this.dispatchEvent(new MessageEvent('ready',{data:'{}'})),0);}close(){this.readyState=2;}}Object.defineProperty(window,'EventSource',{value:TestSource});`});

 const liveListener=()=>{void page.evaluate(()=>{for(const source of (window as typeof window & {b2Sources?:EventSource[]}).b2Sources || [])if(source.readyState===1)source.dispatchEvent(new MessageEvent('update',{data:'{}'}));}).catch(()=>{});};c.office.bus.on('update',liveListener);
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!=='http://ofis.test')return route.abort();
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="tr"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/test.css"></head><body><div id="root"></div><script type="module" src="/test.js"></script></body></html>'});
  if(url.pathname==='/test.js')return route.fulfill({contentType:'application/javascript',body:js});if(url.pathname==='/test.css')return route.fulfill({contentType:'text/css',body:css});
  if(url.pathname.startsWith('/api/')){const body=req.postDataJSON() || undefined;if(req.method()!=='GET')posts.push({url:url.pathname,body});const headers={...req.headers(),cookie:ownerCookie,'x-ofis-islem':'1'};const response=await c.app.inject({method:req.method() as any,url:url.pathname+url.search,headers,payload:body});const sessionCookie=response.cookies.find(cookie=>cookie.name==='ofis_session');if(sessionCookie)ownerCookie=sessionCookie.name+'='+sessionCookie.value;return route.fulfill({status:response.statusCode,contentType:'application/json',body:response.body});}
  const file=resolve('public','.'+url.pathname);if(!file.startsWith(resolve('public')+'/'))return route.abort();try{return route.fulfill({body:readFileSync(file),contentType:extname(file)==='.png'?'image/png':extname(file)==='.woff2'?'font/woff2':'application/octet-stream'});}catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto('http://ofis.test');await page.getByLabel('Sahip şifresi',{exact:true}).fill(config.ownerPassword);await page.getByRole('button',{name:'Ofisi aç',exact:true}).click();
 await page.locator('.director-screen').waitFor();await page.locator('.director-screen').click();const terminal=page.getByRole('dialog',{name:'Genel Müdür terminali',exact:true});await terminal.waitFor();
 await terminal.getByRole('alert').filter({hasText:'Tududi hesabı bekliyor'}).waitFor();await terminal.getByRole('button',{name:'Hesabı yeniden kur',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.gm-account'));assert.equal(c.runtime.director.agent().tududi_state,'ready');await page.getByText('Otomatik mod kapalı · Kendi verdiğim işlerin sonucunu bir kez raporlarım; yeni iş için sizden talimat beklerim.',{exact:true}).waitFor();
 const input=page.getByLabel('İşiniz veya komutunuz',{exact:true});await input.fill('Kayıp olmayan taslak');await page.getByLabel('Genel Müdür terminalini küçült',{exact:true}).click();assert.equal(await terminal.count(),0);await page.getByRole('button',{name:'Ajanlar',exact:true}).click();await page.locator('.gm-minimized').click();assert.equal(await input.inputValue(),'Kayıp olmayan taslak');
 await page.getByLabel('Genel Müdür terminalini kapat',{exact:true}).click();await page.reload();await page.locator('.gm-minimized').click();assert.equal(await input.inputValue(),'Kayıp olmayan taslak');
 await input.fill('/durum');await page.getByRole('button',{name:'Gönder',exact:true}).click();await page.locator('.gm-local').filter({hasText:'/durum'}).waitFor();assert.equal(c.runtime.runs().length,0,"Local commands create no model jobs.");
 await input.fill('Ekip kur');await page.getByRole('button',{name:'Gönder',exact:true}).click();await page.waitForFunction(()=>!(document.querySelector('#gm-input') as HTMLTextAreaElement)?.value);
 const first=c.runtime.claim('browser-runner')!;assert.ok(first);c.runtime.update(first.run.id,'text','Canlı ilk satır\n');await page.getByText('Canlı ilk satır',{exact:false}).first().waitFor();
 await input.fill('Sıradaki yönlendirme');await page.getByRole('button',{name:'Sıraya ekle',exact:true}).click();await page.waitForFunction(()=>!(document.querySelector('#gm-input') as HTMLTextAreaElement)?.value);
 assert.ok(c.runtime.runs().some(r=>r.state==='queued' && r.summary==='Sıradaki yönlendirme'));
 await page.getByLabel('Genel Müdür terminalini küçült',{exact:true}).click();c.runtime.update(first.run.id,'text','Küçükken gelen sonuç\n');c.runtime.finish(first.run.id,'completed','Canlı ilk satır\nKüçükken gelen sonuç','');assert.equal(c.runtime.run(first.run.id).state,'completed');
 await page.locator('.gm-minimized').filter({hasText:'Küçükken gelen sonuç'}).waitFor();await page.locator('.gm-minimized').click();await page.getByText('Küçükken gelen sonuç',{exact:false}).first().waitFor();
 const second=c.runtime.claim('browser-runner')!;assert.ok(second);await input.fill('Araya giren istek');await page.getByRole('button',{name:'Araya gir',exact:true}).click();await page.waitForFunction(()=>!(document.querySelector('#gm-input') as HTMLTextAreaElement)?.value);assert.equal(c.runtime.run(second.run.id).state,'stopped');
 const title=page.locator('.gm-titlebar'),box=(await terminal.boundingBox())!;await page.mouse.move(box.x+80,box.y+18);await page.mouse.down();await page.mouse.move(box.x+140,box.y+58);await page.mouse.up();const moved=(await terminal.boundingBox())!;assert.ok(moved.x>box.x+20 && moved.y>box.y+20,"The window can be dragged.");
 await page.mouse.move(moved.x+moved.width-3,moved.y+moved.height-3);await page.mouse.down();await page.mouse.move(moved.x+moved.width+40,moved.y+moved.height+30);await page.mouse.up();assert.ok((await terminal.boundingBox())!.width>moved.width+15,"The window can be resized.");
 await page.getByLabel('Terminali tam ekran yap',{exact:true}).click();assert.ok((await terminal.boundingBox())!.width>=1430);await page.getByLabel('Terminali pencereye döndür',{exact:true}).click();
 await page.getByLabel('Genel Müdür terminalini küçült',{exact:true}).click();await page.keyboard.press('Control+Shift+G');await terminal.waitFor();
 await page.setViewportSize({width:390,height:844});const mobile=(await terminal.boundingBox())!;assert.equal(Math.round(mobile.width),390);assert.equal(Math.round(mobile.height),844);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 await input.fill('Telefon taslağı');await page.getByLabel('Genel Müdür terminalini küçült',{exact:true}).click();await page.reload();await page.locator('.gm-minimized').click();assert.equal(await input.inputValue(),'Telefon taslağı');await page.getByText('Küçükken gelen sonuç',{exact:false}).first().waitFor();
 mkdirSync(resolve('.test-data/b23-browser'),{recursive:true});await page.screenshot({path:resolve('.test-data/b23-browser/terminal-telefon.png')});await page.setViewportSize({width:1440,height:900});await page.screenshot({path:resolve('.test-data/b23-browser/terminal-masaustu.png')});
 // B2.3: budget stop is visible once; only the owner's /devam opens a new turn.
 for(const r of c.runtime.runs().filter(r=>r.agent_id===c.runtime.director.agent().id && ['queued','running'].includes(r.state)))c.runtime.finish(r.id,'stopped','','Tarayıcı denemesi');
 c.store.db.prepare('UPDATE agents SET policy=? WHERE id=?').run(JSON.stringify({...c.runtime.director.agent().policy,inputTokenBudget:100}),c.runtime.director.agent().id);
 await input.fill('Dar kontrol işi');await page.getByRole('button',{name:'Gönder',exact:true}).click();await page.waitForFunction(()=>!(document.querySelector('#gm-input') as HTMLTextAreaElement)?.value);
 const budget=c.runtime.claim('browser-runner')!;assert.ok(budget);c.runtime.update(budget.run.id,'text','Kesilmeden önceki kısa cevap');c.runtime.update(budget.run.id,'usage','',{input_tokens:101});
 await terminal.getByText('Bu iş tur bütçesini aştı (101 token). Devam etmemi ister misin? — /devam',{exact:true}).waitFor();assert.equal(await terminal.locator('.gm-budget_stop').count(),1);
 const count=c.runtime.runs().length;await input.fill('/devam');await page.getByRole('button',{name:'Gönder',exact:true}).click();await page.waitForFunction(()=>!(document.querySelector('#gm-input') as HTMLTextAreaElement)?.value);assert.equal(c.runtime.runs().length,count+1);
 await page.getByLabel('Genel Müdür terminalini küçült',{exact:true}).click();await page.setViewportSize({width:1440,height:900});await page.getByRole('button',{name:'Kullanım ve kota',exact:true}).click();
 await page.getByLabel('Genel Müdür · sohbet düşünme düzeyi').selectOption('medium');await page.getByLabel('Genel Müdür · iş düşünme düzeyi').selectOption('low');
 await page.getByLabel('Genel Müdür · son isteğin bağlam sınırı',{exact:true}).fill('70000');await page.getByLabel('Genel Müdür · araç cevabının karakter sınırı',{exact:true}).fill('2500');await page.getByLabel('İş takibi · günlük ağırlıklı token',{exact:true}).fill('90000');await page.getByRole('button',{name:'Sınırları kaydet',exact:true}).click();
 await page.getByText('Çalışma sınırları kaydedildi.',{exact:true}).waitFor();assert.equal(c.runtime.director.settings().chatEffort,'medium');assert.equal(c.runtime.director.settings().workEffort,'low');assert.equal(c.runtime.director.settings().contextTokenLimit,70000);assert.equal(c.runtime.director.settings().responseCharLimit,2500);assert.equal(c.runtime.director.settings().followupTokenBudget,90000);
 await page.locator('.gm-minimized').click();c.runtime.director.entry('management_result',JSON.stringify({ozet:'İşlem listesi durdu',sonuc:{neden:'Ajanın kaynak belgesi eksik'}}));c.office.changed();await terminal.getByText('İşlem listesi durdu · Ajanın kaynak belgesi eksik',{exact:true}).waitFor();
 assert.deepEqual(errors,[],errors.join('\n'));writeFileSync(resolve('.test-data/b23-browser/sonuc.json'),JSON.stringify({passed:true,checks:['scene event','menu','draft','minimize','navigation','reload','local command','live stream','queue','interrupt','drag','resize','fullscreen','keyboard','phone','pending account and recovery','mode explanation','budget notice and /devam','Director limits and effort settings']},null,2));console.log("B2.3 focused terminal browser test passed.");
 c.office.bus.off('update',liveListener);await context.close();
}finally{await browser.close();await c.app.close();cleanup(config);}
