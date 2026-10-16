import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import ts from 'typescript';
import {withLanguage,t} from '../src/i18n.js';
import {diagnose} from '../src/diagnostics.js';
import {endingLabel} from '../src/workspace.js';
import {tools,toolsForNames} from '../src/tools.js';
import {toolDescriptionsEn} from '../../office/shared/i18n/tool-descriptions.js';
import {catalogs} from '../../office/shared/i18n/index.js';
import {Worker} from '../src/worker.js';
import type {RunnerConfig} from '../src/config.js';

test("G2: concurrent runner languages stay isolated; diagnostics and finish reasons support both languages",async()=>{
  const result=await Promise.all([
    withLanguage('en',async()=>{await new Promise(r=>setImmediate(r));return [t('Çalışıyor'),diagnose('network access disabled'),endingLabel('Token budget exceeded.')];}),
    withLanguage('tr',async()=>{await new Promise(r=>setImmediate(r));return [t('Çalışıyor'),diagnose('ağ erişimi kapalı'),endingLabel('Token bütçesi aşıldı.')];}),
  ]);
  assert.equal(result[0][0],'Working');assert.equal(result[1][0],'Çalışıyor');
  assert.match(result[0][1],/^Network access/);assert.match(result[1][1],/^Ağ erişimi/);
  assert.equal(result[0][2],'stopped at token budget');assert.equal(result[1][2],'token bütçesinde kesildi');
  assert.equal(withLanguage('en',()=>endingLabel('Run time limit exceeded.')),'stopped at time limit');
  assert.equal(withLanguage('en',()=>endingLabel('The owner stopped the run.')),'stopped');
});
test("G2: tool descriptions are complete; names, fields and permission filters persist",()=>{
  assert.deepEqual(Object.keys(toolDescriptionsEn).sort(),tools.map(tool=>String(tool.name)).sort());
  const tr=withLanguage('tr',()=>toolsForNames(['gorev_devret']));
  const en=withLanguage('en',()=>toolsForNames(['gorev_devret']));
  assert.deepEqual(tr[0].inputSchema,en[0].inputSchema);assert.equal(en[0].name,tr[0].name);
  assert.match(String(en[0].description),/Director supplies/);assert.match(String(tr[0].description),/kaynaklar/);
  for(const description of Object.values(toolDescriptionsEn))assert.doesNotMatch(description.replace('yapılamadı',''),/[çğıöşüİ]/);
});
test("G2: runner learns language from heartbeat and localizes folder diagnostics",async()=>{
  const base=resolve('.test-data');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'g2-'));const folder=join(root,'allowed');mkdirSync(folder);
  const calls:{path:string;body:any}[]=[];
  const config:RunnerConfig={url:'http://127.0.0.1:9400',key:'fake-test-runner-key'.repeat(3),workDir:join(root,'work'),allowedRoots:[folder],protectedRoots:[],concurrency:1,claude:'claude',codex:'codex',bwrap:'bwrap',codexModel:'test'};
  const fetcher:typeof fetch=async(url,init)=>{const path=new URL(String(url)).pathname,body=JSON.parse(String(init?.body));calls.push({path,body});return Response.json(path.endsWith('/heartbeat')?{language:'en',stop:[],links:[{id:'test-link',path:folder}],approvals:[],paused:false}:path.endsWith('/claim')?null:{ok:true});};
  const worker=new Worker(config,fetcher,command=>command);
  try{await worker.tick();assert.equal(config.language,'en');assert.equal(calls.find(c=>c.path.endsWith('/links/validate'))!.body.detail,'Folder path and document names validated.');}
  finally{await worker.shutdown();rmSync(root,{recursive:true,force:true});}
});
test("G2: runner static translation keys are complete",()=>{
  for(const file of readdirSync('src').filter(f=>f.endsWith('.ts'))){const source=ts.createSourceFile(file,readFileSync(join('src',file),'utf8'),99,true);function visit(n:ts.Node){if(ts.isCallExpression(n)&&n.expression.getText(source)==='tx'){const k=n.arguments[0];if(k&&ts.isStringLiteral(k))assert.ok(Object.hasOwn(catalogs.en,k.text),`${file}: ${k.text}`);}ts.forEachChild(n,visit);}visit(source);}
});
