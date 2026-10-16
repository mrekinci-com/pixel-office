import { t as tx } from "./i18n.js";
import { spawn } from 'node:child_process';
import { readFileSync,statSync,existsSync } from 'node:fs';
import type { Command } from './command.js';
import { writeTerminalJson,validTerminalId } from './terminal-state.js';
import { providerRollout } from './claude-rollout.js';
import { writeRestrictedProjectConfig } from './terminal-config.js';
export interface TerminalSpec {command:Command;profile:string;statePath:string;alivePath:string;runner?:"codex"|"claude";}
export function interactiveCommand(command:Command,provider?:string,runner:'codex'|'claude'='codex'):Command {
  if(runner==='claude') {
    const args=command.args.slice();
    if(provider) {
      args.pop();
      const at=args.indexOf('--session-id');if(at>=0)args.splice(at,2);
      args.push('--resume',provider);
    }
    return {...command,args,env:{...command.env,TERM:'xterm-256color',COLORTERM:'truecolor'}};
  }
  const args=command.args.slice();
  for(const flag of ['exec','--json','--ephemeral','--ignore-user-config','--ignore-rules','--skip-git-repo-check']){const at=args.indexOf(flag);if(at>=0)args.splice(at,1);}
  const prompt=args.pop()!;
  args.unshift('--no-daemon');
  if(provider){args.unshift('resume');args.push(provider);}else args.push(prompt);
  return {...command,args,env:{...command.env,TERM:'xterm-256color',COLORTERM:'truecolor'}};
}
// This trusted host supervisor runs in the GM tmux pane. Its child is always the
// pre-verified bwrap command, never a host shell obtained from terminal input.
export async function terminalLoop(path:string){
  let closing=false,child:ReturnType<typeof spawn>|undefined;
  const stop=()=>{closing=true;child?.kill('SIGKILL');};process.on('SIGTERM',stop);process.on('SIGINT',stop);
  while(!closing){
    let spec:TerminalSpec;
    try{spec=JSON.parse(readFileSync(path,'utf8'));}catch{process.stdout.write(tx("Terminal ayarı okunamadı.\r\n"));return;}
    const alive=()=>{try{return Date.now()-statSync(spec.alivePath).mtimeMs<15000;}catch{return false;}};
    if(!alive()){await new Promise(r=>setTimeout(r,1000));continue;}
    let provider:string|undefined;
    try{const saved=JSON.parse(readFileSync(spec.statePath,'utf8')).provider_id;if(validTerminalId(saved))provider=saved;}catch{}
    const observed=providerRollout(spec.profile,spec.runner || "codex",provider);if(observed)provider=observed.id;
    if(!provider && existsSync(spec.statePath)){process.stdout.write(tx("Konuşma kimliği okunamadı. Yeni konuşma düğmesiyle devam edin.\r\n"));return;}
    // The already isolated command ends in the Codex executable followed by its args.
    const args=spec.command.args.slice(),separator=args.indexOf('--'),cli={...spec.command,bin:args[separator+1],args:args.slice(separator+2)};
    const interactive=interactiveCommand(cli,provider,spec.runner);
    try{if(spec.runner!=="claude")writeRestrictedProjectConfig(interactive.env.CODEX_HOME!,interactive.cwd);}catch{process.stdout.write(tx("Terminalin kısıtlı klasör kararı kaydedilemedi.\r\n"));return;}
    const command={...spec.command,args:[...args.slice(0,separator+2),...interactive.args],env:interactive.env};
    const started=Date.now();
    child=spawn(command.bin,command.args,{cwd:command.cwd,env:command.env,stdio:'inherit'});
    const poll=setInterval(()=>{
      if(!alive())child?.kill('SIGKILL');
      const current=providerRollout(spec.profile,spec.runner || "codex",provider,provider?0:started);
      if(current){provider=current.id;writeTerminalJson(spec.statePath,{provider_id:provider});}
    },1000);
    await new Promise<void>(resolve=>{child!.once('error',()=>resolve());child!.once('exit',()=>resolve());});clearInterval(poll);
    const current=providerRollout(spec.profile,spec.runner || "codex",provider,provider?0:started);if(current)writeTerminalJson(spec.statePath,{provider_id:current.id});
    if(!closing){process.stdout.write(tx("\r\nTerminal kapandı; aynı konuşma yeniden açılacak.\r\n"));await new Promise(r=>setTimeout(r,3000));}
  }
}
if(process.argv[1]?.endsWith('/terminal-loop.js') && process.argv[2])await terminalLoop(process.argv[2]);
