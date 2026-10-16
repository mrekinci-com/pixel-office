// Real Codex and existing agent box; no model, account, service or network requests.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,existsSync,realpathSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {prepare,isolate,type Command} from '../src/command.js';
import {writeTerminalPolicy,verifyTerminal,terminalPermissionProbe} from '../src/terminal-policy.js';
import {defaultPolicy,type Lease} from '../../office/shared/runtime.js';
import type {RunnerConfig} from '../src/config.js';

function executable(name:string){
 const path=name.includes('/')?name:(process.env.PATH || '').split(':').map(p=>join(p,name)).find(existsSync);
 if(!path)throw new Error("Required local test command not found.");return realpathSync(path);
}
function localBwrap(codex:string){
 if(process.env.OFIS_BWRAP_BIN)return process.env.OFIS_BWRAP_BIN;
 let bundled=join(dirname(codex),'..','codex-resources','bwrap');
 if(codex.endsWith('/bin/codex.js')){
  const platform=dirname(createRequire(codex).resolve(`@openai/codex-linux-${process.arch==='x64'?'x64':'arm64'}/package.json`));
  bundled=join(platform,'vendor',`${process.arch==='x64'?'x86_64':'aarch64'}-unknown-linux-musl`,'codex-resources','bwrap');
 }
 return existsSync(bundled)?bundled:executable('bwrap');
}

test("B2.4.1: real Codex reads managed policy, rejects unrestricted permissions and passes Office /true",()=>{
 const root=resolve('.test-data');mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,'terminal-policy-live-'));
 try{
  const codex=executable(process.env.OFIS_CODEX_BIN || 'codex');
  const config:RunnerConfig={url:'http://127.0.0.1:9401',key:'yalniz-yerel-deneme'.repeat(3),workDir:join(dir,'work'),allowedRoots:[],protectedRoots:[],concurrency:1,claude:'claude',codex,bwrap:localBwrap(codex),codexModel:'gpt-6.1-sol'};
  const lease={run:{id:randomUUID()},agent:{id:randomUUID(),builtin:'director',runner:'codex',model:'gpt-6.1-sol',effort:'low'},policy:defaultPolicy,links:[],key:'sahte-is-anahtari',prompt:'Yerel deneme',session:{generation:1,provider_id:null}} as unknown as Lease;
  const p=prepare(lease,config,true);writeTerminalPolicy(p.command,p.profile);
  const policyPath=join(p.profile,'terminal-policy','requirements.toml'),policy=readFileSync(policyPath,'utf8');
  const run=(command:Command)=>{
   const boxed=isolate(command,config,lease,p.profile);
   return spawnSync(boxed.bin,boxed.args,{env:boxed.env,cwd:boxed.cwd,encoding:'utf8',timeout:10000,maxBuffer:16000});
  };
  const version=spawnSync(codex,['--version'],{env:p.command.env,encoding:'utf8',timeout:5000});assert.equal(version.status,0);console.log('Yerel Codex: '+version.stdout.trim());
  // Reproduce why the old true/status-only negative probe was misleading.
  for(const managed of [false,true]){
   const result=run({...p.command,args:['sandbox',...(managed?['--include-managed-config']:[]),'-P',':danger-full-access','-C',p.work,'--','/usr/bin/true']});
   assert.equal(result.status,0,result.stderr);console.log(`Unrestricted profile + /true, managed policy ${managed?'enabled':'disabled'}: 0`);
  }
  const positive=run(terminalPermissionProbe(p.command,p.profile,false));assert.equal(positive.status,0,positive.stderr);console.log('ofis + /true: 0');
  const negativeCommand=terminalPermissionProbe(p.command,p.profile,true);
  const unrestricted=run({...negativeCommand,args:negativeCommand.args.filter(v=>v!=='--include-managed-config')});
  assert.equal(unrestricted.status,0,unrestricted.stderr);assert.ok(!unrestricted.stderr.includes('OFIS_TERMINAL_PROFILE_DENIED'));console.log("Permission probe, managed policy disabled: 0 (does not unlock)");
  const negative=run(negativeCommand);assert.equal(negative.status,73,negative.stderr);assert.equal(negative.stderr.trim(),'OFIS_TERMINAL_PROFILE_DENIED');console.log("Permission probe, managed policy enabled: 73 with denial evidence");
  // Check the managed path and its writable-home alias using the outer box only.
  const readonly=run({...p.command,bin:'/usr/bin/python3',args:['-c',`import os,errno
for path in ${JSON.stringify(['/etc/codex/requirements.toml',policyPath])}:
 try:
  fd=os.open(path,os.O_WRONLY)
  os.close(fd)
  raise SystemExit(2)
 except OSError as e:
  if e.errno!=errno.EROFS: raise
print("POLITIKA_SALT_OKUNUR")`]});
  assert.equal(readonly.status,0,readonly.stderr);assert.equal(readonly.stdout.trim(),'POLITIKA_SALT_OKUNUR');console.log('/etc/codex and policy source: read-only');
  assert.doesNotThrow(()=>verifyTerminal(p.command,config,lease,p.profile));console.log("Full verifyTerminal passed, including network/credential probe");
  // A permissive file must fail the real gate, even though ofis /true still works.
  writeFileSync(policyPath,policy.replace('allowed_permission_profiles = {ofis=true}','allowed_permission_profiles = {ofis=true, ":danger-full-access"=true}'));
  const loosened=run(negativeCommand);assert.equal(loosened.status,0,loosened.stderr);
  assert.throws(()=>verifyTerminal(p.command,config,lease,p.profile),/Terminal izin kilidi doğrulanamadı/);console.log("Policy allowing the unrestricted profile: terminal launch refused");
  // Prove each forbidden ability independently, rather than only their union.
  for(const [name,loosePolicy] of [
   ['Network enabled',policy.replace('network={enabled=false}','network={enabled=true}')],
   ['Protected profile readable',policy.replace(`${JSON.stringify(p.profile)}="deny"`,`${JSON.stringify(p.profile)}="read"`)],
  ]){
   assert.notEqual(loosePolicy,policy);writeFileSync(policyPath,loosePolicy);
   const result=run(negativeCommand);assert.equal(result.status,0,result.stderr);
   assert.throws(()=>verifyTerminal(p.command,config,lease,p.profile));console.log(name+': terminal launch refused');
  }
  writeFileSync(policyPath,'geçersiz = [');
  assert.throws(()=>verifyTerminal(p.command,config,lease,p.profile));console.log("Malformed managed policy: terminal launch refused");
 }finally{rmSync(dir,{recursive:true,force:true});}
});
