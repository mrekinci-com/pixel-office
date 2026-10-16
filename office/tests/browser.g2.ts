// Narrow bilingual check. Uses Fastify inject and browser request interception;
// no HTTP listener, service, container or live Tududi is started.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { testConfig, fakeTududi, cleanup, input } from './helpers.js';
import type { Page } from 'playwright';
const cache=resolve('.cache/runtime');mkdirSync(cache,{recursive:true});process.env.TMPDIR=cache;process.env.PLAYWRIGHT_BROWSERS_PATH=resolve('.cache/browsers');
const {chromium}=await import('playwright');
const browser=await chromium.launch({headless:true,args:['--no-sandbox'],downloadsPath:cache,env:{...process.env,LD_LIBRARY_PATH:[resolve('.cache/system-libs/usr/lib/x86_64-linux-gnu'),process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')}});
const client=resolve('dist/client');
const errors:string[]=[];
async function scan(page:Page,language:'en'|'tr',screen:string){
  const text=await page.locator('body').innerText();
  const other=language==='en'?/[çğıöşüÇĞİÖŞÜ]|\b(?:Ajanlar|Ajan|Bölüm|Görevler|Siz|Kapat|Kaydet|Sırada|Durdur|Bekliyor|Ofis bağlı)\b/:/\b(?:Departments|Approval inbox|Company rules|Working|Sign out|Runner disconnected|Save changes|No agents yet)\b/;
  assert.doesNotMatch(text,other,`${language} ${screen}: ${text}`);
  const attributes=await page.locator('[aria-label],[title],[placeholder]').evaluateAll(elements=>elements.filter(e=>e.getClientRects().length).map(e=>[e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('placeholder')].filter(Boolean).join(' ')).join('\n'));
  assert.doesNotMatch(attributes,other,`${language} ${screen} accessible labels: ${attributes}`);
}
try{
  for(const language of ['en','tr'] as const){
    const config={...testConfig(language==='en'?null:'tr'),publicOrigin:"http://office.test"},fake=fakeTududi(),s=await createApp(config,{fetcher:fake.fetcher,background:false});
    // New installs must open in English even with a Turkish browser. Existing
    // Turkish installs must keep Turkish even with an English browser.
    const context=await browser.newContext({viewport:{width:1440,height:900},locale:language==='en'?'tr-TR':'en-US',reducedMotion:'reduce'});
    try{
      await context.route('http://office.test/**',async route=>{
        const request=route.request(),url=new URL(request.url());
        if(url.pathname==='/api/live')return route.fulfill({status:200,contentType:'text/event-stream',body:'event: ready\ndata: {}\n\n'});
        if(url.pathname.startsWith('/api/')){
          const response=await s.app.inject({method:request.method() as 'GET'|'POST'|'PUT'|'DELETE'|'PATCH',url:url.pathname+url.search,headers:request.headers(),...(request.postData()?{payload:request.postData()!}:{})});
          return route.fulfill({status:response.statusCode,headers:Object.fromEntries(Object.entries(response.headers).filter(([key])=>!['content-length','transfer-encoding','connection'].includes(key)).map(([key,value])=>[key,Array.isArray(value)?value.join('\n'):String(value)])),body:response.body});
        }
        const file=url.pathname==='/'?resolve(client,'index.html'):resolve(client,'.'+url.pathname);
        if(!file.startsWith(client+sep)||!existsSync(file))return route.fulfill({status:404,body:''});
        const type:Record<string,string>={'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.woff2':'font/woff2','.svg':'image/svg+xml','.json':'application/json'};
        return route.fulfill({status:200,contentType:type[extname(file)]||'application/octet-stream',body:readFileSync(file)});
      });
      const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
      await page.routeWebSocket('ws://office.test/api/director/terminal/socket*',ws=>{ws.send(JSON.stringify({type:'status',terminal:{enabled:true,status:'idle',generation:1,usageKnown:false}}));});
      await page.goto('http://office.test/');
      await page.getByLabel(language==='en'?'Owner password':'Sahip şifresi',{exact:true}).fill(config.ownerPassword);
      assert.match(await page.title(),language==='en'?/^Pixel Office/:/^Piksel Ofis/);
      assert.equal(await page.locator('.login-header .brand').innerText(),language==='en'?'▦\nPixel Office':'▦\nPiksel Ofis');
      await scan(page,language,'login');
      await page.getByRole('button',{name:language==='en'?'Open office':'Ofisi aç',exact:true}).click();
      await page.locator('.office-viewport').waitFor();
      assert.equal(s.store.language(),language);
      const did=randomUUID();s.store.db.prepare('INSERT INTO departments(id,name,description,color,sort_order) VALUES (?,?,?,?,?)').run(did,'Team','','#498f87',1);
      const agent=await s.office.createAgent({...input(did),name:'Alex',title:'Researcher',prompt:'Keep user instructions.'});
      await s.office.tududi.task(s.office.token(agent.id),{name:'Prepare report'});
      // Reload also verifies the persisted office preference wins over browser language.
      await page.reload();await page.locator('.office-viewport').waitFor();
      await page.waitForFunction(()=>!document.body.innerText.includes('Loading office'));
      const screens=language==='en'?['Office','Agents','Departments','Tasks and notes','Approval inbox','Usage and limits']:['Ofis','Ajanlar','Bölümler','Görevler ve notlar','Onay kutusu','Kullanım ve kota'];
      for(const label of screens){
        await page.locator('.rail nav').first().getByRole('button',{name:label,exact:true}).click();await page.locator('main').waitFor();
        if(label===(language==='en'?'Tasks and notes':'Görevler ve notlar')){await page.locator('.tududi-toolbar select').selectOption(agent.id);await page.getByText('Prepare report',{exact:true}).waitFor();}
        await scan(page,language,label);
        if(label===(language==='en'?'Agents':'Ajanlar')){await page.getByRole('button',{name:language==='en'?'Add agent':'Ajan ekle',exact:true}).click();await page.getByRole('dialog').waitFor();await scan(page,language,'agent form');await page.getByRole('button',{name:language==='en'?'Close window':'Pencereyi kapat',exact:true}).click();}
        if(label===(language==='en'?'Departments':'Bölümler')){await page.getByRole('button',{name:language==='en'?'Create department':'Bölüm aç',exact:true}).click();await page.getByRole('dialog').waitFor();await scan(page,language,'department form');await page.getByRole('button',{name:language==='en'?'Close window':'Pencereyi kapat',exact:true}).click();}
      }
      await page.getByRole('button',{name:language==='en'?'Open Director terminal':'Genel Müdür terminalini aç',exact:true}).first().click();
      await page.getByRole('dialog',{name:language==='en'?'Director terminal':'Genel Müdür terminali'}).waitFor();
      await scan(page,language,'director');
      await page.getByRole('button',{name:language==='en'?'Close Director terminal':'Genel Müdür terminalini kapat',exact:true}).click();
      const otherLanguage=language==='en'?'tr':'en';
      await page.getByLabel(language==='en'?'Office language':'Ofis dili',{exact:true}).selectOption(otherLanguage);
      await page.getByRole('button',{name:language==='en'?'Save limits':'Sınırları kaydet',exact:true}).click();
      await page.waitForFunction(expected=>document.documentElement.lang===expected,otherLanguage);
      assert.equal(s.store.language(),otherLanguage);
      assert.equal(s.runtime.director.agent().name,otherLanguage==='en'?'Director':'Genel Müdür');
      assert.match(s.runtime.settings().approvalRules[0],otherLanguage==='en'?/^Request approval/:/^Şirket dışına/);
      await page.reload();await page.locator('.office-viewport').waitFor();assert.equal(await page.locator('html').getAttribute('lang'),otherLanguage);
      await page.locator('.rail-bottom .language-button').click();
      await page.getByRole('menuitemradio',{name:language==='en'?'İngilizce':'Turkish',exact:true}).click();
      await page.waitForFunction(expected=>document.documentElement.lang===expected,language);
      await page.reload();await page.locator('.office-viewport').waitFor();assert.equal(await page.locator('html').getAttribute('lang'),language);
      console.log(`G2 ${language}: login, six main screens, Director window, language change and reload passed.`);
    }finally{await context.close();await s.app.close();cleanup(config);}
  }
  assert.deepEqual(errors,[]);
}finally{await browser.close();}
