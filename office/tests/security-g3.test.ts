import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import inject from 'light-my-request';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { canonicalRequestPath, hash } from '../server/security.js';
import { defaultSettings, PROTOCOL_VERSION } from '../shared/runtime.js';
import { testConfig, cleanup, fakeTududi, input } from './helpers.js';

async function setup(staticFiles = false) {
  const config = {...testConfig(), publicOrigin:'https://ofis.example.test', secureCookie:true, runnerKey:'g3-fake-runner-key-'.repeat(4)};
  const staticDir = join(config.dataDir, 'client');
  if (staticFiles) { mkdirSync(staticDir); writeFileSync(join(staticDir,'index.html'),'<p>Ofis</p>'); }
  const c = await createApp(config,{fetcher:fakeTududi().fetcher,background:false,...(staticFiles?{staticDir}:{})});
  const login = await c.app.inject({method:'POST',url:'/api/login',headers:{'x-ofis-islem':'1',origin:config.publicOrigin},payload:{password:config.ownerPassword}});
  assert.equal(login.statusCode,200);
  const headers = {cookie:String(login.headers['set-cookie']).split(';')[0],'x-ofis-islem':'1',origin:config.publicOrigin};
  const api = (url:string,method:'GET'|'POST'|'PUT'='GET',payload?:unknown) => c.app.inject({url,method,headers,...(payload===undefined?{}:{payload:payload as any})});
  return {...c,config,headers,api,close:async()=>{await c.app.close();cleanup(config);}};
}

test("G3: static paths and API authorization use the same normalized path",async()=>{
  const c=await setup(true);
  try {
    assert.equal((await c.app.inject({url:'/'})).statusCode,200);
    assert.equal((await c.app.inject({url:'/api/snapshot'})).statusCode,401);
    for(const path of ['/x/../api/snapshot','/x/%2e%2e/api/snapshot','/api%2fsnapshot','/api%5csnapshot','//api/snapshot','/./api/snapshot','/%00','/%zz']){
      assert.equal(canonicalRequestPath(path),null,path);
      // app.inject's URL parser normalizes dot segments before dispatch. Keep
      // the raw HTTP request target here without opening a listening socket.
      const response=await inject((req,res)=>{req.url=path;c.app.routing(req,res);},{url:'/'});
      assert.equal(response.statusCode,400,path);
      assert.ok(!response.body.includes('ownerPassword'));
    }
    assert.equal(canonicalRequestPath('/assets/dosya%20adi.txt?x=..'),'/assets/dosya adi.txt');
    for(const path of ['/%61pi/snapshot','/%61pi/events','/%61pi/factory-reset/current','/%61pi/live'])
      assert.equal((await c.app.inject({url:path})).statusCode,401,path);
    const noRunner=await c.app.inject({method:'POST',url:'/%61pi/%72unner/heartbeat',payload:{id:'attacker'}});
    assert.equal(noRunner.statusCode,401);
    const noAgent=await c.app.inject({method:'POST',url:'/%61pi/agent-tools/hafiza_oku',payload:{arguments:{}}});
    assert.equal(noAgent.statusCode,401);
    assert.equal((await c.api('/api/snapshot')).statusCode,200);
  } finally { await c.close(); }
});

test("G3: HTTPS forces secure cookies; forwarded IP headers cannot bypass login limits",async()=>{
  const config=testConfig();
  try {
    const loaded=loadConfig({OFIS_SECRET_KEY:config.secretKey,OFIS_OWNER_PASSWORD:config.ownerPassword,OFIS_PUBLIC_URL:'https://ofis.example.test',OFIS_COOKIE_SECURE:'false'});
    assert.equal(loaded.secureCookie,true);
  } finally { cleanup(config); }
  const c=await setup();
  try {
    for(let i=0;i<6;i++){
      const response=await c.app.inject({method:'POST',url:'/api/login',headers:{'x-ofis-islem':'1',origin:c.config.publicOrigin,'x-forwarded-for':`192.0.2.${i+1}`},payload:{password:'wrong'}});
      assert.equal(response.statusCode,i<4?401:429);
    }
    const badOrigin=await c.app.inject({method:'PUT',url:'/api/rules',headers:{...c.headers,origin:'https://hostile.test'},payload:{text:'değiştir'}});
    assert.equal(badOrigin.statusCode,403);
  } finally { await c.close(); }
});

test("G3: events, live notifications and messages mask secrets before storage",async()=>{
  const c=await setup();
  try {
    const secret='g3-only-fake-provider-secret'; c.runtime.registerSecrets([secret]);
    const updates:unknown[]=[]; c.office.bus.on('update',value=>updates.push(value));
    c.office.event(null,'g3',`${secret} ${c.config.ownerPassword}`);
    c.office.message(null,'everyone',null,secret);
    c.office.changed('agent',{current_job:secret});
    const longer=secret+'-extended';c.runtime.registerSecrets([longer]);
    assert.equal(c.runtime.scrub(longer),'[gizlendi]');
    assert.equal(JSON.parse(c.runtime.scrub('{"password":"unknown-fake-value"}')).password,'[gizlendi]');
    assert.equal(JSON.parse(c.runtime.scrub(JSON.stringify({password:'fake " quoted value'}))).password,'[gizlendi]');
    const metrics='{"tahmini_token":123,"input_tokens":4}';assert.equal(c.runtime.scrub(metrics),metrics);
    assert.ok(!JSON.stringify(updates).includes(secret));
    assert.ok(!JSON.stringify(c.store.events()).includes(c.config.ownerPassword));
    assert.ok(!JSON.stringify(c.store.messages()).includes(secret));
    assert.match((await c.api('/api/events')).body,/gizlendi/);
    assert.ok(!(await c.api('/api/snapshot')).body.includes(secret));
  } finally { await c.close(); }
});

test("G3: Director cannot grant itself command/folder capabilities; the owner decides",async()=>{
  const c=await setup();
  try {
    const gm=c.runtime.director.agent(),a=await c.office.createAgent(input(gm.department_id));
    const folder={id:randomUUID(),name:'Kaynak',path:'/g3/fake-folder',access:'read',approved_write:true,agent_ids:[a.id],validation:'valid',detail:''};
    c.store.db.prepare('INSERT INTO folder_links VALUES (?,?)').run(folder.id,JSON.stringify(folder));
    // Even disabling configurable owner approval categories must not open the
    // capability gate, or malicious notes could redefine an approved command.
    await c.api('/api/runtime/settings','PUT',{...defaultSettings,language:'tr',director:{...defaultSettings.director!,ownerApprovalTypes:[],destructiveApproval:false}});
    c.runtime.heartbeat('g3-runner',{codex:[gm.model,a.model],claude:[]});
    const lease=()=>{if(!c.runtime.runs().some(r=>r.agent_id===gm.id && r.state==='queued'))c.runtime.enqueue(gm.id,'Elle','Yetki denetimi');return c.runtime.claim('g3-runner')!;};
    let l=lease();
    const proposed:any=await c.runtime.tool(l.run,'yonetim_islem',{islem:'komut_olustur',veri:{name:'Kontrol',folder_id:folder.id,command:'sabit-kontrol',approval:false,agent_ids:[a.id]}});
    assert.ok(proposed.onay); assert.equal(c.runtime.a3.commands().length,0);
    assert.equal(c.runtime.director.ownerOnly(c.runtime.approvals()[0]),true);
    await assert.rejects(()=>c.runtime.director.decideAction(proposed.onay,true,'','director'),/sahibe/);
    assert.equal((await c.api(`/api/approvals/${proposed.onay}/decision`,'POST',{approved:true})).statusCode,200);
    assert.equal(c.runtime.a3.commands().length,1);
    l=lease();
    const command=c.runtime.a3.commands()[0],{id:commandId,...commandBody}=command;
    const edited:any=await c.runtime.tool(l.run,'yonetim_islem',{islem:'komut_duzenle',kimlik:commandId,veri:{...commandBody,command:'degistirilmis-komut'}});
    assert.ok(edited.onay); assert.equal(c.runtime.a3.commands()[0].command,'sabit-kontrol');
    assert.equal((await c.api(`/api/approvals/${edited.onay}/decision`,'POST',{approved:false})).statusCode,200);
    assert.equal(c.runtime.a3.commands()[0].command,'sabit-kontrol');
    l=lease();
    const assign:any=await c.runtime.tool(l.run,'yonetim_islem',{islem:'baglanti_ata',kimlik:folder.id,veri:{agent_ids:[a.id,gm.id]}});
    assert.ok(assign.onay); assert.deepEqual(c.runtime.links()[0].agent_ids,[a.id]);
    assert.equal(c.runtime.director.ownerOnly(c.runtime.approvals().find(a=>a.id===assign.onay)!),true);
  } finally { await c.close(); }
});

test("G3: browser-origin runner WebSockets and obsolete run keys are rejected",async()=>{
  const c=await setup();
  try {
    c.runtime.heartbeat('g3-runner');
    await assert.rejects(()=>c.app.injectWS(`/api/runner/terminal?runner=g3-runner&protocol=${PROTOCOL_VERSION}`,{headers:{authorization:`Bearer ${c.config.runnerKey}`,origin:c.config.publicOrigin}}),/403/);
    const gm=c.runtime.director.agent(),a=await c.office.createAgent(input(gm.department_id));
    c.runtime.enqueue(a.id,'Elle','İş anahtarı');
    const l=c.runtime.claim('g3-runner')!;
    assert.equal(c.runtime.authenticate(l.key).agent_id,a.id);
    c.store.db.prepare('UPDATE runs SET lease_expires=0 WHERE id=?').run(l.run.id);
    assert.throws(()=>c.runtime.authenticate(l.key),/süresi/);
    assert.notEqual(hash(l.key),c.config.runnerKey);
  } finally { await c.close(); }
});

test("G3: pending Director settings proposals cannot undo newer owner approval restrictions",async()=>{
  const c=await setup();
  try {
    const gm=c.runtime.director.agent();c.runtime.heartbeat('g3-runner');c.runtime.enqueue(gm.id,'Elle','Bütçe önerisi');
    const l=c.runtime.claim('g3-runner')!;
    const proposal:any=await c.runtime.tool(l.run,'yonetim_islem',{islem:'ayarlar_duzenle',veri:{dailyRuns:7}});
    assert.ok(proposal.onay);
    const stricter={...defaultSettings.director!,ownerApprovalTypes:[...defaultSettings.director!.ownerApprovalTypes,'folder_write','command']};
    assert.equal((await c.api('/api/runtime/settings','PUT',{...defaultSettings,language:'tr',director:stricter})).statusCode,200);
    assert.equal((await c.api(`/api/approvals/${proposal.onay}/decision`,'POST',{approved:true})).statusCode,200);
    assert.equal(c.runtime.settings().dailyRuns,7);
    assert.deepEqual(c.runtime.director.settings().ownerApprovalTypes,stricter.ownerApprovalTypes);
  } finally { await c.close(); }
});

test("G3/C1: Claude accepts file permissions; panel/Director cannot grant unverified shell capabilities",async()=>{
  const c=await setup();
  try {
    const body={...input(c.runtime.director.agent().department_id),runner:'claude',policy:{permission:'workspace'}};
    const response=await c.api('/api/agents','POST',body);
    assert.equal(response.statusCode,201);assert.equal(response.json().policy.permission,'workspace');
    const blocked=await c.api('/api/agents','POST',{...body,policy:{permission:'workspace',commands:true}});
    assert.equal(blocked.statusCode,400);assert.match(blocked.json().error,/komut çalıştırma/);
    c.runtime.heartbeat('g3-runner');c.runtime.enqueue(c.runtime.director.agent().id,'Elle','Claude yetkisi');
    const l=c.runtime.claim('g3-runner')!;
    await assert.rejects(()=>c.runtime.tool(l.run,'yonetim_islem',{islem:'ajan_olustur',veri:{...body,policy:{permission:'workspace',commands:true}}}),/komut çalıştırma/);
  } finally { await c.close(); }
});

test("G3: oversized owner-terminal WebSocket input closes the connection",async()=>{
  const c=await setup();let ws:Awaited<ReturnType<typeof c.app.injectWS>>|undefined;
  try {
    const ticket=(await c.api('/api/director/terminal/ticket','POST',{})).json().ticket;
    ws=await c.app.injectWS('/api/director/terminal/socket?ticket='+ticket,{headers:c.headers});
    const closed=once(ws,'close',{signal:AbortSignal.timeout(2000)});
    ws.send(JSON.stringify({type:'input',data:'x'.repeat(100001)}));
    assert.equal((await closed)[0],1009);
  } finally { ws?.terminate();await c.close(); }
});
