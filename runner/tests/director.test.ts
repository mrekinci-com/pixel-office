import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,readdirSync,unlinkSync,renameSync,rmSync} from 'node:fs';
import {createApp} from '../../office/server/app.js';
import {testConfig,fakeTududi,cleanup} from '../../office/tests/helpers.js';
import {Worker} from '../src/worker.js';
import type {RunnerConfig} from '../src/config.js';
import {defaultSettings,usageTotals} from '../../office/shared/runtime.js';
import {toolsForNames} from '../src/tools.js';
import {callTool} from '../src/mcp.js';
test("B2: runner hides management from default schemas; server rejects spoofed roles",async()=>{
 assert.ok(!toolsForNames().some(t=>String(t.name).startsWith('yonetim_')));assert.equal(toolsForNames(['yonetim_durum']).length,1);assert.deepEqual(toolsForNames([]),[]);
 await assert.rejects(()=>callTool('yonetim_islem',{}, {OFIS_URL:'http://127.0.0.1:9400'}),/Araç bulunamadı/);
});
test("B2: fake CLI builds a team, assigns files, follows up automatically and waits for owner decisions",async()=>{
 mkdirSync(resolve('.test-data'),{recursive:true});const dir=mkdtempSync(resolve('.test-data/b2-cli-')),config={...testConfig(),runnerKey:'b2-fake-runner-key-'.repeat(3)},fake=fakeTududi();let now=Date.now();const c=await createApp(config,{fetcher:fake.fetcher,background:false,scheduleClock:()=>now});
 const bridge=join(dir,'bridge');mkdirSync(bridge);const runner:RunnerConfig={url:'http://127.0.0.1:9400',key:config.runnerKey,workDir:join(dir,'work'),allowedRoots:[],protectedRoots:[],concurrency:3,claude:'claude',codex:'codex',bwrap:'bwrap',codexModel:'gpt-6.1-sol',codexModels:['gpt-6.1-sol'],claudeModels:['sonnet'],smoke:true};
 const fetcher:typeof fetch=async(url,init)=>{const r=await c.app.inject({method:'POST',url:new URL(String(url)).pathname,headers:Object.fromEntries(new Headers(init?.headers).entries()),payload:JSON.parse(String(init?.body))});return new Response(r.body,{status:r.statusCode,headers:{'content-type':'application/json'}});};
 const launch:NonNullable<ConstructorParameters<typeof Worker>[2]>=(command,lease,profile)=>{const path=profile+'/mcp.json',cfg=JSON.parse(readFileSync(path,'utf8'));cfg.mcpServers.ofis.args=['--import',resolve('node_modules/tsx/dist/loader.mjs'),resolve('src/mcp.ts')];writeFileSync(path,JSON.stringify(cfg),{mode:0o600});return {...command,bin:process.execPath,args:[resolve('tests/fixtures/director-cli.mjs'),profile,lease.agent.builtin || 'worker',lease.run.summary],env:{...command.env,BRIDGE_DIR:bridge,NODE_OPTIONS:`--import=${resolve('tests/fixtures/bridge.mjs')}`}};};
 const worker=new Worker(runner,fetcher,launch);
 const pump=async()=>{for(const file of readdirSync(bridge).filter(f=>f.endsWith('.request'))){const path=join(bridge,file),request=JSON.parse(readFileSync(path,'utf8'));unlinkSync(path);const r=await c.app.inject({method:request.method || 'POST',url:new URL(request.url).pathname,headers:request.headers,payload:request.body});const response=path.replace('.request','.response');writeFileSync(response+'.tmp',JSON.stringify({status:r.statusCode,body:r.json()}),{mode:0o600});renameSync(response+'.tmp',response);}};
 let pumping=false;const timer=setInterval(()=>{if(pumping)return;pumping=true;void pump().finally(()=>{pumping=false;});},5);
 const until=async(check:()=>boolean)=>{const end=Date.now()+20000;while(!check()){if(Date.now()>end)throw new Error("Fake Director run did not reach the expected outcome: "+JSON.stringify(c.runtime.runs().map(r=>({trigger:r.trigger,state:r.state,reason:r.reason}))));now+=100;await worker.tick();await new Promise(r=>setTimeout(r,20));}};
 try{
  const settings={...defaultSettings,language:'tr',concurrency:3,director:{...defaultSettings.director!,batchSeconds:1}};c.store.db.prepare('UPDATE runtime_settings SET json=? WHERE id=1').run(JSON.stringify(settings));await worker.tick();c.runtime.director.setAuto(true);
  const login=await c.app.inject({method:'POST',url:'/api/login',headers:{'x-ofis-islem':'1'},payload:{password:config.ownerPassword}}),headers={cookie:String(login.headers['set-cookie']).split(';')[0],'x-ofis-islem':'1'};
  assert.equal((await c.app.inject({method:'POST',url:'/api/director/input',headers,payload:{text:'Bu iş için ekip kur ve iki aşamada tamamla.'}})).statusCode,200);
  await until(()=>c.runtime.approvals().some(a=>a.type==='spending' && a.state==='pending'));
  assert.equal(c.store.agents().filter(a=>a.builtin!=='director').length,2);assert.ok(c.store.departments().some(d=>d.name==='Deneme ekibi'));
  assert.equal(c.store.snapshot().handoffs.filter(h=>h.status==='completed').length,3);assert.ok(c.runtime.runs().some(r=>r.trigger==='Genel Müdür otomatik takip'));assert.ok(c.runtime.director.state().ledger.includes('Bekleyen soru'));
  const approval=c.runtime.approvals().find(a=>a.type==='spending')!;assert.equal(c.runtime.director.ownerOnly(approval),true);assert.throws(()=>c.runtime.decide(approval.id,true,'','director'),/sahibe/);
  const before=c.runtime.runs().length,usage=c.runtime.totals().total_tokens;for(const text of ['/durum','/ajanlar','/onaylar','/kullanim'])assert.equal((await c.app.inject({method:'POST',url:'/api/director/input',headers,payload:{text}})).statusCode,200);
  assert.equal(c.runtime.runs().length,before);assert.equal(c.runtime.totals().total_tokens,usage);assert.ok(c.store.messages().some(m=>m.text.includes('İki aşama tamamlandı')));
  await until(()=>worker.active.size===0);const usageRows=c.runtime.runs().map(r=>({senaryo:r.agent_id===c.runtime.director.agent().id ? r.director_auto?'Automatic follow-up and owner decision':'Team creation':'Agent work',durum:r.state,arac:Number(c.store.db.prepare("SELECT COUNT(*) AS n FROM run_logs WHERE run_id=? AND kind='tool'").get(r.id)!.n),toplam:usageTotals(r.usage).total_tokens,onbellekten:usageTotals(r.usage).cached_input_tokens,agirlikli:c.runtime.budgetInput(r.usage)}));console.log('B2.1 fake CLI usage rows: '+JSON.stringify(usageRows));
  assert.equal(fake.users.length,3);console.log("B2 fake CLI passed: team, two steps, automatic follow-up, ledger and owner approval.");
 }finally{await worker.shutdown();clearInterval(timer);while(pumping)await new Promise(r=>setTimeout(r,5));await c.app.close();cleanup(config);rmSync(dir,{recursive:true,force:true});}
});
