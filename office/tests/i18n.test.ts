import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { catalogs, languageFrom, translate } from '../shared/i18n/index.js';
import { messageInfo } from '../shared/i18n/messages.js';
import { createApp } from '../server/app.js';
import { testConfig, fakeTududi, cleanup, input } from './helpers.js';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/db.js';
import { directorPrompt } from '../shared/director.js';
function files(dir: string): string[] { return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):/\.tsx?$/.test(e.name)?[join(dir,e.name)]:[]); }
test("G2: dictionary keys match and all static keys are covered", () => {
  assert.deepEqual(Object.keys(catalogs.en).sort(),Object.keys(catalogs.tr).sort());
  for(const language of ['tr','en'] as const) for(const [key,value] of Object.entries(catalogs[language])) {
    assert.ok(value.trim(),`${language}: ${key}`);
    for(const match of value.matchAll(/\{\d+\}/g))assert.ok(key.includes(match[0]),`${language}: placeholder ${key}`);
  }
  for(const file of [...files('src'),...files('server')]) {
    const source=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
    function visit(n:ts.Node){
      if(ts.isCallExpression(n)&&(/^(t|tx)$/.test(n.expression.getText(source))||(ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='t'))){const k=n.arguments[0];if(k&&ts.isStringLiteral(k))assert.ok(Object.hasOwn(catalogs.en,k.text),`${file}: ${k.text}`);}
      ts.forEachChild(n,visit);
    }visit(source);
  }
});
test("G2: language detection, user values and stable error codes",()=>{
  assert.equal(languageFrom('tr-TR'),'tr');assert.equal(languageFrom('TR_tr'),'tr');assert.equal(languageFrom('de-DE'),'en');
  assert.equal(translate('en','{0} bölümü açıldı.',['İşler']),'Department İşler created.');
  const tr=messageInfo('tr','Şifre yanlış.'),en=messageInfo('en','Şifre yanlış.');assert.equal(tr.code,en.code);assert.equal(en.error,'Incorrect password.');
});
test("G2: legacy offices remain Turkish; rules and events persist",()=>{
  const config=testConfig();try{
    const s=new Store(config.dataDir);s.db.exec('DROP TABLE factory_resets; DROP TABLE reset_gate; ALTER TABLE runtime_settings DROP COLUMN language_initialized; DELETE FROM migrations WHERE version>=16;');s.db.prepare('UPDATE company_rules SET text=?').run('Özel talimat');s.event(null,'old','Eski Türkçe olay');s.close();
    const upgraded=new Store(config.dataDir);assert.equal(upgraded.language(),'tr');assert.equal(upgraded.languageInitialized(),true);assert.equal(upgraded.rules(),'Özel talimat');assert.equal(upgraded.events()[0].text,'Eski Türkçe olay');upgraded.close();
  }finally{cleanup(config);}
});
test("R1: new offices start in English with Turkish browsers; saved offices and user data persist",async()=>{
  const config=testConfig(null),otherConfig=testConfig();let first=await createApp(config,{fetcher:fakeTududi().fetcher,background:false});const other=await createApp(otherConfig,{fetcher:fakeTududi().fetcher,background:false});
  try{
    assert.equal((await first.app.inject({url:'/api/language',headers:{'accept-language':'tr-TR'}})).json().language,'en');
    const wrong=await first.app.inject({method:'POST',url:'/api/login',headers:{'x-ofis-islem':'1','accept-language':'tr-TR'},payload:{password:'wrong'}});
    assert.equal(wrong.statusCode,401);assert.equal(wrong.json().error,'Incorrect password.');
    const login=await first.app.inject({method:'POST',url:'/api/login',headers:{'x-ofis-islem':'1','accept-language':'tr-TR'},payload:{password:config.ownerPassword}});assert.equal(login.statusCode,200);
    const cookie=login.cookies[0].name+'='+login.cookies[0].value,headers={cookie,'x-ofis-islem':'1'};
    assert.equal(first.store.language(),'en');assert.equal(other.store.language(),'tr');assert.equal(first.store.agents().length,1);assert.equal(first.store.departments().length,1);
    assert.equal(first.store.agents()[0].name,'Director');assert.match(first.store.agents()[0].prompt,/plain English/);assert.equal(other.store.agents()[0].prompt,directorPrompt);
    assert.doesNotMatch(first.runtime.settings().approvalRules.join(' '),/[çğıöşüİ]/);
    const did=randomUUID();first.store.db.prepare('INSERT INTO departments(id,name,description,color,sort_order) VALUES (?,?,?,?,?)').run(did,'Özel bölüm','','#498f87',1);
    const agent=await first.office.createAgent({...input(did),name:'Çağrı',prompt:'Benim özel talimatım.'});await first.office.localizeProfile(agent.id);assert.equal((await first.office.tududi.profile(first.office.token(agent.id))).language,'en');
    const error=await first.app.inject({url:'/api/agents/'+randomUUID()+'/session',headers});assert.equal(error.statusCode,404);assert.equal(error.json().error,'Agent not found.');assert.match(error.json().code,/^OFIS_/);
    const history=first.store.events().map(e=>e.text);assert.equal((await first.app.inject({method:'PUT',url:'/api/language',headers,payload:{language:'tr'}})).statusCode,200);
    assert.equal(first.store.agent(agent.id)!.prompt,'Benim özel talimatım.');assert.equal(first.store.agent(agent.id)!.name,'Çağrı');assert.deepEqual(first.store.events().map(e=>e.text),history);
    assert.equal((await first.app.inject({url:'/api/snapshot',headers})).json().runtime.settings.language,'tr');
    assert.equal((await first.app.inject({method:'PUT',url:'/api/language',headers,payload:{language:'de'}})).statusCode,400);
    assert.equal((await first.app.inject({method:'PUT',url:'/api/language',headers:{'x-ofis-islem':'1'},payload:{language:'en'}})).statusCode,401);
    await first.app.close();first=await createApp(config,{fetcher:fakeTududi().fetcher,background:false});assert.equal(first.store.language(),'tr');assert.equal(first.store.languageInitialized(),true);
    await first.app.inject({method:'POST',url:'/api/login',headers:{'x-ofis-islem':'1','accept-language':'en-US'},payload:{password:config.ownerPassword}});
    assert.equal(first.store.language(),'tr');
  }finally{await first.app.close();await other.app.close();cleanup(config);cleanup(otherConfig);}
});

test("R1: selected English and pre-login office language survive restart",async()=>{
  for (const language of ['en','tr'] as const) {
    const config=testConfig(language);let app=await createApp(config,{fetcher:fakeTududi().fetcher,background:false});
    try {
      if (language === 'tr') app.store.db.prepare('UPDATE runtime_settings SET language_initialized=0').run();
      await app.app.close();app=await createApp(config,{fetcher:fakeTududi().fetcher,background:false});
      assert.equal((await app.app.inject({url:'/api/language',headers:{'accept-language':language==='en'?'tr-TR':'en-US'}})).json().language,language);
      await app.app.inject({method:'POST',url:'/api/login',headers:{'x-ofis-islem':'1','accept-language':language==='en'?'tr-TR':'en-US'},payload:{password:config.ownerPassword}});
      assert.equal(app.store.language(),language);
    } finally {await app.app.close();cleanup(config);}
  }
});

test("G2: English prompts preserve user instructions; automatic-mode brakes match in both languages",async()=>{
  const config=testConfig(),s=await createApp(config,{fetcher:fakeTududi().fetcher,background:false});
  try{
    s.office.setLanguage('en',true);
    const did=randomUUID();s.store.db.prepare('INSERT INTO departments(id,name,description,color,sort_order) VALUES (?,?,?,?,?)').run(did,'Team','','#498f87',1);
    const own='Özel talimatı aynen koru.';const agent=await s.office.createAgent({...input(did),name:'Alex',title:'Researcher',prompt:own});
    assert.ok(s.store.snapshot().rules==='');
    const heartbeat=s.runtime.heartbeat('g2-runner',{codex:['secilen-model'],claude:[]},2,'',{codex:true,claude:false});assert.equal(heartbeat.language,'en');
    assert.equal(s.runtime.enqueue(s.runtime.director.agent().id,'Director automatic follow-up','No automatic work'),null);
    const run=s.runtime.enqueue(agent.id,'Owner message for the greeter','Please review');assert.ok(run);
    const lease=s.runtime.claim('g2-runner');assert.ok(lease);assert.equal(lease.language,'en');assert.match(lease.prompt,/You are the greeter/);assert.ok(lease.prompt.includes(own));assert.doesNotMatch(lease.prompt.replace(own,''),/[çğıöşüÇĞİÖŞÜ]/);
  }finally{await s.app.close();cleanup(config);}
});
