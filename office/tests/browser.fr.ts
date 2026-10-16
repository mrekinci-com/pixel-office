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
const artifacts=resolve('.cache/fr');mkdirSync(artifacts,{recursive:true});
const errors:string[]=[];
async function scan(page:Page,language:'en'|'tr',screen:string){
  const text=await page.locator('body').innerText();
  const other=language==='en'?/[çğıöşüÇĞİÖŞÜ]|\b(?:Ajanlar|Ajan|Bölüm|Görevler|Siz|Kapat|Kaydet|Sırada|Durdur|Bekliyor|Ofis bağlı)\b/:/\b(?:Departments|Approval inbox|Company rules|Working|Sign out|Runner disconnected|Save changes|No agents yet)\b/;
  assert.doesNotMatch(text,other,`${language} ${screen}: ${text}`);
  const attributes=await page.locator('[aria-label],[title],[placeholder]').evaluateAll(elements=>elements.filter(e=>e.getClientRects().length).map(e=>[e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('placeholder')].filter(Boolean).join(' ')).join('\n'));
  assert.doesNotMatch(attributes,other,`${language} ${screen} accessible labels: ${attributes}`);
}
try{
  for(const language of ['tr','en'] as const)for(const theme of ['light','dark'] as const){
    const config={...testConfig(),publicOrigin:'http://office.test'},fake=fakeTududi(),s=await createApp(config,{fetcher:fake.fetcher,background:false});
    const context=await browser.newContext({viewport:{width:1440,height:900},locale:language==='tr'?'tr-TR':'en-US',reducedMotion:'reduce'});
    let deletions=0,fail=false;
    const remote=new Map<string,Record<string,any[]>>();
    const text=(tr:string,en:string)=>language==='tr'?tr:en;
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

      await context.addInitScript(theme=>{localStorage.setItem('po-tema',theme);},theme);
      const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
      await page.goto('http://office.test/');
      await page.getByLabel(text('Sahip şifresi','Owner password'),{exact:true}).fill(config.ownerPassword);
      await page.getByRole('button',{name:text('Ofisi aç','Open office'),exact:true}).click();await page.locator('.office-viewport').waitFor();
      const did=randomUUID();s.store.db.prepare('INSERT INTO departments(id,name,color) VALUES (?,?,?)').run(did,'Team','#498f87');
      const a=await s.office.createAgent({...input(did),name:'Alex',title:'Researcher'});
      const b=await s.office.createAgent({...input(did),name:'Blair',title:'Researcher'});
      await s.office.provision(s.runtime.director.agent().id);
      for(const agent of s.store.agents()){
        remote.set(agent.id,{Task:[{uid:agent.id+'-task',user_id:agent.tududi_user_id,status:2}],Note:[{uid:agent.id+'-note',user_id:agent.tududi_user_id,project_id:7}],Project:[{uid:agent.id+'-project',id:7,user_id:agent.tududi_user_id}]});
        s.store.db.prepare('INSERT INTO memories VALUES (?,?)').run(agent.id,'Private memory');
      }
      s.office.tududi.resetInventory=async(_token,user)=>structuredClone(remote.get(s.store.agents().find(a=>a.tududi_user_id===user)!.id)!);
      s.office.tududi.resetDelete=async(_token,kind,uid)=>{await new Promise(r=>setTimeout(r,220));if(fail)throw new Error('Simulated failure');deletions++;for(const rows of remote.values())rows[kind]=rows[kind].filter(v=>v.uid!==uid);};
      await page.reload();await page.locator('.office-viewport').waitFor();
      const agents=()=>page.locator('.rail nav').first().getByRole('button',{name:text('Ajanlar','Agents'),exact:true}).click();
      await agents();
      await page.getByRole('button',{name:text('Fabrika ayarlarına dön','Factory reset'),exact:true}).click();
      let dialog=page.getByRole('dialog',{name:text('Fabrika ayarlarına dön','Factory reset'),exact:true});await dialog.waitFor();
      assert.equal(await dialog.locator('.reset-agent').count(),3);await scan(page,language,'all-agent preview');
      const backupLink=dialog.getByRole('link',{name:text('Yedeği indir','Download backup'),exact:true});
      assert.equal(await backupLink.getAttribute('download'),'sifirlama-yedegi.json');
      const backup=await backupLink.evaluate(async(el)=>{
        const response=await fetch((el as HTMLAnchorElement).href);
        return {status:response.status,disposition:response.headers.get('content-disposition'),data:await response.json()};
      });
      assert.equal(backup.status,200);assert.match(backup.disposition!,/attachment/);assert.equal(backup.data.data.length,3);
      const colors=await dialog.locator('.reset-agent').first().evaluate(el=>({border:getComputedStyle(el).borderTopColor,text:getComputedStyle(el).color}));assert.notEqual(colors.border,'rgba(0, 0, 0, 0)');
      assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
      await page.screenshot({path:resolve(artifacts,`${language}-${theme}-preview.png`),fullPage:true});
      await dialog.getByRole('button',{name:text('Pencereyi kapat','Close window'),exact:true}).click();assert.equal(deletions,0);
      const row=page.locator('tr').filter({has:page.getByText('Alex',{exact:true})});await row.locator('button.icon-button').click();
      await page.getByRole('button',{name:text('Bu ajanı sıfırla','Reset this agent'),exact:true}).click();dialog=page.getByRole('dialog',{name:text('Fabrika ayarlarına dön','Factory reset'),exact:true});await dialog.waitFor();
      assert.equal(await dialog.locator('.reset-agent').count(),1);assert.equal(await dialog.locator('h3').innerText(),'Alex');
      const word=language==='tr'?'SIFIRLA':'RESET',confirmation=dialog.getByLabel(text('Onay için SIFIRLA yazın','Type RESET to confirm'),{exact:true}),confirm=dialog.getByRole('button',{name:text('Onayla ve sıfırla','Confirm and reset'),exact:true});
      await confirmation.fill(language==='tr'?'RESET':'SIFIRLA');assert.equal(await confirm.isDisabled(),true);await confirmation.fill(word);assert.equal(await confirm.isEnabled(),true);
      await page.setViewportSize({width:390,height:844});
      const dimensions=await dialog.evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));assert.ok(dimensions.scroll<=dimensions.width+1);await page.screenshot({path:resolve(artifacts,`${language}-${theme}-mobile.png`),fullPage:true});
      await page.setViewportSize({width:1440,height:900});fail=true;await confirm.click();await dialog.getByRole('progressbar').waitFor();
      await dialog.getByRole('button',{name:text('Yalnız kalanları tekrar dene','Retry remaining records only'),exact:true}).waitFor();
      assert.match(await dialog.locator('.reset-result').innerText(),new RegExp(text('Bazı kayıtlar kaldı','Some records remain')));
      await scan(page,language,'partial result');assert.equal(s.office.resetBlocked(),true);
      // A reload must reopen the durable partial operation in the same owner session.
      await page.reload();await page.locator('.office-viewport').waitFor();await agents();dialog=page.getByRole('dialog',{name:text('Fabrika ayarlarına dön','Factory reset'),exact:true});await dialog.waitFor();
      fail=false;await dialog.getByLabel(text('Onay için SIFIRLA yazın','Type RESET to confirm'),{exact:true}).fill(word);await dialog.getByRole('button',{name:text('Yalnız kalanları tekrar dene','Retry remaining records only'),exact:true}).click();
      await dialog.getByText(text('Sıfırlama tamamlandı','Reset completed'),{exact:true}).waitFor();await scan(page,language,'single-agent completion');
      assert.equal(remote.get(a.id)!.Task.length,0);assert.equal(remote.get(b.id)!.Task.length,1);assert.equal(s.office.resetBlocked(),false);
      await dialog.getByRole('button',{name:text('Pencereyi kapat','Close window'),exact:true}).click();
      await page.getByRole('button',{name:text('Fabrika ayarlarına dön','Factory reset'),exact:true}).click();dialog=page.getByRole('dialog',{name:text('Fabrika ayarlarına dön','Factory reset'),exact:true});await dialog.waitFor();
      await dialog.getByLabel(text('Onay için SIFIRLA yazın','Type RESET to confirm'),{exact:true}).fill(word);await dialog.getByRole('button',{name:text('Onayla ve sıfırla','Confirm and reset'),exact:true}).click();
      await dialog.getByRole('progressbar').waitFor();
      await page.reload();await page.locator('.office-viewport').waitFor();await agents();dialog=page.getByRole('dialog',{name:text('Fabrika ayarlarına dön','Factory reset'),exact:true});await dialog.waitFor();
      await dialog.getByText(text('Sıfırlama tamamlandı','Reset completed'),{exact:true}).waitFor();assert.equal(await dialog.locator('.reset-result').count(),3);assert.equal(deletions,9);
      await scan(page,language,'all-agent completion');await page.screenshot({path:resolve(artifacts,`${language}-${theme}-result.png`),fullPage:true});
      await dialog.getByRole('button',{name:text('Pencereyi kapat','Close window'),exact:true}).click();
      // The real GM tool creates the owner-only proposal, then the owner opens it in the UI.
      s.runtime.heartbeat('browser-runner');const gm=s.runtime.director.agent();s.runtime.enqueue(gm.id,'Manual','Propose reset');const lease=s.runtime.claim('browser-runner')!;
      const proposal:any=await s.runtime.tool(lease.run,'yonetim_islem',{islem:'fabrika_ayarlari_onizle',kimlik:a.id});assert.equal(proposal.sahibin_karari,true);
      await page.reload();await page.locator('.office-viewport').waitFor();await page.locator('.rail nav').first().getByRole('button',{name:text('Onay kutusu','Approval inbox'),exact:true}).click();
      await page.getByRole('button',{name:text('Önizlemeyi aç','Open preview'),exact:true}).click();dialog=page.getByRole('dialog',{name:text('Fabrika ayarlarına dön','Factory reset'),exact:true});await dialog.waitFor();
      assert.equal(deletions,9);assert.equal(await dialog.locator('.reset-agent').count(),1);assert.equal(await dialog.locator('input').inputValue(),'');
      await scan(page,language,'GM owner preview');
      console.log(`FR ${language}/${theme}: preview, cancel, backup, confirmation, mobile, progress, partial/reload/retry, single/all results and GM owner-only preview passed.`);
    }finally{await context.close();await s.app.close();cleanup(config);}
  }
  assert.deepEqual(errors,[]);
}finally{await browser.close();}
