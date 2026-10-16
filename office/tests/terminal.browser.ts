import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {build} from 'esbuild';
import type {WebSocket} from 'ws';
import {createApp} from '../server/app.js';
import {testConfig,fakeTududi,cleanup} from './helpers.js';
import {PROTOCOL_VERSION} from '../shared/runtime.js';
const provider=process.env.OFIS_TERMINAL_TEST_PROVIDER==='claude'?'claude':'codex';
const out=resolve(provider==='claude'?'.test-data/c1-browser':'.test-data/b24-browser'),cache=resolve('.cache/runtime');mkdirSync(out,{recursive:true});mkdirSync(cache,{recursive:true});process.env.TMPDIR=cache;process.env.PLAYWRIGHT_BROWSERS_PATH=resolve('.cache/browsers');
const {chromium}=await import('playwright');
const bundle=await build({entryPoints:['src/main.tsx'],bundle:true,write:false,outdir:out,format:'esm',external:['/assets/*'],jsx:'automatic',define:{'import.meta.env.OFIS_BUILD_ID':'"b24-browser"'},logLevel:'silent'});
const js=bundle.outputFiles.find(f=>f.path.endsWith('.js'))!.text,css=bundle.outputFiles.find(f=>f.path.endsWith('.css'))!.text;
const config={...testConfig(),publicOrigin:'http://ofis.test',runnerKey:'b24-sahte-tarayici-anahtari-'.repeat(3)},fake=fakeTududi(),c=await createApp(config,{fetcher:fake.fetcher,background:false,buildId:'b24-browser'});
const browser=await chromium.launch({headless:true,args:['--no-sandbox'],downloadsPath:cache,env:{...process.env,HOME:cache,XDG_CONFIG_HOME:cache,XDG_CACHE_HOME:cache,LD_LIBRARY_PATH:[resolve('.cache/system-libs/usr/lib/x86_64-linux-gnu'),process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')}});
const sockets:WebSocket[]=[],errors:string[]=[],commands:any[]=[];let ownerCookie='',runner:WebSocket,connections=0;
try{
 if(provider==='claude'){
  const gm=c.runtime.director.agent();c.store.db.prepare("UPDATE agents SET runner='claude',model='sonnet' WHERE id=?").run(gm.id);
  const state=c.runtime.director.state();state.provider_selected=true;c.runtime.director.save(state);
 }
 c.runtime.heartbeat('browser-runner',{codex:['gpt-6.1-sol'],claude:['sonnet']});await c.app.ready();
 runner=await c.app.injectWS(`/api/runner/terminal?runner=browser-runner&protocol=${PROTOCOL_VERSION}`,{headers:{authorization:`Bearer ${config.runnerKey}`}},{onInit:ws=>ws.on('message',d=>{const b=JSON.parse(d.toString());commands.push(b);if(b.type==='start'){setTimeout(()=>{ws.send(JSON.stringify({type:'status',status:'waiting'}));ws.send(JSON.stringify({type:'output',data:'\x1b[32mGerçek terminal için sahte PTY hazır.\x1b[0m\r\n'}));},10);}if(b.type==='input')ws.send(JSON.stringify({type:'output',data:b.data==='\r'?'\r\nTürkçe girdi alındı.\r\n':b.data}));})});sockets.push(runner);
 const context=await browser.newContext({locale:'tr-TR',viewport:{width:1440,height:900}});
 await context.addInitScript({content:`class TestSource extends EventTarget {static OPEN=1;readyState=1;constructor(){super();(window.b24Sources ||= []).push(this);setTimeout(()=>this.dispatchEvent(new MessageEvent('ready',{data:'{}'})),0);}close(){this.readyState=2;}}Object.defineProperty(window,'EventSource',{value:TestSource});`});
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!=='http://ofis.test')return route.abort();
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="tr"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/test.css"></head><body><div id="root"></div><script type="module" src="/test.js"></script></body></html>'});
  if(url.pathname==='/test.js')return route.fulfill({contentType:'application/javascript',body:js});if(url.pathname==='/test.css')return route.fulfill({contentType:'text/css',body:css});
  if(url.pathname.startsWith('/api/')){c.runtime.heartbeat('browser-runner',{codex:['gpt-6.1-sol'],claude:['sonnet']});const response=await c.app.inject({method:req.method() as any,url:url.pathname+url.search,headers:{...req.headers(),cookie:ownerCookie,'x-ofis-islem':'1'},payload:req.postDataJSON() || undefined});const sessionCookie=response.cookies.find(cookie=>cookie.name==='ofis_session');if(sessionCookie)ownerCookie=sessionCookie.name+'='+sessionCookie.value;return route.fulfill({status:response.statusCode,contentType:'application/json',body:response.body});}
  const file=resolve('public','.'+url.pathname);if(!file.startsWith(resolve('public')+'/'))return route.abort();try{return route.fulfill({body:readFileSync(file),contentType:extname(file)==='.png'?'image/png':extname(file)==='.woff2'?'font/woff2':'application/octet-stream'});}catch{return route.fulfill({status:404,body:''});}
 });
 await context.routeWebSocket('**/api/director/terminal/socket?*',async socket=>{
  connections++;const url=new URL(socket.url());let ws:WebSocket|undefined,closed=false;const pending:(string|Buffer)[]=[];
  socket.onMessage(data=>{if(ws?.readyState===1)ws.send(data);else pending.push(data);});socket.onClose(()=>{closed=true;ws?.close();});
  try{ws=await c.app.injectWS(url.pathname+url.search,{headers:{cookie:ownerCookie,origin:'http://ofis.test'}},{onInit:ws=>ws.on('message',data=>{if(!closed)socket.send(data.toString());})});sockets.push(ws);for(const data of pending)ws.send(data);}catch{socket.close({code:1008,reason:'Bağlantı doğrulanamadı.'});}
 });
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://ofis.test');await page.getByLabel('Sahip şifresi',{exact:true}).fill(config.ownerPassword);await page.getByRole('button',{name:'Ofisi aç',exact:true}).click();
 await page.getByRole('button',{name:'Genel Müdür terminalini aç',exact:true}).click();
 const terminal=page.getByRole('dialog',{name:'Genel Müdür terminali',exact:true});await terminal.waitFor();await page.locator('.xterm-screen').waitFor();
 await page.waitForFunction(()=>document.querySelector('.gm-xterm')?.textContent?.includes('sahte PTY hazır'));
 assert.equal(commands.find(v=>v.type==='start')?.lease.agent.runner,provider);
 if(provider==='claude')await terminal.getByText('Claude desteği deneysel — gerçek hesapla sınanmadı.',{exact:true}).waitFor();
 assert.equal(await page.getByRole('tab',{name:'Terminal',exact:true}).getAttribute('aria-selected'),'true');
 await page.locator('.xterm-helper-textarea').focus();await page.keyboard.insertText('Şirket için ığüşöç');await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('.gm-xterm')?.textContent?.includes('Türkçe girdi alındı'));
 assert.ok(commands.filter(v=>v.type==='input').map(v=>v.data).join('').includes('Şirket için ığüşöç'));
 await page.evaluate(()=>{const data=new DataTransfer();data.setData('text/plain','Yapıştırılan Türkçe metin');document.querySelector('.xterm')?.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});
 await page.waitForTimeout(100);assert.ok(commands.filter(v=>v.type==='input').map(v=>v.data).join('').includes('Yapıştırılan Türkçe metin'));
 const before=connections;await page.getByLabel('Genel Müdür terminalini küçült',{exact:true}).click();await page.locator('.gm-minimized').waitFor();runner.send(JSON.stringify({type:'status',status:'working'}));await page.locator('.gm-minimized').filter({hasText:'Çalışıyor'}).waitFor();await page.locator('.gm-minimized').click();assert.equal(connections,before,"Minimizing must not close the connection.");
 await page.getByRole('tab',{name:'Akış görünümü',exact:true}).click();await page.getByRole('button',{name:'Durum',exact:true}).click();await page.locator('.gm-local').filter({hasText:'/durum'}).waitFor();await page.getByRole('tab',{name:'Terminal',exact:true}).click();
 const box=(await terminal.boundingBox())!;await page.mouse.move(box.x+70,box.y+18);await page.mouse.down();await page.mouse.move(box.x+130,box.y+58);await page.mouse.up();const moved=(await terminal.boundingBox())!;assert.ok(moved.x>box.x+20 && moved.y>box.y+20);
 const resizeCount=commands.filter(v=>v.type==='resize').length;await page.mouse.move(moved.x+moved.width-3,moved.y+moved.height-3);await page.mouse.down();await page.mouse.move(moved.x+moved.width+50,moved.y+moved.height+30);await page.mouse.up();await page.waitForTimeout(200);assert.ok((await terminal.boundingBox())!.width>moved.width+15);assert.ok(commands.filter(v=>v.type==='resize').length>resizeCount);
 await page.getByLabel('Terminali tam ekran yap',{exact:true}).click();assert.ok((await terminal.boundingBox())!.width>=1430);await page.getByLabel('Terminali pencereye döndür',{exact:true}).click();
 const second=await context.newPage();second.setDefaultTimeout(10000);second.on('pageerror',e=>errors.push(e.message));await second.goto('http://ofis.test');await second.getByRole('button',{name:'Genel Müdür terminalini aç',exact:true}).click();await second.locator('.xterm-screen').waitFor();runner.send(JSON.stringify({type:'output',data:'\r\nİki sekmenin ortak cevabı.\r\n'}));for(const p of [page,second])await p.waitForFunction(()=>document.querySelector('.gm-xterm')?.textContent?.includes('İki sekmenin ortak cevabı'));
 await second.close();await page.reload();await page.locator('.xterm-screen').waitFor();await page.waitForFunction(()=>document.querySelector('.gm-xterm')?.textContent?.includes('İki sekmenin ortak cevabı'));
 const generation=c.runtime.terminal!.generation;await page.getByRole('button',{name:'Yeniden başlat',exact:true}).click();await page.waitForTimeout(100);assert.equal(c.runtime.terminal!.generation,generation);await page.getByRole('button',{name:'Yeni konuşma',exact:true}).click();await page.waitForTimeout(100);assert.equal(c.runtime.terminal!.generation,generation+1);
 await page.getByLabel('Genel Müdür terminalini küçült',{exact:true}).click();await page.getByRole('button',{name:'Kullanım ve kota',exact:true}).click();await page.locator('.gm-minimized').waitFor();await page.keyboard.press('Control+Shift+G');await terminal.waitFor();
 await page.screenshot({path:resolve(out,'terminal-masaustu.png')});await page.setViewportSize({width:390,height:844});const mobile=(await terminal.boundingBox())!;assert.equal(Math.round(mobile.width),390);assert.equal(Math.round(mobile.height),844);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);await page.screenshot({path:resolve(out,'terminal-telefon.png')});
 assert.deepEqual(errors,[]);writeFileSync(resolve(out,'sonuc.json'),JSON.stringify({ok:true,provider,connections,input:commands.filter(v=>v.type==='input').length,resize:commands.filter(v=>v.type==='resize').length,checks:['real xterm','Turkish input/paste','resize','two tabs','reconnect','minimize/reopen','stream tab','drag/fullscreen','phone','new conversation/restart','other page/shortcut'],errors},null,2));console.log(`${provider} focused terminal browser test passed.`);
}finally{for(const ws of sockets)ws.terminate();await browser.close();await c.app.close();cleanup(config);}
