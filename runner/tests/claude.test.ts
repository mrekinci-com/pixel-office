import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,symlinkSync,linkSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { spawn,spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { prepare,isolate } from '../src/command.js';
import { verifyClaude,verifyClaudePolicy,claudeFileAllowed,type ClaudeFiles } from '../src/claude-policy.js';
import { claudeLoginCommand,hasAuth } from '../src/auth.js';
import { interactiveCommand } from '../src/terminal-loop.js';
import { claudeRollout } from '../src/claude-rollout.js';
import { RunnerTerminal,type TerminalDeps } from '../src/terminal.js';
import { terminalScreen } from '../src/terminal-screen.js';
import { UsageObserver,parseEvent } from '../src/events.js';
import { assertLaunchSize } from '../src/launch-size.js';
import type { RunnerConfig } from '../src/config.js';
import { defaultPolicy,type Lease } from '../../office/shared/runtime.js';
const root=resolve('.test-data');mkdirSync(root,{recursive:true});
function fixture(){
 const dir=mkdtempSync(join(root,'c1-')),auth=join(dir,'fake-auth.json');
 writeFileSync(auth,JSON.stringify({claudeAiOauth:{accessToken:'c1-fake-access-value',refreshToken:'c1-fake-refresh-value'},personalSetting:'must-not-copy'}),{mode:0o600});
 const config:RunnerConfig={url:'http://127.0.0.1:9401',key:'c1-fake-service-key',workDir:join(dir,'work'),allowedRoots:[join(dir,'allowed')],protectedRoots:[],concurrency:2,claude:resolve('tests/fixtures/claude.mjs'),codex:'codex',bwrap:'/usr/bin/true',codexModel:'test',claudeAuth:auth};
 mkdirSync(config.allowedRoots[0]);
 const lease={run:{id:randomUUID()},agent:{id:randomUUID(),builtin:'director',runner:'claude',model:'sonnet',effort:'high'},policy:{...defaultPolicy},links:[],key:'c1-fake-lease-key',prompt:'Merhaba.\nDurum defteri: Açık iş yok.',session:{generation:1,provider_id:null},terminalInstructions:'Sade Türkçe konuş. Sahibe ayrılmış onayları verme.'} as unknown as Lease;
 return {dir,config,lease,close:()=>rmSync(dir,{recursive:true,force:true})};
}
function hook(profile:string,tool:string,path:string,mode='dontAsk'){
 const policy=JSON.parse(readFileSync(join(profile,'claude-policy','managed-settings.json'),'utf8'));
 const command=policy.hooks.PreToolUse[0].hooks[0].command;
 return spawnSync('/bin/sh',['-c',command],{input:JSON.stringify({hook_event_name:'PreToolUse',tool_name:tool,tool_input:{file_path:path},permission_mode:mode}),encoding:'utf8',timeout:3000});
}
test("C1: headless Claude arguments, oversized UTF-8 stdin, tools/usage and resume",()=>{
 const f=fixture();try{
  f.lease.prompt='Şirketin Türkçe görev ve onay kuralları.\n'.repeat(18000);
  const p=prepare(f.lease,f.config);verifyClaude(p.command,f.config,f.lease,p.profile);
  assert.equal(p.command.env.CLAUDE_CONFIG_DIR,join(p.profile,'claude'));assert.equal(p.command.stdin,f.lease.prompt);
  assert.ok(!p.command.args.includes(f.lease.prompt));assert.ok(assertLaunchSize(p.command).largest.bytes<16000);
  assert.ok(!p.command.args.includes('--bare'));assert.ok(!p.command.args.includes('--dangerously-skip-permissions'));
  assert.ok(!readFileSync(join(p.profile,'claude','.credentials.json'),'utf8').includes('personalSetting'));
  const run=spawnSync(p.command.bin,p.command.args,{cwd:p.work,env:{...p.command.env,FAKE_EXPECT_HASH:createHash('sha256').update(f.lease.prompt).digest('hex')},input:p.command.stdin,encoding:'utf8',timeout:5000,maxBuffer:20000});
  assert.equal(run.status,0,run.stderr);const values=run.stdout.trim().split('\n').map(line=>JSON.parse(line));
  const parsed=values.flatMap(v=>parseEvent('claude',v));assert.ok(parsed.some(e=>e.kind==='tool'));assert.equal(parsed.at(-1)?.text,'Tamamlandı.');
  const observer=new UsageObserver();let usage;for(const value of values)usage=observer.observe('claude',value) || usage;
  assert.equal(usage!.input_tokens,40);assert.equal(usage!.cache_read_input_tokens,20);assert.equal(usage!.output_tokens,8);
  const id=values[0].session_id;f.lease.session!.provider_id=id;const resumed=prepare(f.lease,f.config);
  assert.equal(resumed.command.args[resumed.command.args.indexOf('--resume')+1],id);assert.equal(resumed.command.stdin,f.lease.prompt);
 }finally{f.close();}
});
test("C1/G3-02: real managed file guard rejects identity/MCP/settings paths and all link escapes",()=>{
 const f=fixture();try{
  const p=prepare(f.lease,f.config),files=JSON.parse(readFileSync(join(p.profile,'claude-files.json'),'utf8')) as ClaudeFiles;
  const ordinary=join(p.work,'rapor.txt');writeFileSync(ordinary,'İzinli içerik');
  assert.equal(hook(p.profile,'Read',ordinary).status,0);assert.equal(hook(p.profile,'Write',join(p.work,'yeni','rapor.txt')).status,0);
  const forbidden=['claude/.credentials.json','mcp.json','mcp-links.json','claude-files.json','claude-policy/managed-settings.json','claude-instructions.txt'].map(path=>join(p.profile,path));
  for(const path of forbidden)for(const tool of ['Read','Edit','Write']){
   const result=hook(p.profile,tool,path);assert.equal(result.status,2);assert.equal(result.stdout,'');assert.ok(!result.stderr.includes('c1-fake-access-value'));
  }
  for(const [name,target] of [['kimlik',forbidden[0]],['ayar',forbidden[1]],['profil',p.profile]])symlinkSync(target,join(p.work,name));
  linkSync(forbidden[0],join(p.work,'normal-ad.txt'));
  for(const path of [join(p.work,'kimlik'),join(p.work,'ayar'),join(p.work,'profil','mcp.json'),join(p.work,'normal-ad.txt'),join(p.work,'..','..','..','.oturum',f.lease.agent.id,'1','mcp.json')]){
   assert.equal(claudeFileAllowed(files,'Read',{file_path:path}),false);assert.equal(hook(p.profile,'Read',path).status,2);
  }
  for(const path of [join(p.work,'.env'),join(p.work,'.claude','settings.json'),join(p.work,'gelen','degistir.txt'),join(p.work,'dizin-haritasi','degistir.txt')])assert.equal(hook(p.profile,'Write',path).status,2);
  assert.equal(hook(p.profile,'Read',ordinary,'bypassPermissions').status,2);
  assert.equal(readFileSync(ordinary,'utf8'),'İzinli içerik');
  const denied=p.command.args[p.command.args.indexOf('--disallowedTools')+1];
  for(const path of [p.profile,'/proc','/etc'])assert.ok(denied.includes(`Read(/${path}/**)`),"CLI deny rules must also be supplied independently of the managed file.");
 }finally{f.close();}
});
test("C1: read-only/approval-protected folders, workspace and chat have separate boundaries",()=>{
 const f=fixture();try{
  const read=join(f.config.allowedRoots[0],'kaynak'),write=join(f.config.allowedRoots[0],'taslak'),approved=join(f.config.allowedRoots[0],'onayli');for(const path of [read,write,approved]){mkdirSync(path);writeFileSync(join(path,'veri.txt'),'sahte');}
  f.lease.policy.permission='folders';f.lease.links=[read,write,approved].map((path,i)=>({id:randomUUID(),name:'Klasör',path,access:i===0?'read':'write',approved_write:i===2,validation:'valid',agent_ids:[f.lease.agent.id],detail:''}));
  const p=prepare(f.lease,f.config);for(const path of [read,write,approved])assert.equal(hook(p.profile,'Read',join(path,'veri.txt')).status,0);
  assert.equal(hook(p.profile,'Write',join(read,'veri.txt')).status,2);assert.equal(hook(p.profile,'Write',join(approved,'veri.txt')).status,2);assert.equal(hook(p.profile,'Write',join(write,'veri.txt')).status,0);
  f.lease.policy.permission='workspace';const limited=prepare(f.lease,f.config);assert.equal(hook(limited.profile,'Read',join(read,'veri.txt')).status,2);
  f.lease.policy.permission='chat';const chat=prepare(f.lease,f.config);assert.equal(chat.command.args[chat.command.args.indexOf('--tools')+1],'');
  f.lease.policy.commands=true;assert.throws(()=>prepare(f.lease,f.config),/komut çalıştırma/);
 }finally{f.close();}
});
test("C1: positive/negative profile validation; invalid permissions or policies refuse launch",()=>{
 const f=fixture();try{
  const p=prepare(f.lease,f.config,true);assert.doesNotThrow(()=>verifyClaude(p.command,f.config,f.lease,p.profile));
  for(const mode of ['bypassPermissions','acceptEdits','auto']){
   const args=p.command.args.slice();args[args.indexOf('--permission-mode')+1]=mode;
   assert.throws(()=>verifyClaudePolicy({...p.command,args},p.profile),/izin kilidi/);
  }
  for(const flag of ['--dangerously-skip-permissions','--allow-dangerously-skip-permissions'])assert.throws(()=>verifyClaudePolicy({...p.command,args:[...p.command.args,flag]},p.profile),/izin kilidi/);
  const path=join(p.profile,'claude-policy','managed-settings.json'),policy=JSON.parse(readFileSync(path,'utf8'));policy.permissions.deny=[];writeFileSync(path,JSON.stringify(policy));
  assert.throws(()=>verifyClaudePolicy(p.command,p.profile),/izin kilidi/);
  writeFileSync(path,'{bozuk');assert.throws(()=>verifyClaudePolicy(p.command,p.profile));
 }finally{f.close();}
});
test("C1: all in-box aliases of managed policies/settings are read-only",()=>{
 const f=fixture();try{
  const p=prepare(f.lease,f.config,true),box=isolate(p.command,f.config,f.lease,p.profile);
  const policy=join(p.profile,'claude-policy');
  for(const [source,target] of [[policy,'/etc/claude-code'],[policy,policy],...['mcp.json','mcp-links.json','claude-files.json','claude-instructions.txt'].map(name=>[join(p.profile,name),join(p.profile,name)])]){
   assert.ok(box.args.some((v,i)=>v==='--ro-bind' && box.args[i+1]===source && box.args[i+2]===target));
  }
  assert.ok(box.args.includes('--unshare-pid'));assert.ok(!box.args.includes('/DATA'));assert.ok(!box.args.includes(join(f.config.workDir,'.auth')));
 }finally{f.close();}
});
test("C1: Director identity persists within a generation; resume omits the initial prompt; generations differ",()=>{
 const f=fixture();try{
  const one=prepare(f.lease,f.config,true),two=prepare(f.lease,f.config,true),id=one.command.args[one.command.args.indexOf('--session-id')+1];
  assert.equal(two.command.args[two.command.args.indexOf('--session-id')+1],id);assert.equal(one.command.stdin,undefined);
  assert.ok(one.command.args.includes('--append-system-prompt-file'));assert.equal(readFileSync(join(one.profile,'claude-instructions.txt'),'utf8'),f.lease.terminalInstructions);
  const fresh=interactiveCommand(one.command,undefined,'claude'),resumed=interactiveCommand(one.command,id,'claude');
  assert.equal(fresh.args.at(-1),f.lease.prompt);assert.ok(resumed.args.includes('--resume'));assert.ok(!resumed.args.includes('--session-id'));assert.ok(!resumed.args.includes(f.lease.prompt));
  f.lease.session!.generation=2;const next=prepare(f.lease,f.config,true);assert.notEqual(next.command.args[next.command.args.indexOf('--session-id')+1],id);
 }finally{f.close();}
});
test("C1: real supervisor launches fake Claude; restart resumes the same UUID",async()=>{
 const f=fixture();const children:ReturnType<typeof spawn>[]=[];try{
  const p=prepare(f.lease,f.config,true),record=join(f.dir,'launches.jsonl'),state=join(f.dir,'state.json'),alive=join(f.dir,'alive');writeFileSync(alive,'');
  const spec=join(f.dir,'spec.json');writeFileSync(spec,JSON.stringify({runner:'claude',profile:p.profile,statePath:state,alivePath:alive,command:{...p.command,bin:process.execPath,args:[resolve('tests/fixtures/claude-box.mjs'),'--',p.command.bin,...p.command.args],env:{...p.command.env,FAKE_CLAUDE_RECORD:record}}}));
  for(let i=0;i<2;i++){
   const child=spawn(process.execPath,[resolve('dist/runner/src/terminal-loop.js'),spec],{stdio:['ignore','ignore','pipe']});children.push(child);let stderr='';child.stderr!.on('data',c=>{stderr+=c;});
   const deadline=Date.now()+4000;while(Date.now()<deadline && (!existsSync(state) || !existsSync(record) || readFileSync(record,'utf8').trim().split('\n').length<i+1 || claudeRollout(p.profile)?.events.find(e=>e.type==='token_count')?.info.total_token_usage.input_tokens!==(i+1)*60))await new Promise(r=>setTimeout(r,20));
   assert.ok(existsSync(state),stderr);const exit=once(child,'exit');child.kill('SIGTERM');await exit;
  }
  const launches=readFileSync(record,'utf8').trim().split('\n').map(line=>JSON.parse(line));assert.equal(launches.length,2);assert.equal(launches[0].id,launches[1].id);assert.ok(launches[0].args.includes('--session-id'));assert.ok(launches[1].args.includes('--resume'));
  const data=claudeRollout(p.profile)!;assert.equal(data.id,launches[0].id);assert.ok(data.events.some(e=>e.type==='task_complete'));assert.equal(data.events.find(e=>e.type==='token_count').info.total_token_usage.input_tokens,120);
 }finally{for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');f.close();}
});
test("C1: Claude JSONL deduplicates messages and sums cache; incomplete/oversized/external records stay unknown",()=>{
 const f=fixture();try{
  const p=prepare(f.lease,f.config,true),id=p.command.args[p.command.args.indexOf('--session-id')+1],root=join(p.profile,'claude','projects','work');mkdirSync(root,{recursive:true});const path=join(root,id+'.jsonl'),timestamp=new Date().toISOString();
  const message={id:'same-message',content:[{type:'tool_use',name:'Read',id:'call-1',input:{file_path:'gizli-metni-saklama'}},{type:'tool_use',name:'mcp__ofis__yonetim_durum',id:'mcp-1'}],usage:{input_tokens:20,cache_read_input_tokens:30,cache_creation_input_tokens:10,output_tokens:5},stop_reason:'end_turn'};
  writeFileSync(path,[{type:'assistant',sessionId:id,timestamp,message},{type:'assistant',sessionId:id,timestamp,message},{type:'assistant',sessionId:randomUUID(),timestamp,message:{...message,id:'other'}}].map(v=>JSON.stringify(v)).join('\n'));
  const read=claudeRollout(p.profile)!;assert.equal(read.events.find(e=>e.type==='token_count').info.total_token_usage.input_tokens,60);assert.equal(read.events.find(e=>e.type==='token_count').info.total_token_usage.cached_input_tokens,30);assert.ok(!JSON.stringify(read.events).includes('gizli-metni-saklama'));assert.ok(!JSON.stringify(read.events).includes('mcp__ofis__'));
  writeFileSync(path,'x'.repeat(8*1024*1024+1));assert.equal(claudeRollout(p.profile)!.events.length,0);
  rmSync(path);symlinkSync(f.config.claudeAuth!,path);assert.equal(claudeRollout(p.profile),undefined);
 }finally{f.close();}
});
test("C1: fake Director PTY startup sends no theme/trust keys, preserves drafts and refuses missing login",()=>{
 const f=fixture();let now=Date.now(),pane='Choose the text style',attached=0;const commands:string[][]=[],reports:any[]=[];
 const deps:TerminalDeps={now:()=>now,report:v=>reports.push(v),capture:()=>pane,verify:verifyClaude,box:c=>({...c,bin:'/usr/bin/true',args:['--',c.bin,...c.args]}),tmux:args=>{commands.push(args);return args.includes('has-session')?1:0;},spawn:()=>{attached++;return {write:()=>{},resize:()=>{},kill:()=>{},onData:()=>{},onExit:()=>{}};}};
 const terminal=new RunnerTerminal(f.config,'c1',deps);try{
  terminal.start(f.lease,1);assert.equal(terminal.agentId,f.lease.agent.id);assert.ok(commands.some(c=>c.includes('new-session')));now+=2000;terminal.observe();assert.equal(attached,1);assert.ok(!commands.some(c=>c.includes('send-keys')));
  pane='Claude Code\n❯ Taslak';terminal.input({type:'input',data:'Taslak'});now+=21000;terminal.inject(randomUUID(),'Otomatik takip');assert.equal(reports.at(-1).accepted,false);
  pane='Sign in to Claude';terminal.observe();assert.equal(terminal.agentId,undefined);assert.match(reports.findLast(v=>v.type==='error').message,/Claude girişi yapılmamış/);
  assert.equal(terminalScreen('Claude Code\n❯ ','claude').empty,true);for(const frame of ['Claude Code\n❯ taslak','Claude Code\n❯ \nEsc to interrupt','Claude Code\nDo you trust this folder?\n❯ '])assert.equal(terminalScreen(frame,'claude').empty,false);
  rmSync(join(f.config.workDir,'.auth'),{recursive:true,force:true});f.config.claudeAuth=join(f.dir,'missing-auth');const count=commands.length;terminal.start(f.lease,1);assert.equal(commands.length,count);assert.match(reports.at(-1).message,/CLAUDE_CONFIG_DIR/);assert.match(reports.at(-1).message,/\.auth\/claude-login/);
 }finally{terminal.shutdown();f.close();}
});
test("C1: dedicated login avoids personal profiles and safely quotes spaces, quotes and shell syntax",()=>{
 const f=fixture();try{
  assert.equal(hasAuth(f.config.workDir,'claude',f.config.claudeAuth),true);
  const command=claudeLoginCommand(join(f.dir,"ayrı '$(dokunma) klasör"));assert.match(command,/HOME=/);assert.match(command,/CLAUDE_CONFIG_DIR=/);assert.ok(!command.includes('~/.claude'));assert.ok(command.includes("'\\''"));
  const syntax=spawnSync('/bin/bash',['-n'],{input:command,encoding:'utf8'});assert.equal(syntax.status,0,syntax.stderr);
 }finally{f.close();}
});

test("C1: Director credential refresh reaches the separate cache; new conversations use current credentials",()=>{
 const f=fixture();const reports:any[]=[];const deps:TerminalDeps={report:v=>reports.push(v),capture:()=>'',verify:verifyClaude,box:c=>({...c,bin:'/usr/bin/true',args:['--',c.bin,...c.args]}),tmux:args=>args.includes('has-session')?1:0,spawn:()=>({write:()=>{},resize:()=>{},kill:()=>{},onData:()=>{},onExit:()=>{}})};
 const terminal=new RunnerTerminal(f.config,'c1',deps);try{
  terminal.start(f.lease,1);const profile=join(f.config.workDir,'.terminal',f.lease.agent.id,'1');
  writeFileSync(join(profile,'claude','.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'c1-fake-refreshed-access',refreshToken:'c1-fake-refreshed-refresh'}}));
  terminal.observe();terminal.stop();f.lease.session!.generation=2;terminal.start(f.lease,2);
  const auth=JSON.parse(readFileSync(join(f.config.workDir,'.terminal',f.lease.agent.id,'2','claude','.credentials.json'),'utf8'));
  assert.equal(auth.claudeAiOauth.accessToken,'c1-fake-refreshed-access');assert.equal(JSON.parse(readFileSync(f.config.claudeAuth!,'utf8')).claudeAiOauth.accessToken,'c1-fake-access-value');
  assert.ok(reports.every(r=>r.generation===1 || r.generation===2));
 }finally{terminal.shutdown();f.close();}
});

test("C1: old CLI or missing help options cannot open a restricted session",()=>{
 const f=fixture();try{
  const p=prepare(f.lease,f.config,true),bin=join(f.dir,'unsupported-cli');
  writeFileSync(bin,'#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.284 (Claude Code)"; else echo "--restricted"; fi\n',{mode:0o700});
  assert.throws(()=>verifyClaude({...p.command,bin},f.config,f.lease,p.profile),/2.1.285/);
  writeFileSync(bin,'#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.285 (Claude Code)"; else echo "--model"; fi\n');
  assert.throws(()=>verifyClaude({...p.command,bin},f.config,f.lease,p.profile),/seçenekleri/);
 }finally{f.close();}
});

test("C1: failed new-terminal login gate also stops the previous tmux session immediately",()=>{
 const f=fixture();const commands:string[][]=[];const terminal=new RunnerTerminal(f.config,'c1',{report:()=>{},capture:()=>'',verify:verifyClaude,box:c=>({...c,bin:'/usr/bin/true',args:['--',c.bin,...c.args]}),tmux:args=>{commands.push(args);return args.includes('has-session')?1:0;},spawn:()=>({write:()=>{},resize:()=>{},kill:()=>{},onData:()=>{},onExit:()=>{}})});
 try{
  terminal.start(f.lease,1);assert.equal(terminal.agentId,f.lease.agent.id);
  f.lease.session!.generation=2;f.config.claudeAuth=join(f.dir,'missing-auth');terminal.start(f.lease,2);
  assert.equal(terminal.agentId,undefined);assert.ok(commands.some(c=>c.includes('kill-session') && c.includes(`gm-${f.lease.agent.id}-1`)));assert.equal(commands.filter(c=>c.includes('new-session')).length,1);
 }finally{terminal.shutdown();f.close();}
});
