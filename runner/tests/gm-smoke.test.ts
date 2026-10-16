import {test} from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Operator smoke script is plain JavaScript; the injected API is tested below.
import {runDirectorSmoke} from '../scripts/smoke-director.mjs';

function office(fail=false){
  const gm={id:'gm',builtin:'director',name:'Genel Müdür',runner:'codex',model:'secilen-model'};
  let snapshot:any={agents:[gm],departments:[{id:'gm-dept'}],handoffs:[],runtime:{settings:{emailDomain:'deneme.piksel-ofis.local',cachedInputWeight:.5,director:{dailyTokenBudget:123456,batchSeconds:60,hourlyRuns:12}},director:{auto:false,ledger:'Eski defter',status:'Sizi bekliyor'},runs:[],approvals:[],pendingDeletions:[]}};
  const initial=structuredClone(snapshot),calls:any[]=[],output:string[]=[];
  const api=async(path:string,method='GET',body?:any):Promise<any>=>{
    calls.push({path,method,body});
    if(path==='/snapshot')return structuredClone(snapshot);
    if(path==='/director')return {director:structuredClone(snapshot.runtime.director)};
    if(path==='/runtime/settings'){snapshot.runtime.settings=structuredClone(body);return {ok:true};}
    if(path==='/director/auto'){snapshot.runtime.director.auto=body.enabled;return {};}
    if(path==='/director/ledger'){snapshot.runtime.director.ledger=body.metin;return {};}
    if(path==='/director/input'){
      if(body.text.startsWith('/'))return {local:true};
      const simple=body.text==='merhaba'?'hello':body.text.startsWith('Ne durumdayız')?'status':body.text.startsWith('Deneme ürün isteği:')?'product':null;
      if(simple){snapshot.runtime.runs.push({id:simple,agent_id:'gm',trigger:'Sahip sohbeti',usage:{input_tokens:100,cached_input_tokens:20,output_tokens:10,context_input_tokens:100},state:'completed',reason:''});return {};}
      const tag=body.text.match(/GM Deneme [a-f0-9]{8}/)[0];
      if(body.text.startsWith('Otomatik mod kapalı kalsın.')){
       snapshot.agents.push({id:'light-agent',name:tag+' Takip'});
       snapshot.runtime.runs.push({id:'light-gm',agent_id:'gm',trigger:'İş verme',usage:{input_tokens:100,output_tokens:10},state:'completed',reason:''},{id:'light-job',agent_id:'light-agent',trigger:'GM işi',usage:{input_tokens:100,output_tokens:10},state:'completed',reason:''},{id:'light-followup',agent_id:'gm',director_followup:true,trigger:'Hafif takip',usage:{input_tokens:100,output_tokens:10},state:'completed',reason:''});return {};
      }
      snapshot.agents.push({id:'first',name:tag+' Deniz'},{id:'second',name:tag+' Ece'});snapshot.departments.push({id:'crew-dept'});
      const make=(id:string,agent_id:string,usage:any,director_auto=false,state='completed')=>({id,agent_id,trigger:director_auto?'Genel Müdür otomatik takip':'Deneme',usage,director_auto,state,reason:state==='budget_exceeded'?'Ağırlıklı tavan doldu':'',started_at:'2026-10-13T00:00:00Z'});
      snapshot.runtime.runs.push(make('gm-first','gm',{input_tokens:292683,cached_input_tokens:243072,output_tokens:1000}),make('first-job','first',{input_tokens:100,output_tokens:5}),make('second-job','second',{input_tokens:100,output_tokens:5}),make('second-next','second',{input_tokens:100,output_tokens:5}),make('gm-auto','gm',{input_tokens:100,cached_input_tokens:70,output_tokens:5},true,fail?'budget_exceeded':'waiting'));
      snapshot.runtime.director.ledger='Üç işin sonuçları doğrulandı; sahip kararı bekliyor.';
      if(fail){snapshot.runtime.director.auto=false;snapshot.runtime.director.status='Ağırlıklı tavan doldu.';snapshot.runtime.runs=snapshot.runtime.runs.filter((r:any)=>r.id!=='second-next');}
      else snapshot.runtime.approvals=[{id:'spending',agent_id:'gm',run_id:'gm-auto',title:tag+' harcama kararı',type:'spending',state:'pending'}];
      return {};
    }
    if(path.startsWith('/runs/'))return {logs:[{kind:'tool'},{kind:'tool'},{kind:'turn'}]};
    if(path.includes('/decision')){snapshot.runtime.approvals[0].state='rejected';return {};}
    if(method==='DELETE' && path.startsWith('/agents/')){const id=path.split('/')[2].split('?')[0];snapshot.agents=snapshot.agents.filter((a:any)=>a.id!==id);return {};}
    if(method==='DELETE' && path.startsWith('/departments/')){snapshot.departments=snapshot.departments.filter((d:any)=>d.id!==path.split('/')[2]);return {};}
    if(path.includes('/stop') || path==='/agents/gm')return {};
    throw new Error('Unexpected mock path: '+path);
  };
  return {api,calls,output,initial,report:(text:string)=>output.push(text),snapshot:()=>snapshot};
}

test("B2.1: smoke table reports total/cache/weighted usage and actual tool calls; direct work is accepted",async()=>{
  const mock=office();const result=await runDirectorSmoke({api:mock.api,report:mock.report});
  assert.equal(result.sonuc,'PASS');assert.equal(result.temizlik,'PASS');assert.equal(result.calismalar.length,11);
  assert.ok(result.rows.some((r:any)=>r.senaryo==='Simple chat (greeting)'));assert.ok(result.rows.some((r:any)=>r.senaryo==='Status question'));assert.ok(result.rows.some((r:any)=>r.senaryo==='Product request'));assert.ok(result.rows.some((r:any)=>r.senaryo==='Owned-work follow-up (automatic mode off)'));assert.equal(result.ilk_sohbet.son_istek_baglami,100);
  const first=result.calismalar.find((r:any)=>r.id==='gm-first');assert.equal(first.arac,2);assert.equal(first.toplam,293683);assert.equal(first.onbellekten,243072);assert.equal(first.agirlikli,74918.2);
  assert.ok(mock.output.some(s=>s.includes('Scenario | Runs | Tools | Total | Cached | Weighted')));
  const selected=mock.calls.find(c=>c.path==='/runtime/settings');assert.equal(selected.body.director.dailyTokenBudget,150000);assert.equal(selected.body.cachedInputWeight,.1);
  assert.deepEqual(mock.snapshot().runtime.settings,mock.initial.runtime.settings);assert.equal(mock.snapshot().runtime.director.ledger,'Eski defter');assert.equal(mock.snapshot().agents.length,1);
  assert.equal(mock.calls.filter(c=>c.method==='DELETE' && c.path.includes('account=delete&profile=delete')).length,3);
});

test("B2.1: reports preserve pending smoke steps and run states while cleanup still runs",async()=>{
  const mock=office(true);let error:any;
  try{await runDirectorSmoke({api:mock.api,report:mock.report});}catch(e){error=e;}
  assert.ok(error);assert.match(error.message,/Automatic mode stopped/);assert.match(error.report.asama,/Merge task/);
  assert.equal(error.report.sonuc,'FAIL');assert.equal(error.report.temizlik,'PASS');assert.ok(error.report.calismalar.some((r:any)=>r.durum==='budget_exceeded'));
  assert.ok(error.report.kullanim.length);assert.equal(mock.snapshot().agents.length,1);assert.deepEqual(mock.snapshot().runtime.settings,mock.initial.runtime.settings);
});
