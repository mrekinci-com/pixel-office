import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync,readFileSync,statSync,symlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {RunnerTerminal,type TerminalDeps,type PtyHandle,tmuxLaunch,withoutPermissionDefinition} from '../src/terminal.js';
import {writeRestrictedProjectConfig} from '../src/terminal-config.js';
import {terminalScreen} from '../src/terminal-screen.js';
import {interactiveCommand} from '../src/terminal-loop.js';
import {TerminalRedactor} from '../src/terminal-redactor.js';
import {terminalRollout} from '../src/terminal-rollout.js';
import {prepare,isolate,verifyShell} from '../src/command.js';
import {defaultPolicy,type Lease} from '../../office/shared/runtime.js';
import type {RunnerConfig} from '../src/config.js';
const root=resolve('.test-data');mkdirSync(root,{recursive:true});
function fixture(){const dir=mkdtempSync(join(root,'terminal-'));const config:RunnerConfig={url:'http://127.0.0.1:9401',key:'b24-sahte-anahtar'.repeat(3),workDir:join(dir,'work'),allowedRoots:[],protectedRoots:[],concurrency:2,claude:'claude',codex:'/usr/bin/true',bwrap:'/usr/bin/true',codexModel:'gpt-6.1-sol'};
const lease={run:{id:randomUUID()},agent:{id:randomUUID(),builtin:'director',runner:'codex',model:'gpt-6.1-sol',effort:'low'},policy:defaultPolicy,links:[],key:'b24-sahte-is-anahtari',prompt:'Sade Türkçe konuş',session:{generation:1,provider_id:null}} as unknown as Lease;return {dir,config,lease};}
test("B2.4: interactive Codex/resume options, separate profile and shared isolation boundaries",()=>{const {dir,config,lease}=fixture();try{
 lease.terminalInstructions='Şirket kuralı: sade Türkçe konuş; onay sınırlarını koru.';
 const prepared=prepare(lease,config,true);assert.ok(readFileSync(join(prepared.command.env.CODEX_HOME!,'ofis-runtime.config.toml'),'utf8').includes(`developer_instructions=${JSON.stringify(lease.terminalInstructions)}`));assert.equal(prepared.command.stdin,undefined);assert.ok(prepared.profile.includes(join('.terminal',lease.agent.id,'1')));assert.equal(statSync(prepared.profile).mode&0o777,0o700);
 const fresh=interactiveCommand(prepared.command);for(const flag of ['exec','--json','--ephemeral','--ignore-user-config','--ignore-rules','--skip-git-repo-check'])assert.ok(!fresh.args.includes(flag));assert.ok(fresh.args.includes('--no-daemon'));assert.equal(fresh.args.at(-1),lease.prompt);assert.ok(fresh.args.includes('default_permissions="ofis"'));
 const id=randomUUID(),resume=interactiveCommand(prepared.command,id);assert.equal(resume.args[0],'resume');assert.equal(resume.args.at(-1),id);assert.ok(!resume.args.includes(lease.prompt));
 const wrapped=isolate(prepared.command,config,lease,prepared.profile);assert.ok(wrapped.args.includes('--die-with-parent'));assert.ok(wrapped.args.includes('--new-session'));assert.ok(wrapped.args.includes(prepared.profile));assert.ok(!wrapped.args.includes('/DATA'));assert.ok(!wrapped.args.includes(resolve('..')));assert.ok(!wrapped.args.includes(join(config.workDir,'.terminal-control')));assert.ok(!wrapped.args.includes(join(config.workDir,'ofis')));
 assert.throws(()=>verifyShell(prepared.command,config,lease,prepared.profile),/ağ yalıtımı/,"Production verification failure must also prevent terminal launch.");
 lease.agent.builtin=undefined;assert.throws(()=>prepare(lease,config,true),/yalnız Genel Müdür/);lease.agent.builtin='director';lease.agent.runner='claude';assert.ok(prepare(lease,config,true).command.args.includes('--session-id'));
}finally{rmSync(dir,{recursive:true,force:true});}});
test("B2.4: fake PTY input/resize/reconnect; tmux host commands are disabled",()=>{const {dir,config,lease}=fixture();const commands:string[][]=[],writes:string[]=[],sizes:number[][]=[];let now=Date.now(),killed=0,attached=0,data:(text:string)=>void=()=>{};
const deps:TerminalDeps={now:()=>now,report:()=>{},capture:()=> '› Ask Codex to do anything',verify:()=>{},box:(c)=>({...c,bin:'/usr/bin/true',args:['--',c.bin,...c.args]}),tmux:args=>{commands.push(args);return args.includes('has-session')?attached++===0?1:0:0;},spawn:()=>({write:t=>writes.push(t),resize:(c,r)=>sizes.push([c,r]),kill:()=>{killed++;},onData:fn=>{data=fn;},onExit:()=>{}} satisfies PtyHandle)};
const terminal=new RunnerTerminal(config,'test',deps);try{
 terminal.start(lease,1);assert.equal(terminal.agentId,lease.agent.id);assert.ok(commands.some(c=>c.includes('new-session')));assert.ok(commands.some(c=>c.includes('prefix') && c.includes('None')));assert.ok(commands.some(c=>c.includes('unbind-key') && c.includes('root')));
 const sessions=join(config.workDir,'.terminal',lease.agent.id,'1','codex','sessions');mkdirSync(sessions,{recursive:true});const provider=randomUUID();writeFileSync(join(sessions,`rollout-${provider}.jsonl`),JSON.stringify({type:'session_meta',payload:{id:provider}})+'\n'+JSON.stringify({type:'event_msg',timestamp:new Date(now).toISOString(),payload:{type:'task_complete'}}));
 now+=2000;terminal.observe();
 terminal.input({type:'input',data:'Şirket ığüşöç\r'});terminal.input({type:'resize',cols:120,rows:40});assert.deepEqual(writes,['Şirket ığüşöç\r']);assert.deepEqual(sizes,[[120,40]]);assert.throws(()=>terminal.input({type:'resize',cols:2,rows:3}));assert.throws(()=>terminal.input({type:'input',data:'x'.repeat(17000)}));
 data('\x1b[32mCanlı sonuç\x1b[0m');terminal.start(lease,1);assert.equal(killed,0);assert.equal(commands.filter(c=>c.includes('new-session')).length,1,"Attaching reuses the existing tmux session.");assert.ok(!commands.some(c=>c.includes('kill-session')));
 const launch=tmuxLaunch('/socket','gm','/work',"/spec'$(touch forbidden)",'/loop',100,30);assert.match(launch.at(-1)!,/'\\''/);assert.ok(launch.includes('/dev/null'));
}finally{terminal.shutdown();rmSync(dir,{recursive:true,force:true});}});
test("B2.4: ANSI/Turkish survive; split known/generic secrets are redacted",()=>{
 const secret='sahte-uzun-gizli-deger';for(let i=1;i<secret.length;i++){const r=new TerminalRedactor(()=>[secret]);const out=r.push('\x1b[32mŞirket '+secret.slice(0,i))+r.push(secret.slice(i)+'\x1b[0m\r\n');assert.ok(!out.includes(secret));assert.match(out,/gizlendi/);assert.match(out,/\x1b\[32mŞirket/);}
 const r=new TerminalRedactor(()=>[]);const out=r.push('Bearer abcdefgh')+r.push('ijklmnop\r\n');assert.ok(!out.includes('abcdefghijklmnop'));assert.match(out,/gizlendi/);
});
test("B2.4: Director JSONL metadata/usage are read without following external links/symlinks",()=>{const {dir}=fixture();try{
 const profile=join(dir,'profile'),root=join(profile,'codex','sessions','2026','10','14');mkdirSync(root,{recursive:true});const id=randomUUID(),path=join(root,`rollout-${id}.jsonl`);writeFileSync(path,[{type:'session_meta',payload:{id}},{type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'task_started'}},{type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'token_count',info:{total_token_usage:{input_tokens:100,cached_input_tokens:80,output_tokens:10}}}},{type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'task_complete',last_agent_message:'Kısa rapor'}}].map(v=>JSON.stringify(v)).join('\n'));
 const read=terminalRollout(profile,id)!;assert.equal(read.id,id);assert.equal(read.events.length,3);assert.equal(read.events[1].info.total_token_usage.input_tokens,100);assert.equal(terminalRollout(profile,randomUUID()),undefined);
 rmSync(path);symlinkSync('/etc/passwd',path);assert.equal(terminalRollout(profile,id),undefined);
}finally{rmSync(dir,{recursive:true,force:true});}});
test("B2.4: real idle metadata, input/20-second gate and tmux paste order",()=>{const {dir,config,lease}=fixture();let now=100000;const commands:string[][]=[],reports:any[]=[];const deps:TerminalDeps={capture:()=> '› Ask Codex to do anything',now:()=>now,report:v=>reports.push(v),verify:()=>{},box:c=>({...c,bin:'/usr/bin/true',args:['--',c.bin,...c.args]}),tmux:args=>{commands.push(args);return args.includes('has-session')?1:0;},spawn:()=>({write:()=>{},resize:()=>{},kill:()=>{},onData:()=>{},onExit:()=>{}})};
 const terminal=new RunnerTerminal(config,'test',deps);try{
  terminal.start(lease,1);const auto=randomUUID();terminal.inject(auto,'Kısa paket');assert.equal(reports.at(-1).accepted,false,"PTY activity is not proof of idleness.");
  const profile=prepare(lease,config,true).profile,root=join(profile,'codex','sessions');mkdirSync(root,{recursive:true});const id=randomUUID();writeFileSync(join(root,`rollout-${id}.jsonl`),[{type:'session_meta',payload:{id}},{type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'task_complete',last_agent_message:'Bitti'}}].map(v=>JSON.stringify(v)).join('\n'));
  now+=2000;terminal.observe();terminal.input({type:'input',data:'Taslak'});now+=21000;terminal.inject(auto,'Kısa paket');assert.equal(reports.at(-1).accepted,false,"Do not overwrite an unsent draft.");
  terminal.input({type:'input',data:'\r'});terminal.observe();terminal.inject(auto,'Kısa paket');assert.equal(reports.at(-1).accepted,false,"Wait twenty seconds after the latest keystroke.");
  // A new actual completion confirms the next idle moment.
  writeFileSync(join(root,`rollout-${id}.jsonl`),[{type:'session_meta',payload:{id}},{type:'event_msg',timestamp:new Date(now).toISOString(),payload:{type:'task_complete',last_agent_message:'İkinci bitti'}}].map(v=>JSON.stringify(v)).join('\n'));terminal.observe();now+=20000;terminal.inject(auto,'Kısa paket');assert.equal(reports.at(-1).accepted,true);
  const sequence=commands.filter(c=>c.includes('set-buffer') || c.includes('paste-buffer') || c.includes('send-keys')).map(c=>c[2]);assert.deepEqual(sequence,['set-buffer','paste-buffer','send-keys']);assert.ok(commands.find(c=>c.includes('paste-buffer'))!.includes('-p'));
 }finally{terminal.shutdown();rmSync(dir,{recursive:true,force:true});}});
test("B2.4: failed tmux security settings prevent PTY launch and close the session",()=>{const {dir,config,lease}=fixture();const commands:string[][]=[],reports:any[]=[];let spawned=false;const terminal=new RunnerTerminal(config,'test',{report:v=>reports.push(v),verify:()=>{},box:c=>({...c,bin:'/usr/bin/true',args:['--',c.bin,...c.args]}),tmux:args=>{commands.push(args);return args.includes('has-session') || args.includes('prefix')?1:0;},spawn:()=>{spawned=true;throw new Error("Must not launch");}});
 try{terminal.start(lease,1);assert.equal(spawned,false);assert.ok(commands.some(c=>c.includes('kill-session')));assert.equal(reports.at(-1).type,'error');}finally{terminal.shutdown();rmSync(dir,{recursive:true,force:true});}});
test("B2.4: large rollout headers preserve identity; native calls expose only name/ID",()=>{const {dir}=fixture();try{
 const profile=join(dir,'profile'),root=join(profile,'codex','sessions');mkdirSync(root,{recursive:true});const id=randomUUID(),path=join(root,`rollout-${id}.jsonl`);writeFileSync(path,[{type:'session_meta',payload:{id,instructions:'x'.repeat(1100000)}},{type:'response_item',timestamp:new Date().toISOString(),payload:{type:'function_call',name:'shell',call_id:'native-1',arguments:'Gizli komut içeriği'}},{type:'response_item',timestamp:new Date().toISOString(),payload:{type:'function_call',name:'mcp__ofis__yonetim_durum',call_id:'mcp-1'}},{type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'task_complete',last_agent_message:'Bitti'}}].map(v=>JSON.stringify(v)).join('\n'));
 const value=terminalRollout(profile)!;assert.equal(value.id,id);assert.equal(value.events.length,2);assert.equal(value.events[0].type,'native_call');assert.ok(!JSON.stringify(value.events).includes('Gizli komut içeriği'));assert.ok(!JSON.stringify(value.events).includes('mcp__ofis__'));
}finally{rmSync(dir,{recursive:true,force:true});}});
test("B2.4.2: persistent untrusted decisions preserve settings; corrupt files and links fail",()=>{const {dir,config,lease}=fixture();try{
 const p=prepare(lease,config,true),home=p.command.env.CODEX_HOME!,path=join(home,'config.toml');
 writeFileSync(path,`model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n[projects.${JSON.stringify(p.work)}]\ntrust_level = "trusted"\n[notice]\nhide_rate_limit_model_nudge = true\n`);
 writeRestrictedProjectConfig(home,p.work);const text=readFileSync(path,'utf8');assert.match(text,/"trust_level" = "untrusted"/);assert.ok(!text.includes('"trusted"'));assert.match(text,/"model_reasoning_effort" = "high"/);assert.match(text,/"hide_rate_limit_model_nudge" = true/);assert.equal(statSync(path).mode&0o777,0o600);
 writeRestrictedProjectConfig(home,p.work);assert.equal(readFileSync(path,'utf8'),text);
 writeFileSync(path,'[broken');assert.throws(()=>writeRestrictedProjectConfig(home,p.work),/kaydedilemedi/);assert.equal(readFileSync(path,'utf8'),'[broken');
 rmSync(path);const target=join(dir,'untouched');writeFileSync(target,'Değişmemeli');symlinkSync(target,path);assert.throws(()=>writeRestrictedProjectConfig(home,p.work),/kullanılamıyor/);assert.equal(readFileSync(target,'utf8'),'Değişmemeli');
}finally{rmSync(dir,{recursive:true,force:true});}});
test("B2.4.2: fake PTY submits automatically only at a real TUI blank prompt; trust menu selects only 1",()=>{const {dir,config,lease}=fixture();let now=Date.now(),pane:string|undefined='',emit:(text:string)=>void=()=>{},attached=0;const commands:string[][]=[],reports:any[]=[];
 const deps:TerminalDeps={now:()=>now,report:v=>reports.push(v),verify:()=>{},capture:()=>pane,box:c=>({...c,bin:'/usr/bin/true',args:['--',c.bin,...c.args]}),tmux:args=>{commands.push(args);if(args.includes('new-session')){const home=join(config.workDir,'.terminal',lease.agent.id,'1','codex');assert.match(readFileSync(join(home,'config.toml'),'utf8'),/"trust_level" = "untrusted"/);}return args.includes('has-session')?1:0;},spawn:()=>{attached++;return {write:()=>{},resize:()=>{},kill:()=>{},onData:fn=>{emit=text=>{pane=text;fn(text);};},onExit:()=>{}};}};
 const terminal=new RunnerTerminal(config,'test',deps);try{
  terminal.start(lease,1);const p=prepare(lease,config,true),spec=JSON.parse(readFileSync(join(config.workDir,'.terminal-control',`gm-${lease.agent.id}-1.json`),'utf8'));assert.ok(!spec.command.args.some((v:string)=>v.startsWith('permissions=')),"Preserve the Claude permission-conflict workaround.");
  const auto=randomUUID();pane='› Ask Codex to do anything';terminal.observe();now+=10000;terminal.observe();assert.equal(attached,0,"The initial transient blank line does not prove trust-screen completion, even after a delay.");
  pane='Folder access\n1. Trust and continue\n2. Quit';terminal.observe();assert.equal(attached,0);assert.ok(!commands.some(c=>c.includes('send-keys')),"Unknown trust menus must not be passed automatically.");
  pane='Folder access /work\r\n› 1. Open restricted\r\n  2. Quit\r\n';terminal.observe();terminal.inject(auto,'Kısa paket');assert.equal(reports.at(-1).accepted,false);terminal.observe();assert.equal(commands.filter(c=>c.includes('send-keys')).length,1,"Repeated scans must not flood the same screen with keys.");assert.equal(commands.find(c=>c.includes('send-keys'))!.at(-1),'1');
  now+=1000;terminal.observe();assert.equal(commands.filter(c=>c.includes('send-keys')).at(-1)!.at(-1),'Enter');assert.equal(attached,0,"Do not attach the browser to a trust screen.");assert.ok(!reports.some(r=>r.type==='output'));
  now+=3000;pane='Folder access /work\n  1. Open restricted\n› 2. Quit';terminal.observe();assert.equal(commands.filter(c=>c.includes('send-keys')).at(-1)!.at(-1),'Up');now+=1000;terminal.observe();assert.equal(commands.filter(c=>c.includes('send-keys')).at(-1)!.at(-1),'Up',"Do not send Enter while Quit is selected.");
  pane='Folder access /work\n› 1. Open restricted\n  2. Quit';terminal.observe();assert.equal(commands.filter(c=>c.includes('send-keys')).at(-1)!.at(-1),'Enter');assert.ok(!commands.some(c=>c.includes('Quit') || c.at(-1)==='2'));
  const root=join(p.profile,'codex','sessions'),id=randomUUID(),path=join(root,`rollout-${id}.jsonl`);mkdirSync(root,{recursive:true});
  const rollout=(type:string)=>writeFileSync(path,[{type:'session_meta',payload:{id}},{type:'event_msg',timestamp:new Date(now).toISOString(),payload:{type,last_agent_message:'Hazırım'}}].map(v=>JSON.stringify(v)).join('\n'));
  rollout('task_complete');pane='Codex çalışıyor…';terminal.observe();terminal.inject(auto,'Kısa paket');assert.equal(reports.at(-1).accepted,false,"Completion records cannot substitute for an empty input screen.");
  pane='\x1b[2m› Ask Codex to do anything\x1b[0m\r\n  ? for shortcuts';terminal.observe();assert.equal(attached,1);emit(pane);
  emit('› Taslak metin');terminal.inject(auto,'Kısa paket');assert.equal(reports.at(-1).accepted,false,"Read the screen again immediately before submitting.");
  emit('› Ask Codex to do anything');terminal.observe();terminal.input({type:'input',data:'Taslak'});now+=21000;terminal.observe();terminal.inject(auto,'Kısa paket');assert.equal(reports.at(-1).accepted,false,"Even an empty placeholder cannot invalidate a saved user draft.");
  terminal.input({type:'input',data:'\r'});now+=1;rollout('task_complete');terminal.observe();terminal.inject(auto,'Kısa paket');assert.equal(reports.at(-1).accepted,false);now+=20000;
  pane=undefined;terminal.inject(auto,'Kısa paket');assert.equal(reports.at(-1).accepted,false,"Do not submit when the screen cannot be read.");emit('› Ask Codex to do anything');terminal.observe();terminal.inject(auto,'Birinci satır\nİkinci satır');assert.equal(reports.at(-1).accepted,true);
  assert.deepEqual(commands.filter(c=>['set-buffer','paste-buffer','send-keys'].includes(c[2])).slice(-3).map(c=>c[2]),['set-buffer','paste-buffer','send-keys']);terminal.inject(auto,'Tekrar');assert.equal(reports.at(-1).accepted,false);
  now+=1;rollout('task_started');emit('› Ask Codex to do anything');terminal.observe();now+=21000;terminal.inject(auto,'Çalışırken');assert.equal(reports.at(-1).accepted,false);
 }finally{terminal.shutdown();rmSync(dir,{recursive:true,force:true});}
});
test("B2.4.2: narrow TUI rules send no keys to unrelated menus or text",()=>{
 for(const text of ['Ask Codex to do anything','• Yanıt: Ask Codex to do anything','› Ask Codex to do anything taslak','Folder access\n1. Trust this folder\n2. Quit','Folder access\n1. Quit\n2. Open restricted']){assert.equal(terminalScreen(text).restricted,false);assert.equal(terminalScreen(text).empty,false);}
 assert.equal(terminalScreen('Folder access\n  1. Open restricted\n› 2. Quit').restricted,true);
 const command={bin:'codex',args:['-c','permissions={ofis={}}','-c','default_permissions="ofis"','Merhaba'],env:{},cwd:'/work'};assert.deepEqual(withoutPermissionDefinition(command).args,['-c','default_permissions="ofis"','Merhaba']);
});
test("B2.4: administrator profile mounts read-only; compatible version and profile list are required",async()=>{const {writeTerminalPolicy,terminalVersionSupported}=await import('../src/terminal-policy.js');const {dir,config,lease}=fixture();try{
 const prepared=prepare(lease,config,true);writeTerminalPolicy(prepared.command,prepared.profile);const policy=readFileSync(join(prepared.profile,'terminal-policy','requirements.toml'),'utf8');assert.match(policy,/allowed_permission_profiles = \{ofis=true\}/);assert.match(policy,/default_permissions = "ofis"/);assert.ok(!policy.includes(lease.key));assert.match(policy,/network=\{enabled=false\}/);assert.match(policy,/plugins = false/);
 const boxed=isolate(prepared.command,config,lease,prepared.profile);const index=boxed.args.indexOf('/etc/codex');assert.equal(boxed.args[index-2],'--ro-bind');assert.equal(boxed.args[index-1],join(prepared.profile,'terminal-policy'));
 const bwrap=boxed.args.indexOf('/opt/ofis-sandbox/bin/bwrap');assert.equal(boxed.args[bwrap-2],'--ro-bind');assert.equal(boxed.args[bwrap-1],'/usr/bin/true');assert.equal(boxed.env.PATH?.split(':')[0],'/opt/ofis-sandbox/bin');
 const source=boxed.args.lastIndexOf(join(prepared.profile,'terminal-policy'));assert.equal(boxed.args[source-2],'--ro-bind');assert.equal(boxed.args[source-1],join(prepared.profile,'terminal-policy'));assert.ok(source>boxed.args.indexOf(prepared.profile),"Policy sources remain read-only after the writable profile is mounted.");
 assert.equal(terminalVersionSupported('codex-cli 0.159.1'),true);assert.equal(terminalVersionSupported('codex-cli 0.137.0'),false);assert.equal(terminalVersionSupported('unknown'),false);
}finally{rmSync(dir,{recursive:true,force:true});}});

test("FR: verify tmux absence after a prior stop or runner restart",()=>{
 const {dir,config,lease}=fixture();let alive=false,allowKill=false;const commands:string[][]=[];
 const deps:TerminalDeps={report:()=>{},verify:()=>{},box:c=>({...c,bin:'/usr/bin/true',args:['--',c.bin,...c.args]}),tmux:args=>{
  commands.push(args);if(args.includes('has-session'))return alive?0:1;if(args.includes('new-session'))alive=true;if(args.includes('kill-session') && allowKill)alive=false;return 0;
 },spawn:()=>({write:()=>{},resize:()=>{},kill:()=>{},onData:()=>{},onExit:()=>{}})};
 const terminal=new RunnerTerminal(config,'test',deps);let restarted:RunnerTerminal|undefined;
 try{
  terminal.start(lease,1);assert.equal(alive,true);terminal.stop();assert.equal(terminal.agentId,undefined);
  restarted=new RunnerTerminal(config,'test',deps);assert.equal(restarted.resetIdle([lease.agent.id]),false,"Existing old processes prevent quiescence confirmation.");
  allowKill=true;assert.equal(restarted.resetIdle([lease.agent.id]),true);const starts=commands.filter(c=>c.includes('new-session')).length;
  restarted.start(lease,1);assert.equal(commands.filter(c=>c.includes('new-session')).length,starts,"The terminal cannot start while the gate is active.");
  restarted.resumeAfterReset();restarted.start(lease,1);assert.equal(commands.filter(c=>c.includes('new-session')).length,starts+1);
 }finally{allowKill=true;terminal.shutdown();restarted?.shutdown();rmSync(dir,{recursive:true,force:true});}
});
