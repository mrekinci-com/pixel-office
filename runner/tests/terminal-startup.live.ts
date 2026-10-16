// Real Codex TUI, no model submission, real credentials, services or listener.
// The additional network namespace prevents even background outbound traffic.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,existsSync,realpathSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import * as pty from 'node-pty';
import {prepare,isolate} from '../src/command.js';
import {interactiveCommand} from '../src/terminal-loop.js';
import {withoutPermissionDefinition} from '../src/terminal.js';
import {writeTerminalPolicy} from '../src/terminal-policy.js';
import {writeRestrictedProjectConfig} from '../src/terminal-config.js';
import {terminalScreen} from '../src/terminal-screen.js';
import {defaultPolicy,type Lease} from '../../office/shared/runtime.js';
import type {RunnerConfig} from '../src/config.js';
// xterm's parser/buffer works without opening a browser or a DOM. Interpret
// cursor movements before checking the same screen rule used by capture-pane.
const {Terminal}=createRequire(resolve('../office/package.json'))('@xterm/xterm');

test("B2.4.2: real TUI reads persistent untrusted decisions; safe access prompt and read-only bwrap PATH",async()=>{
 const root=resolve('.test-data');mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,'terminal-startup-live-'));
 try{
  const requested=process.env.OFIS_CODEX_BIN || 'codex',found=requested.includes('/')?requested:(process.env.PATH || '').split(':').map(p=>join(p,requested)).find(existsSync);assert.ok(found);
  const codex=realpathSync(found),platform=dirname(createRequire(codex).resolve(`@openai/codex-linux-${process.arch==='x64'?'x64':'arm64'}/package.json`));
  const bundled=join(platform,'vendor',`${process.arch==='x64'?'x86_64':'aarch64'}-unknown-linux-musl`,'codex-resources','bwrap');
  const config:RunnerConfig={url:'http://127.0.0.1:9401',key:'yalniz-yerel-deneme'.repeat(3),workDir:join(dir,'work'),allowedRoots:[],protectedRoots:[],concurrency:1,claude:'claude',codex,bwrap:process.env.OFIS_BWRAP_BIN || bundled,codexModel:'gpt-6.1-sol'};
  const lease={run:{id:randomUUID()},agent:{id:randomUUID(),builtin:'director',runner:'codex',model:'gpt-6.1-sol',effort:'low'},policy:defaultPolicy,links:[],key:'sahte-is-anahtari',prompt:'Gönderilmeyecek',terminalInstructions:'Sade Türkçe konuş; sahibe ayrılmış onayları koru.',session:{generation:1,provider_id:null}} as unknown as Lease;
  const p=prepare(lease,config,true);writeTerminalPolicy(p.command,p.profile);
  writeFileSync(join(p.profile,'codex','auth.json'),JSON.stringify({OPENAI_API_KEY:'sk-yalniz-sahte-yerel-deneme'}),{mode:0o600});
  const cli=interactiveCommand(withoutPermissionDefinition(p.command));cli.args.pop();
  // No MCP startup calls to the office or model submission in this local test.
  cli.args=cli.args.filter((value,index,args)=>!(value==='-c' && args[index+1]?.startsWith('mcp_servers.')) && !(args[index-1]==='-c' && value.startsWith('mcp_servers.')));
  const runtimeConfig=join(p.profile,'codex','ofis-runtime.config.toml');
  writeFileSync(runtimeConfig,readFileSync(runtimeConfig,'utf8').split('\n').filter(line=>!line.startsWith('mcp_servers.')).join('\n'),{mode:0o600});
  const boxed=isolate(cli,config,lease,p.profile);boxed.args.unshift('--unshare-net');
  const inspect=isolate({...p.command,bin:'/usr/bin/python3',args:['-c',`import os,shutil,errno
path=shutil.which("bwrap")
assert path=="/opt/ofis-sandbox/bin/bwrap"
assert os.statvfs(path).f_flag & os.ST_RDONLY
try:
 fd=os.open(path,os.O_WRONLY)
 os.close(fd)
 raise SystemExit(2)
except OSError as e:
 assert e.errno in (errno.EROFS,errno.ETXTBSY)
print("BWRAP_PATH_SALT_OKUNUR")`]},config,lease,p.profile);
  const checked=spawnSync(inspect.bin,inspect.args,{cwd:inspect.cwd,env:inspect.env,encoding:'utf8',timeout:5000});assert.equal(checked.status,0,checked.stderr);assert.equal(checked.stdout.trim(),'BWRAP_PATH_SALT_OKUNUR');
  const launch=(persisted:boolean)=>new Promise<boolean>((resolve,reject)=>{
   let output='',finished=false,selected=false,settle:ReturnType<typeof setTimeout>|undefined;const emulator=new Terminal({cols:100,rows:30,allowProposedApi:true});
   const screen=()=>Array.from({length:30},(_,i)=>emulator.buffer.active.getLine(emulator.buffer.active.viewportY+i)?.translateToString(true) || '').join('\n');
   const handle=pty.spawn(boxed.bin,boxed.args,{cwd:boxed.cwd,env:boxed.env,cols:100,rows:30,name:'xterm-256color'});
   const finish=(error?:Error)=>{if(finished)return;finished=true;clearTimeout(timer);clearTimeout(settle);handle.kill();emulator.dispose();error?reject(error):resolve(selected);};
   const timer=setTimeout(()=>finish(new Error("The local TUI did not reach the expected startup screen.")),12000);
   handle.onExit(()=>{if(!finished)finish(new Error("The local TUI exited before the expected screen."));});
   handle.onData(text=>{
    output+=text;
    // Answer terminal capability probes, never an interactive menu or input.
    if(text.includes('\x1b[6n'))handle.write('\x1b[1;1R');
    if(text.includes('\x1b]11;?'))handle.write('\x1b]11;rgb:1010/1919/2323\x1b\\');
    emulator.write(text,()=>{
     if(finished)return;const current=screen(),state=terminalScreen(current);
     if(!selected && current.includes('Open restricted') && current.includes('Quit')){
      if(!state.restricted)finish(new Error("The terminal rule did not recognize the trust screen."));else{selected=true;setTimeout(()=>{if(!finished)handle.write('1');setTimeout(()=>{if(!finished)handle.write('\r');},200);},300);}
     }
     if(persisted || selected){
      if(output.includes('could not find bubblewrap'))finish(new Error("The box still showed the bwrap PATH warning."));
      else if(state.empty && !settle)settle=setTimeout(()=>{if(terminalScreen(screen()).empty)finish();else settle=undefined;},1000);
     }
    });
   });
  });
  assert.equal(await launch(false),true);console.log("CLI untrusted only: trust prompt repeated; screen rule recognized it and separate 1 / Enter selected restricted mode.");
  writeRestrictedProjectConfig(p.command.env.CODEX_HOME!,p.work);
  // Remove the CLI trust override: the two-choice restricted screen must now
  // come from CODEX_HOME/config.toml, rather than an argument.
  boxed.args=boxed.args.filter((value,index,args)=>!(value==='-c' && args[index+1]?.startsWith('projects=')) && !(args[index-1]==='-c' && value.startsWith('projects=')));
  const question=await launch(true);console.log(`Persistent untrusted decision (no CLI trust): ${question?'access prompt remained and was passed safely':'no access prompt'}; real empty input recognized.`);
  const saved=readFileSync(join(p.profile,'codex','config.toml'),'utf8');assert.match(saved,/"trust_level" = "untrusted"/);assert.ok(!saved.includes('"trusted"'));
  console.log("PATH bwrap is read-only; no model input was submitted.");
 }finally{rmSync(dir,{recursive:true,force:true});}
});
