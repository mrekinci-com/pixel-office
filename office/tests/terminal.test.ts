import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { defaultPolicy, defaultSettings } from '../shared/runtime.js';
import type { WebSocket } from 'ws';
import { createApp } from '../server/app.js';
import { testConfig,fakeTududi,cleanup,input } from './helpers.js';
import { PROTOCOL_VERSION } from '../shared/runtime.js';
import { TERMINAL_BUFFER_BYTES } from '../shared/terminal.js';
const tick=()=>new Promise(r=>setTimeout(r,20));
async function setup(){
  // Start at 06:00 UTC today: duration totals are per office day, so a clock near midnight would split them.
  let now=Date.parse(new Date().toISOString().slice(0,10)+"T06:00:00.000Z");
  const config={...testConfig(),publicOrigin:'http://ofis.test',runnerKey:'b24-sahte-calisitirici-anahtari-'.repeat(3)},fake=fakeTududi(),c=await createApp(config,{fetcher:fake.fetcher,background:false,scheduleClock:()=>now});
  const login=await c.app.inject({method:'POST',url:'/api/login',headers:{'x-ofis-islem':'1'},payload:{password:config.ownerPassword}});
  const headers={cookie:String(login.headers['set-cookie']).split(';')[0],'x-ofis-islem':'1',origin:config.publicOrigin};
  c.runtime.heartbeat('runner',{codex:['gpt-6.1-sol'],claude:['sonnet']});await c.app.ready();
  const api=(url:string,method:any='GET',payload?:any)=>c.app.inject({url,method,headers,payload});
  const sockets:WebSocket[]=[],messages=new Map<WebSocket,any[]>();
  const connect=async(url:string,h:Record<string,string>)=>{const ws=await c.app.injectWS(url,{headers:h},{onInit:ws=>{messages.set(ws,[]);ws.on('message',d=>messages.get(ws)!.push(JSON.parse(d.toString())));}});sockets.push(ws);await tick();return ws;};
  const runner=()=>connect(`/api/runner/terminal?runner=runner&protocol=${PROTOCOL_VERSION}`,{authorization:`Bearer ${config.runnerKey}`});
  const browser=async()=>{const res=await api('/api/director/terminal/ticket','POST',{});assert.equal(res.statusCode,200,res.body);return connect('/api/director/terminal/socket?ticket='+res.json().ticket,headers);};
  return {...c,config,fake,api,headers,connect,runner,browser,messages,advance:(ms:number)=>{now+=ms;c.runtime.heartbeat('runner',{codex:['gpt-6.1-sol'],claude:['sonnet']});},close:async()=>{for(const ws of sockets)ws.terminate();await c.app.close();cleanup(config);}};
}
test("B2.4: validate owner, cookie, Origin, single-use ticket and runner identity",async()=>{const c=await setup();try{
  assert.equal((await c.app.inject({method:'POST',url:'/api/director/terminal/ticket',payload:{}})).statusCode,403);
  assert.equal((await c.app.inject({method:'POST',url:'/api/director/terminal/ticket',headers:{'x-ofis-islem':'1'},payload:{}})).statusCode,401);
  assert.equal((await c.app.inject({method:'POST',url:'/api/director/terminal/ticket',headers:{...c.headers,origin:'http://yabanci.test'},payload:{}})).statusCode,403);
  const res=await c.api('/api/director/terminal/ticket','POST',{}),url='/api/director/terminal/socket?ticket='+res.json().ticket;
  await assert.rejects(()=>c.connect(url,{...c.headers,origin:'http://yabanci.test'}),/403/);await c.connect(url,c.headers);await assert.rejects(()=>c.connect(url,c.headers),/403/);
  const fresh=await c.api('/api/director/terminal/ticket','POST',{});await assert.rejects(()=>c.connect('/api/director/terminal/socket?ticket='+fresh.json().ticket,{origin:'http://ofis.test'}),/401/);
  await assert.rejects(()=>c.connect(`/api/runner/terminal?runner=runner&protocol=${PROTOCOL_VERSION}`,{}),/401/);
  await assert.rejects(()=>c.connect(`/api/runner/terminal?runner=other&protocol=${PROTOCOL_VERSION}`,{authorization:`Bearer ${c.config.runnerKey}`}),/409/);
  await assert.rejects(()=>c.connect('/api/runner/terminal?runner=runner&protocol=0',{authorization:`Bearer ${c.config.runnerKey}`}),/426/);
}finally{await c.close();}});
test("B2.4: two tabs, Turkish input, resize, reconnect and 200KB redaction buffer",async()=>{const c=await setup();try{
  const runner=await c.runner(),a=await c.browser(),b=await c.browser();await tick();const start=c.messages.get(runner)!.find(v=>v.type==='start');assert.equal(start.lease.agent.builtin,'director');assert.equal(start.lease.agent.runner,'codex');assert.ok(start.lease.toolNames.includes('yonetim_islem'));
  a.send(JSON.stringify({type:'input',data:'Şirketin işleri ığüşöç\r'}));b.send(JSON.stringify({type:'resize',cols:120,rows:40}));await tick();assert.ok(c.messages.get(runner)!.some(v=>v.type==='input' && v.data==='Şirketin işleri ığüşöç\r'));assert.ok(c.messages.get(runner)!.some(v=>v.type==='resize' && v.cols===120));
  runner.send(JSON.stringify({type:'output',data:'\x1b[32mMerhaba şirket\x1b[0m\r\n'+c.config.ownerPassword+'\r\n'}));await tick();for(const ws of [a,b]){const output=c.messages.get(ws)!.filter(v=>v.type==='output').map(v=>v.data).join('');assert.match(output,/\x1b\[32mMerhaba/);assert.ok(!output.includes(c.config.ownerPassword));assert.match(output,/gizlendi/);}
  a.close();await tick();runner.send(JSON.stringify({type:'output',data:'Sekme kapandı, konuşma sürüyor.\r\n'}));const re=await c.browser();assert.match(c.messages.get(re)!.find(v=>v.type==='reset').data,/konuşma sürüyor/);
  for(let i=0;i<6;i++)runner.send(JSON.stringify({type:'output',data:'ş'.repeat(30000)}));await tick();const last=await c.browser();const data=c.messages.get(last)!.find(v=>v.type==='reset').data;assert.ok(Buffer.byteLength(data)<=TERMINAL_BUFFER_BYTES);assert.ok(!data.includes('\ufffd'));
  assert.equal((await c.api('/api/director/input','POST',{text:'Akıştan ikinci model aç'})).statusCode,409);
}finally{await c.close();}});
test("B2.4: management tools retain owner/resource gates; ordinary agents have no terminal",async()=>{const c=await setup();try{
  const runner=await c.runner();await c.browser();const start=c.messages.get(runner)!.find(v=>v.type==='start'),key=start.lease.key;
  const catalog=await c.app.inject({url:'/api/agent-tools/catalog',headers:{authorization:`Bearer ${key}`}});assert.equal(catalog.statusCode,200,catalog.body);assert.ok(catalog.json().names.includes('yonetim_islem'));
  const a=await c.office.createAgent({...input(c.store.departments()[0].id),model:'gpt-6.1-sol'});const tool=(name:string,args:any)=>c.app.inject({url:'/api/agent-tools/'+name,method:'POST',headers:{authorization:`Bearer ${key}`},payload:{arguments:args}});
  assert.equal((await tool('yonetim_islem',{islem:'ajan_calistir',kimlik:a.id,veri:{text:'Yeni yazılım geliştir'}})).statusCode,400);
  const proposal=await tool('yonetim_islem',{islem:'ajan_sil',kimlik:a.id});assert.equal(proposal.statusCode,200,proposal.body);const p=proposal.json().result.onay;assert.ok(p);assert.ok(c.store.agent(a.id));assert.throws(()=>c.runtime.decide(p,true,'','director'),/sahibe/);
  assert.equal((await c.api(`/api/approvals/${p}/decision`,'POST',{approved:false})).statusCode,200);
  const made=await tool('yonetim_islem',{islem:'bolum_olustur',veri:{name:'Terminal ekibi',color:'#4488aa'}});assert.equal(made.statusCode,200,made.body);assert.ok(made.json().result.id);
  const gm=c.runtime.director.agent();assert.throws(()=>c.runtime.enqueue(gm.id,'Eski GM yolu','İkinci oturum'),/gerçek terminal/);assert.equal(c.runtime.claim('runner'),null,"Legacy Director work must not run while the terminal is enabled.");
  assert.equal((await c.api('/api/director/terminal/control','POST',{action:'new',agent:a.id})).statusCode,400);
}finally{await c.close();}});
test("B2.4: restart conversation, new identity/ledger and connection closure on logout",async()=>{const c=await setup();try{
  const runner=await c.runner(),browser=await c.browser();await c.runtime.director.ledger('Açık iş: kontrol et.');const first=c.messages.get(runner)!.find(v=>v.type==='start');
  assert.equal((await c.api('/api/director/terminal/control','POST',{action:'restart'})).statusCode,200);await tick();const restarted=c.messages.get(runner)!.filter(v=>v.type==='start').at(-1);assert.equal(restarted.generation,first.generation);assert.equal(restarted.restart,true);
  assert.equal((await c.api('/api/director/terminal/control','POST',{action:'new'})).statusCode,200);await tick();const fresh=c.messages.get(runner)!.filter(v=>v.type==='start').at(-1);assert.equal(fresh.generation,first.generation+1);assert.match(fresh.lease.prompt,/Açık iş: kontrol et/);assert.notEqual(fresh.lease.key,first.lease.key);
  assert.equal((await c.app.inject({url:'/api/agent-tools/catalog',headers:{authorization:`Bearer ${first.lease.key}`}})).statusCode,401);
  await c.api('/api/logout','POST',{});await tick();assert.notEqual(browser.readyState,1);
}finally{await c.close();}});
const event=(name:string)=>createHash('sha256').update(name).digest('hex');
test("B2.4: JSONL totals deduplicate; usage shows unknown and measured weighted tokens",async()=>{const c=await setup();try{
 const runner=await c.runner();await c.browser();const gm=c.runtime.director.agent(),session='12345678-1234-4234-9234-123456789abc';
 assert.equal((await c.api('/api/usage')).json().find((r:any)=>r.id===gm.id).terminal_usage,'unknown');assert.equal((await c.api('/api/director/auto','POST',{enabled:true})).statusCode,409);
 const usage={type:'usage',session,total:{input_tokens:100,cached_input_tokens:80,output_tokens:10},lastInput:100};runner.send(JSON.stringify(usage));runner.send(JSON.stringify(usage));await tick();assert.equal(c.runtime.totals(gm.id).input_tokens,100);assert.equal(c.runtime.totals(gm.id).weighted_tokens,38);assert.equal((await c.api('/api/usage')).json().find((r:any)=>r.id===gm.id).terminal_usage,'measured');
 runner.send(JSON.stringify({type:'turn',event:event('one-completed'),state:'completed',text:'Kısa rapor'}));await tick();const runs=c.runtime.runs().length;runner.send(JSON.stringify(usage));runner.send(JSON.stringify({type:'turn',event:event('one-completed'),state:'completed',text:'Kısa rapor'}));await tick();assert.equal(c.runtime.runs().length,runs);assert.equal(c.runtime.totals(gm.id).weighted_tokens,38);
 // A late cumulative increment belongs to the same completed turn.
 runner.send(JSON.stringify({...usage,total:{input_tokens:110,cached_input_tokens:85,output_tokens:12}}));await tick();assert.equal(c.runtime.runs().length,runs);assert.equal(c.runtime.totals(gm.id).input_tokens,110);assert.equal(c.runtime.totals(gm.id).weighted_tokens,45.5);
}finally{await c.close();}});
test("B2.4: automatic batches, 20-second idle gate, rejected injection and weighted cap",async()=>{const c=await setup();try{
 const runner=await c.runner(),browser=await c.browser(),gm=c.runtime.director.agent(),session='12345678-1234-4234-9234-123456789abc';
 await c.api('/api/runtime/settings','PUT',{...defaultSettings,language:'tr',director:{...defaultSettings.director!,batchSeconds:1,hourlyRuns:2,dailyTokenBudget:100}});
 runner.send(JSON.stringify({type:'usage',session,total:{input_tokens:100,cached_input_tokens:80,output_tokens:10}}));runner.send(JSON.stringify({type:'turn',event:event('init-complete'),state:'completed',text:'Selam'}));await tick();
 browser.send(JSON.stringify({type:'input',data:'Merhaba'}));browser.send(JSON.stringify({type:'input',data:'\r'}));await tick();runner.send(JSON.stringify({type:'turn',event:event('manual-complete'),state:'completed',text:'Hazırım'}));await tick();
 assert.equal((await c.api('/api/director/auto','POST',{enabled:true})).statusCode,200);c.runtime.director.signal('work_result','first','İlk sonuç');c.advance(1000);assert.equal(c.runtime.terminal!.flushAuto(),null,"Twenty seconds have not elapsed since the last keystroke.");
 c.advance(19000);const batch=c.runtime.terminal!.flushAuto()!;assert.ok(batch);await tick();assert.ok(c.messages.get(runner)!.some(v=>v.type==='inject' && v.id===batch.id && v.text.startsWith('[Otomatik takip]')));assert.equal(c.runtime.director.pending().length,0);
 runner.send(JSON.stringify({type:'injected',id:batch.id,accepted:false}));await tick();assert.equal(c.runtime.director.pending().length,1,"Unready terminals return the event batch.");runner.send(JSON.stringify({type:'status',status:'waiting',idleConfirmed:true}));await tick();c.advance(1000);
 const next=c.runtime.terminal!.flushAuto()!;assert.ok(next);runner.send(JSON.stringify({type:'injected',id:next.id,accepted:true}));runner.send(JSON.stringify({type:'turn',event:event('auto-started'),state:'started'}));await tick();assert.equal(c.runtime.run(next.id).director_auto,true);
 const start=c.messages.get(runner)!.find(v=>v.type==='start');await c.runtime.tool(c.runtime.authenticate(start.lease.key),'yonetim_defteri',{metin:'İlk sonuç doğrulandı; sıradaki sonuç bekleniyor.'});
 runner.send(JSON.stringify({type:'usage',session,total:{input_tokens:300,cached_input_tokens:200,output_tokens:30}}));await tick();assert.equal(c.runtime.director.autoUsage(),112);assert.equal(c.runtime.director.state().auto,false);assert.equal(c.runtime.run(next.id).state,'budget_exceeded');assert.equal(c.runtime.director.pending().length,1);assert.ok(c.messages.get(runner)!.some(v=>v.type==='stop'));
 const notices=c.messages.get(browser)!.filter(v=>v.type==='output' && /Otomatik modun günlük ağırlıklı token tavanı doldu/.test(v.data));assert.equal(notices.length,1);
}finally{await c.close();}});
test("B2.4: no injection without metadata or while busy; default batch waits 60 seconds",async()=>{const c=await setup();try{
 const runner=await c.runner();await c.browser();c.runtime.director.signal('work_result','work','Sonuç');assert.equal(c.runtime.terminal!.flushAuto(),null);
 const session='12345678-1234-4234-9234-123456789abc';runner.send(JSON.stringify({type:'usage',session,total:{input_tokens:1,cached_input_tokens:0,output_tokens:1}}));runner.send(JSON.stringify({type:'turn',event:event('batch60-initial'),state:'completed'}));await tick();await c.api('/api/director/auto','POST',{enabled:true});
 c.advance(59000);assert.equal(c.runtime.terminal!.flushAuto(),null);runner.send(JSON.stringify({type:'status',status:'working',idleConfirmed:false}));await tick();c.advance(1000);assert.equal(c.runtime.terminal!.flushAuto(),null);runner.send(JSON.stringify({type:'status',status:'waiting',idleConfirmed:true}));await tick();const batch=c.runtime.terminal!.flushAuto() || c.runtime.runs().find(r=>r.director_auto && r.state==='running');assert.ok(batch);assert.ok(c.messages.get(runner)!.some(v=>v.type==='inject'));
}finally{await c.close();}});
test("B2.4: idle reconnect/catalog reads create no work; terminal replies are not keystrokes",async()=>{const c=await setup();try{
 const runner=await c.runner(),browser=await c.browser(),start=c.messages.get(runner)!.find(v=>v.type==='start');runner.send(JSON.stringify({type:'turn',event:event('idle-complete'),state:'completed',text:'Bitti'}));await tick();const count=c.runtime.runs().length;
 browser.send(JSON.stringify({type:'input',data:'\x1b[1;1R\x1b[?1;2c\x1b]11;rgb:1010/1919/2323\x1b\\'}));await tick();assert.equal(c.runtime.runs().length,count);
 for(let i=0;i<2;i++){const result=await c.app.inject({url:'/api/agent-tools/catalog',headers:{authorization:`Bearer ${start.lease.key}`}});assert.equal(result.statusCode,200);assert.ok(result.json().names.includes('yonetim_islem'));}
 await c.browser();assert.equal(c.runtime.runs().length,count,"Idle reconnects must not become model jobs.");
}finally{await c.close();}});
test("B2.4: identity, usage and event batches survive restart; old terminal work never retries",async()=>{const c=await setup();let next:Awaited<ReturnType<typeof createApp>>|undefined;try{
 const runner=await c.runner();await c.browser();const start=c.messages.get(runner)!.find(v=>v.type==='start'),gm=c.runtime.director.agent(),session='12345678-1234-4234-9234-123456789abc';
 runner.send(JSON.stringify({type:'usage',session,total:{input_tokens:100,cached_input_tokens:80,output_tokens:10}}));await tick();await c.runtime.director.ledger('Yeniden açılışta defter korunur.');c.runtime.director.signal('work_result','saved','Saklanan sonuç');const generation=c.runtime.terminal!.generation;
 runner.terminate();await c.app.close();next=await createApp(c.config,{fetcher:c.fake.fetcher,background:false});next.runtime.heartbeat('new-runner',{codex:['gpt-6.1-sol'],claude:['sonnet']});await next.app.ready();
 assert.equal(next.runtime.terminal!.generation,generation);assert.equal(next.runtime.terminal!.enabled,true);assert.match(next.runtime.director.state().ledger,/defter korunur/);assert.equal(next.runtime.director.pending().length,1);assert.equal(next.runtime.runs().filter(r=>r.state==='queued' && r.agent_id===gm.id).length,0);
 const messages:any[]=[];const ws=await next.app.injectWS(`/api/runner/terminal?runner=new-runner&protocol=${PROTOCOL_VERSION}`,{headers:{authorization:`Bearer ${c.config.runnerKey}`}},{onInit:ws=>ws.on('message',d=>messages.push(JSON.parse(d.toString())))});await tick();const resumed=messages.find(v=>v.type==='start');assert.equal(resumed.generation,generation);assert.equal(resumed.lease.key,start.lease.key);
 const count=next.runtime.runs().length;ws.send(JSON.stringify({type:'usage',session,total:{input_tokens:100,cached_input_tokens:80,output_tokens:10}}));await tick();assert.equal(next.runtime.runs().length,count);assert.equal(next.runtime.totals(gm.id).weighted_tokens,38);assert.equal(next.runtime.totals(gm.id).budget_duration_ms,0, 'Persisted terminal sessions remain outside duration quotas after restart');ws.terminate();
}finally{if(next){await next.app.close();cleanup(c.config);}else await c.close();}});
test("B2.4: native tool calls count and stop reaches the PTY",async()=>{const c=await setup();try{
 const runner=await c.runner();await c.browser();const gm=c.runtime.director.agent();c.store.db.prepare('UPDATE agents SET policy=? WHERE id=?').run(JSON.stringify({...gm.policy,maxCalls:1}),gm.id);
 runner.send(JSON.stringify({type:'call',event:event('call1'),name:'shell'}));runner.send(JSON.stringify({type:'call',event:event('call1'),name:'shell'}));await tick();const run=c.runtime.runs()[0];assert.equal(run.calls,1);
 runner.send(JSON.stringify({type:'call',event:event('call2'),name:'apply_patch'}));await tick();assert.equal(c.runtime.run(run.id).state,'failed');assert.ok(c.messages.get(runner)!.some(v=>v.type==='stop'));
 c.runtime.stop();assert.equal(c.runtime.paused(),true);
}finally{await c.close();}});
test("B2.4: browser attachment cannot revive a budget-stopped TUI; the owner may restart",async()=>{const c=await setup();try{
 const runner=await c.runner();await c.browser();const first=c.messages.get(runner)!.find(v=>v.type==='start'),run=c.runtime.runs()[0];c.runtime.finish(run.id,'budget_exceeded','','Deneme bütçesi');const starts=c.messages.get(runner)!.filter(v=>v.type==='start').length;
 await c.browser();await tick();assert.equal(c.messages.get(runner)!.filter(v=>v.type==='start').length,starts);
 assert.equal((await c.api('/api/director/terminal/control','POST',{action:'restart'})).statusCode,200);await tick();assert.equal(c.messages.get(runner)!.filter(v=>v.type==='start').length,starts+1);assert.equal(c.messages.get(runner)!.filter(v=>v.type==='start').at(-1).generation,first.generation);
}finally{await c.close();}});
test("B2.4: provider secrets register through a private redaction bridge and never reach ledger/tool logs",async()=>{const c=await setup();try{
 const runner=await c.runner(),browser=await c.browser(),start=c.messages.get(runner)!.find(v=>v.type==='start'),secret='yalniz-b24-sahte-saglayici-degeri';runner.send(JSON.stringify({type:'secrets',values:[secret]}));await tick();
 await c.runtime.tool(c.runtime.authenticate(start.lease.key),'yonetim_defteri',{metin:'Saklanmayacak: '+secret});assert.ok(!c.runtime.director.state().ledger.includes(secret));assert.match(c.runtime.director.state().ledger,/gizlendi/);
 runner.send(JSON.stringify({type:'output',data:secret.slice(0,12)}));runner.send(JSON.stringify({type:'output',data:secret.slice(12)+'\r\n'}));await tick();const output=c.messages.get(browser)!.filter(v=>v.type==='output').map(v=>v.data).join('');assert.ok(!output.includes(secret));assert.match(output,/gizlendi/);
 assert.ok(!c.store.db.prepare('SELECT text FROM run_logs').all().map(r=>r.text).join('').includes(secret));assert.ok(!c.messages.get(browser)!.some(v=>v.type==='secrets'));
}finally{await c.close();}});
test("B2.4: persistent terminal model and startup effort follow the panel's Director settings",async()=>{const c=await setup();try{
 const runner=await c.runner();await c.api('/api/runtime/settings','PUT',{...defaultSettings,language:'tr',director:{...defaultSettings.director!,workEffort:'low'}});await c.browser();const initial=c.messages.get(runner)!.find(v=>v.type==='start');assert.equal(initial.lease.agent.model,c.runtime.director.agent().model);assert.equal(initial.lease.agent.effort,'low');assert.match(initial.lease.prompt,/^Merhaba\.\nDurum defteri:/);assert.match(initial.lease.terminalInstructions,/yonetim_\*/);
 await c.api('/api/runtime/settings','PUT',{...defaultSettings,language:'tr',director:{...defaultSettings.director!,workEffort:'high'}});await c.api('/api/director/terminal/control','POST',{action:'restart'});await tick();assert.equal(c.messages.get(runner)!.filter(v=>v.type==='start').at(-1).lease.agent.effort,'high');
}finally{await c.close();}});
test("B2.4.2: initial/new conversations use a short greeting/ledger without old automatic-event JSON",async()=>{const c=await setup();try{
 await c.runtime.director.ledger('Açık iş: teslimi kontrol et.');c.runtime.director.signal('work_result','eski-is','harcama kararı ve eski sonuç');
 const runner=await c.runner();await c.browser();const first=c.messages.get(runner)!.find(v=>v.type==='start');
 const check=(lease:any)=>{assert.equal(lease.prompt,'Merhaba.\nDurum defteri: Açık iş: teslimi kontrol et.');assert.ok(!lease.prompt.includes('work_result'));assert.ok(!lease.prompt.includes('harcama kararı'));assert.ok(!lease.prompt.includes('{'));assert.match(lease.terminalInstructions,/Şirket kuralları/);assert.match(lease.terminalInstructions,/Ajan talimatı/);assert.match(lease.terminalInstructions,/Sahibe ayrılmış onaylar/);};
 check(first.lease);assert.equal(c.runtime.director.pending().length,1,'Bekleyen olaylar silinmez.');await c.api('/api/director/terminal/control','POST',{action:'restart'});await tick();check(c.messages.get(runner)!.filter(v=>v.type==='start').at(-1).lease);
 await c.api('/api/director/terminal/control','POST',{action:'new'});await tick();check(c.messages.get(runner)!.filter(v=>v.type==='start').at(-1).lease);assert.equal(c.runtime.director.pending().length,1);
}finally{await c.close();}});
test("B2.4: multiline drafts pasted during work survive turn completion",async()=>{const c=await setup();try{
 const runner=await c.runner(),browser=await c.browser(),session='12345678-1234-4234-9234-123456789abc';browser.send(JSON.stringify({type:'input',data:'\x1b[200~Gönderilmemiş\nçok satırlı taslak\x1b[201~'}));runner.send(JSON.stringify({type:'usage',session,total:{input_tokens:1,cached_input_tokens:0,output_tokens:1}}));runner.send(JSON.stringify({type:'turn',event:event('paste-turn-complete'),state:'completed'}));await tick();await c.api('/api/director/auto','POST',{enabled:true});c.runtime.director.signal('work_result','draft-result','Sonuç');c.advance(61000);assert.equal(c.runtime.terminal!.flushAuto(),null);assert.equal(c.runtime.director.pending().length,1);
 browser.send(JSON.stringify({type:'input',data:'\r'}));await tick();runner.send(JSON.stringify({type:'turn',event:event('submitted-draft-complete'),state:'completed'}));await tick();c.advance(21000);const batch=c.runtime.terminal!.flushAuto() || c.runtime.runs().find(r=>r.director_auto && r.state==='running');assert.ok(batch);
}finally{await c.close();}});

test("C1: panel selects Claude Director with authorized management MCP, usage and persistent terminal bridge",async()=>{
 const c=await setup();try{
  const gm=c.runtime.director.agent();
  const updated=await c.api(`/api/agents/${gm.id}`,'PUT',{...input(gm.department_id),name:gm.name,username:gm.username,runner:'claude',model:'sonnet',session_mode:'persistent',watch_tasks:false,watch_due:false,policy:{permission:'workspace'}});
  assert.equal(updated.statusCode,200,updated.body);assert.equal(updated.json().runner,'claude');
  const runner=await c.runner();await c.browser();const start=c.messages.get(runner)!.find(v=>v.type==='start');assert.ok(start);
  assert.equal(start.lease.agent.runner,'claude');assert.equal(start.lease.policy.permission,'workspace');assert.ok(start.lease.toolNames.includes('yonetim_islem'));assert.ok(start.lease.terminalInstructions.includes('seçilen çalıştırıcıya'));
  const catalog=await c.app.inject({url:'/api/agent-tools/catalog',headers:{authorization:`Bearer ${start.lease.key}`}});assert.equal(catalog.statusCode,200);
  const usage={type:'usage',session:'12345678-1234-4234-9234-123456789abc',total:{input_tokens:60,cached_input_tokens:20,output_tokens:8}};
  runner.send(JSON.stringify(usage));runner.send(JSON.stringify(usage));runner.send(JSON.stringify({type:'turn',event:event('c1-finish'),state:'completed',text:'Hazırım.'}));await tick();
  assert.equal(c.runtime.totals(gm.id).input_tokens,60);assert.equal(c.runtime.totals(gm.id).output_tokens,8);assert.equal(c.runtime.terminal!.snapshot().runner,'claude');assert.equal(c.runtime.terminal!.snapshot().usageKnown,true);
  const generation=start.generation;assert.equal((await c.api('/api/director/terminal/control','POST',{action:'restart'})).statusCode,200);await tick();assert.equal(c.messages.get(runner)!.filter(v=>v.type==='start').at(-1).generation,generation);
 }finally{await c.close();}
});
test("C1: switching Director providers closes old identity/usage and requires a new generation/key",async()=>{
 const c=await setup();try{
  const runner=await c.runner();await c.browser();const first=c.messages.get(runner)!.find(v=>v.type==='start'),gm=c.runtime.director.agent();
  runner.send(JSON.stringify({type:'usage',session:'12345678-1234-4234-9234-123456789abc',total:{input_tokens:1,output_tokens:1}}));await tick();
  const changed=await c.api(`/api/agents/${gm.id}`,'PUT',{...input(gm.department_id),name:gm.name,username:gm.username,runner:'claude',model:'sonnet',session_mode:'persistent',watch_tasks:false,watch_due:false,policy:{permission:'workspace'}});assert.equal(changed.statusCode,200,changed.body);
  assert.equal(c.runtime.terminal!.generation,first.generation+1);assert.equal(c.runtime.terminal!.snapshot().usageKnown,false);assert.equal(c.runtime.director.state().auto,false);
  runner.send(JSON.stringify({type:'usage',generation:first.generation,session:'12345678-1234-4234-9234-123456789abc',total:{input_tokens:1000,output_tokens:1000}}));await tick();assert.equal(c.runtime.terminal!.snapshot().usageKnown,false);assert.equal(c.runtime.totals(gm.id).input_tokens,1);
  const old=await c.app.inject({url:'/api/agent-tools/catalog',headers:{authorization:`Bearer ${first.lease.key}`}});assert.equal(old.statusCode,401);
  const restarted=await c.api('/api/director/terminal/control','POST',{action:'restart'});assert.equal(restarted.statusCode,200,restarted.body);await tick();const next=c.messages.get(runner)!.filter(v=>v.type==='start').at(-1);
  assert.equal(next.lease.agent.runner,'claude');assert.notEqual(next.lease.key,first.lease.key);assert.equal(next.generation,first.generation+1);assert.ok(c.messages.get(runner)!.some(v=>v.type==='stop'));
 }finally{await c.close();}
});

for (const provider of ['codex', 'claude'] as const) {
  test(`E1: ${provider} Director terminals ignore duration caps while ordinary agents remain limited`, async (t) => {
    t.mock.timers.enable({apis:['setInterval']});
    const c = await setup();
    try {
      const gm = c.runtime.director.agent();
      c.store.db.prepare('UPDATE agents SET runner=?,model=?,policy=? WHERE id=?').run(
        provider, provider === 'codex' ? 'gpt-6.1-sol' : 'sonnet',
        JSON.stringify({...gm.policy, timeoutMinutes:1, dailyMinutes:1}), gm.id,
      );
      await c.api('/api/runtime/settings', 'PUT', {...defaultSettings, language:'tr', dailyMinutes:1});
      const runner = await c.runner();
      await c.browser();
      const start = c.messages.get(runner)!.find(v => v.type === 'start');
      assert.ok(start);
      const runId = start.lease.run.id;
      for (const status of ['waiting', 'working'] as const) {
        runner.send(JSON.stringify({type:'status', status, idleConfirmed:status === 'waiting'}));
        await tick();
        c.advance(3 * 60 * 60000);
        c.runtime.enforceTimeBudgets();
        t.mock.timers.tick(5000);
        await tick();
        assert.equal(c.runtime.run(runId).state, 'running', `${status}: wall time must not stop the terminal`);
        assert.ok(Number(c.store.db.prepare('SELECT lease_expires FROM runs WHERE id=?').get(runId)!.lease_expires) > c.runtime.clock());
      }
      assert.ok(c.runtime.totals(gm.id).duration_ms >= 6 * 60 * 60000);
      assert.equal(c.runtime.totals().budget_duration_ms, 0);
      assert.equal(c.runtime.queueBlock(gm.id), null);
      const agent = await c.office.createAgent({...input(gm.department_id), model:"gpt-6.1-sol", policy:{...defaultPolicy, timeoutMinutes:1, dailyMinutes:1}});
      await c.office.provision(agent.id);
      assert.equal(c.runtime.queueBlock(agent.id), null, 'Idle terminal time must not consume other agents\' duration quota');
      const task = c.runtime.enqueue(agent.id, 'Elle', 'Süre denemesi')!;
      assert.equal(c.runtime.claim('runner')!.run.id, task.id);
      c.advance(60001);
      c.runtime.enforceTimeBudgets();
      assert.equal(c.runtime.run(task.id).state, 'failed');
      assert.match(c.runtime.run(task.id).reason, /Günlük toplam süre sınırı/);
      assert.equal(c.runtime.run(runId).state, 'running');
      c.runtime.finish(runId, 'completed', '', '');
      assert.equal(c.runtime.totals().budget_duration_ms, 60001, 'Finished terminal sessions must also stay outside duration quotas');
      assert.equal((await c.api('/api/director/terminal/control', 'POST', {action:'restart'})).statusCode, 200);
      await tick();
      assert.ok(c.runtime.runs().some(r => r.agent_id === gm.id && r.state === 'running'));
    } finally {
      await c.close();
      t.mock.timers.reset();
    }
  });
}

for (const scope of ['run', 'chain', 'office'] as const) {
  test(`E1: duration-exempt Director terminal still enforces the ${scope} token cap`, async () => {
    const c = await setup();
    try {
      const gm = c.runtime.director.agent();
      c.store.db.prepare('UPDATE agents SET policy=? WHERE id=?').run(JSON.stringify({...gm.policy, dailyMinutes:1, timeoutMinutes:1, inputTokenBudget:scope === 'run' ? 10 : 100000}), gm.id);
      await c.api('/api/runtime/settings', 'PUT', {...defaultSettings, language:'tr', chainTokenBudget:scope === 'chain' ? 10 : 100000, dailyTokenBudget:scope === 'office' ? 10 : 100000});
      const runner = await c.runner();
      await c.browser();
      const start = c.messages.get(runner)!.find(v => v.type === 'start');
      c.advance(3 * 60 * 60000);
      c.runtime.enforceTimeBudgets();
      assert.equal(c.runtime.run(start.lease.run.id).state, 'running');
      runner.send(JSON.stringify({type:'usage', session:'12345678-1234-4234-9234-123456789abc', total:{input_tokens:11, output_tokens:0}}));
      await tick();
      assert.equal(c.runtime.run(start.lease.run.id).state, 'budget_exceeded');
      assert.ok(c.messages.get(runner)!.some(v => v.type === 'stop'));
    } finally { await c.close(); }
  });
}
