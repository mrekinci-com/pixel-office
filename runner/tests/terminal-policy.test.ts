import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {prepare} from '../src/command.js';
import {verifyTerminal,writeTerminalPolicy} from '../src/terminal-policy.js';
import {defaultPolicy,type Lease} from '../../office/shared/runtime.js';
import type {RunnerConfig} from '../src/config.js';

test("B2.4.1: terminal unlock requires a positive probe and verified permission denial",async t=>{
 const root=resolve('.test-data');mkdirSync(root,{recursive:true});
 const dir=mkdtempSync(join(root,'terminal-policy-unit-'));
 try{
  const planPath=join(dir,'plan.json'),callsPath=join(dir,'calls.jsonl'),codex=join(dir,'codex.cjs'),bwrap=join(dir,'bwrap.cjs');
  writeFileSync(codex,`#!${process.execPath}
const fs=require('node:fs');const plan=JSON.parse(fs.readFileSync(${JSON.stringify(planPath)},'utf8'));const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('codex-cli '+(plan.version || '0.159.1'));process.exit(0);}
const profile=args[args.indexOf('-P')+1],separator=args.indexOf('--');
fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({profile,managed:args.includes('--include-managed-config'),program:args[separator+1]})+'\\n');
if(args[0]!=='sandbox' || !args.includes('--include-managed-config'))process.exit(90);
const result=profile==='ofis'?plan.positive:plan.negative;
if(result.stderr)process.stderr.write(result.stderr);
if(result.signal)process.kill(process.pid,'SIGTERM');else process.exit(result.status);
`,{mode:0o700});
  writeFileSync(bwrap,`#!${process.execPath}
const cp=require('node:child_process'),args=process.argv.slice(2),at=args.indexOf('--');const r=cp.spawnSync(args[at+1],args.slice(at+2),{stdio:'inherit'});if(r.signal)process.kill(process.pid,r.signal);else process.exit(r.status??91);
`,{mode:0o700});
  const config:RunnerConfig={url:'http://127.0.0.1:9401',key:'yerel-b241-deneme'.repeat(3),workDir:join(dir,'work'),allowedRoots:[],protectedRoots:[],concurrency:1,claude:'claude',codex,bwrap,codexModel:'gpt-6.1-sol'};
  // Shell/network isolation is covered separately; this suite tests the gate.
  const lease={run:{id:randomUUID()},agent:{id:randomUUID(),builtin:'director',runner:'codex',model:'gpt-6.1-sol',effort:'low'},policy:{...defaultPolicy,permission:'chat'},links:[],key:'sahte-is-anahtari',prompt:'Yerel deneme',session:{generation:1,provider_id:null}} as unknown as Lease;
  const prepared=prepare(lease,config,true);writeTerminalPolicy(prepared.command,prepared.profile);
  const valid={positive:{status:0},negative:{status:73,stderr:'OFIS_TERMINAL_PROFILE_DENIED\n'}};
  await t.test('launches when Office /true passes and unrestricted permissions are rejected',()=>{
   writeFileSync(planPath,JSON.stringify(valid));assert.doesNotThrow(()=>verifyTerminal(prepared.command,config,lease,prepared.profile));
   assert.deepEqual(readFileSync(callsPath,'utf8').trim().split('\n').map(v=>JSON.parse(v)),[
    {profile:'ofis',managed:true,program:'/usr/bin/true'},
    {profile:':danger-full-access',managed:true,program:'/usr/bin/python3'},
   ]);
  });
  for(const [name,negative] of [
   ['unrestricted permissions allowed',{status:0}],
   ['success with fake denial text',{status:0,stderr:'OFIS_TERMINAL_PROFILE_DENIED\n'}],
   ['unrelated settings error',{status:1,stderr:'requirements not allowed\n'}],
   ['expected exit code without evidence',{status:73}],
   ['process terminated by signal',{signal:true,stderr:'OFIS_TERMINAL_PROFILE_DENIED\n'}],
  ] as const)await t.test(name+': terminal stays closed',()=>{
   writeFileSync(planPath,JSON.stringify({...valid,negative}));assert.throws(()=>verifyTerminal(prepared.command,config,lease,prepared.profile),/Terminal izin kilidi doğrulanamadı/);
  });
  await t.test('a failed positive probe cannot be overridden by a negative result',()=>{
   writeFileSync(callsPath,'');writeFileSync(planPath,JSON.stringify({...valid,positive:{status:1}}));
   assert.throws(()=>verifyTerminal(prepared.command,config,lease,prepared.profile),/güvenli izin profili doğrulanamadı/);
   assert.equal(readFileSync(callsPath,'utf8').trim().split('\n').length,1);
  });
  await t.test('old versions fail before probing',()=>{
   writeFileSync(callsPath,'');writeFileSync(planPath,JSON.stringify({...valid,version:'0.137.0'}));
   assert.throws(()=>verifyTerminal(prepared.command,config,lease,prepared.profile),/0.138/);assert.equal(readFileSync(callsPath,'utf8'),'');
  });
 }finally{rmSync(dir,{recursive:true,force:true});}
});
