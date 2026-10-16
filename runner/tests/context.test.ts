import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync,symlinkSync,utimesSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {UsageObserver} from '../src/events.js';
import {codexContextInput} from '../src/context.js';

test("B2.1: single-request context differs from totals and can grow/shrink; completed usage counts once",()=>{
  const codex=new UsageObserver();
  const stream=codex.observe('codex',{type:'token_count',info:{last_token_usage:{input_tokens:22000},total_token_usage:{input_tokens:292683,cached_input_tokens:243072,output_tokens:1000}}})!;
  assert.equal(stream.context_input_tokens,22000);assert.equal(stream.input_tokens,292683);
  const done=codex.observe('codex',{type:'turn.completed',usage:{input_tokens:292683,cached_input_tokens:243072,output_tokens:1000}})!;
  assert.equal(done.input_tokens,292683);assert.equal(done.cached_input_tokens,243072);
  const smaller=codex.observe('codex',{type:'token_count',info:{last_token_usage:{input_tokens:14000}}})!;assert.equal(smaller.context_input_tokens,14000);
  const unknown=new UsageObserver().observe('codex',{type:'turn.completed',usage:{input_tokens:432220}})!;
  assert.equal(unknown.context_input_tokens,undefined); // An aggregate is never used as context size.
  const claude=new UsageObserver();
  claude.observe('claude',{type:'assistant',message:{id:'first',usage:{input_tokens:20,cache_read_input_tokens:70,cache_creation_input_tokens:10,output_tokens:5}}});
  const second=claude.observe('claude',{type:'assistant',message:{id:'second',usage:{input_tokens:10,cache_read_input_tokens:20,output_tokens:3}}})!;
  assert.equal(second.context_input_tokens,30);assert.equal(second.input_tokens,30);assert.equal(second.cache_read_input_tokens,90);
});

test("B2.1: Codex reads only its current conversation's last request and skips missing/corrupt/stale/linked files",()=>{
  mkdirSync(resolve('.test-data'),{recursive:true});const profile=mkdtempSync(resolve('.test-data/b21-context-')),id=randomUUID(),started=Date.now()-100;
  try{
    assert.equal(codexContextInput(profile,id,started),undefined);
    const sessions=join(profile,'codex','sessions','2026','10','13');mkdirSync(sessions,{recursive:true});
    const event=(input:number,at=started+50)=>JSON.stringify({timestamp:new Date(at).toISOString(),type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:432220},last_token_usage:{input_tokens:input}}}});
    const file=join(sessions,`rollout-${id}.jsonl`);
    writeFileSync(file,event(31000)+'\n'+event(28000)+'\n'+event(999).slice(0,-3));
    writeFileSync(join(sessions,'rollout-'+randomUUID()+'.jsonl'),event(999999)+'\n');
    assert.equal(codexContextInput(profile,id,started),28000);
    writeFileSync(file,event(999999,started-10000)+'\n'+JSON.stringify({timestamp:new Date().toISOString(),payload:{type:'task_started'}})+'\n');
    assert.equal(codexContextInput(profile,id,started),undefined); // Appending metadata cannot make an old request current.
    utimesSync(file,new Date(started-10000),new Date(started-10000));assert.equal(codexContextInput(profile,id,started),undefined);
    const target=join(profile,'outside.jsonl');writeFileSync(target,event(999999)+'\n');symlinkSync(target,join(sessions,`linked-${id}.jsonl`));
    assert.equal(codexContextInput(profile,id,started),undefined);
    assert.equal(codexContextInput(profile,'../../outside',started),undefined);
  }finally{rmSync(profile,{recursive:true,force:true});}
});
