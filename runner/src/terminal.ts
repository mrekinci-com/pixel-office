import { t as tx, withLanguage } from "./i18n.js";
import { writeTerminalPolicy,verifyTerminal } from './terminal-policy.js';
import { writeTerminalJson } from './terminal-state.js';
import { createHash } from 'node:crypto';
import { providerRollout } from './claude-rollout.js';
import { verifyClaude } from './claude-policy.js';
import { hasAuth, claudeLoginCommand, retainAuth } from './auth.js';
import { spawnSync } from 'node:child_process';
import { mkdirSync,writeFileSync,existsSync,lstatSync,realpathSync,utimesSync,chmodSync,readdirSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import * as pty from 'node-pty';
import type { RunnerConfig } from './config.js';
import type { Lease } from '../../office/shared/runtime.js';
import { PROTOCOL_VERSION } from '../../office/shared/runtime.js';
import { terminalCommand, terminalUserInput, type TerminalToRunner } from '../../office/shared/terminal.js';
import { prepare,isolate,verifyShell,type Command } from './command.js';
import { directoryMaps } from './workspace.js';
import { profileSecrets } from './secrets.js';
import { diagnose } from './diagnostics.js';
import { TerminalRedactor } from './terminal-redactor.js';
import { writeRestrictedProjectConfig } from './terminal-config.js';
import { terminalScreen } from './terminal-screen.js';
const quote=(text:string)=>`'${text.replaceAll("'","'\\''")}'`;
export function withoutPermissionDefinition(command:Command):Command{const args:string[]=[];for(let i=0;i<command.args.length;i++){if(command.args[i]==='-c' && command.args[i+1]?.startsWith('permissions=')){i++;continue;}args.push(command.args[i]);}return {...command,args};}
export function tmuxLaunch(socket:string,name:string,work:string,spec:string,loop:string,cols:number,rows:number){
  return ['-S',socket,'-f','/dev/null','new-session','-d','-s',name,'-x',String(cols),'-y',String(rows),'-c',work,`exec ${quote(process.execPath)} ${quote(loop)} ${quote(spec)}`];
}
export interface PtyHandle {write(text:string):void;resize(cols:number,rows:number):void;kill():void;onData(fn:(text:string)=>void):unknown;onExit(fn:()=>void):unknown;}
export interface TerminalDeps {spawn:(bin:string,args:string[],opts:pty.IPtyForkOptions)=>PtyHandle;tmux:(args:string[],env:NodeJS.ProcessEnv)=>number|null;capture?:(args:string[],env:NodeJS.ProcessEnv)=>string|undefined;box:(command:Command,c:RunnerConfig,l:Lease,profile:string)=>Command;verify:typeof verifyShell;now?:()=>number;report?:(value:any)=>void;}
const defaultDeps:TerminalDeps={spawn:pty.spawn,tmux:(args,env)=>spawnSync('tmux',args,{env,encoding:'utf8',timeout:5000,stdio:'ignore'}).status,box:isolate,verify:(command,c,l,profile)=>l.agent.runner==='claude'?verifyClaude(command,c,l,profile):verifyTerminal(command,c,l,profile)};
export class RunnerTerminal {
  private ws?:WebSocket;
  private generationScope?:number;
  private attach?:PtyHandle;
  private attachment?:{work:string;env:NodeJS.ProcessEnv;readyAt:number};
  private current?:{lease:Lease;profile:string;name:string;socket:string;alive:string;generation:number;initialAuth:string};
  private reconnectAt=0;
  private opening=false;
  private resetPaused=false;
  private cols=100;private rows=30;
  private redactor?:TerminalRedactor;
  private secretValues?:()=>string[];
  private closing=false;
  private seen=new Set<string>();
  private idleConfirmed=false;
  private turnFinished=false;
  private restrictedAt=-Infinity;
  private restrictedSelectionPending=false;
  private accessOpened=false;
  private metadataFloor=0;
  private lastOutputAt=0;
  private lastInput=0;
  private inputDirty=false;
  private monitor?:ReturnType<typeof setInterval>;
  constructor(private config:RunnerConfig,private runner:string,private deps:TerminalDeps=defaultDeps){}
  get agentId(){return this.current?.lease.agent.id;}
  connect(){
    if(this.closing || this.ws || Date.now()<this.reconnectAt)return;
    const url=new URL(this.config.url);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.pathname='/api/runner/terminal';url.search=`runner=${encodeURIComponent(this.runner)}&protocol=${PROTOCOL_VERSION}`;
    const ws=new WebSocket(url,{headers:{Authorization:`Bearer ${this.config.key}`},maxPayload:200000,handshakeTimeout:10000});this.ws=ws;
    ws.on('message',data=>{try{const b=JSON.parse(data.toString()) as TerminalToRunner;if(b.type==='start')this.start(b.lease,b.generation,b.restart);else if(b.type==='stop')this.stop();else if(b.type==='inject')this.inject(b.id,b.text);else this.input(b);}catch{this.send({type:'error',message:tx("Terminal isteği işlenemedi.")});}});
    ws.on('close',()=>{if(this.ws===ws){this.ws=undefined;this.reconnectAt=Date.now()+2000;}this.detach();});ws.on('error',()=>{});
  }
  private send(value:unknown){if(this.generationScope && value && typeof value==='object')value={...value,generation:this.generationScope};if(this.deps.report){this.deps.report(value);return;}if(this.ws?.readyState===WebSocket.OPEN && this.ws.bufferedAmount<512000)this.ws.send(JSON.stringify(value));else if(this.ws?.readyState===WebSocket.OPEN)this.ws.close(1009);}
  heartbeat(){
    if(this.current && this.ws?.readyState===WebSocket.OPEN)try{const now=new Date();utimesSync(this.current.alive,now,now);}catch{}
    this.connect();
  }
  start(lease:Lease,generation:number,restart=false){
    return withLanguage(lease.language || this.config.language || "tr", () => this.startOnce(lease,generation,restart));
  }
  private startOnce(lease:Lease,generation:number,restart=false){
    if(this.opening || this.closing || this.resetPaused)return;
    if(lease.agent.builtin!=='director' || !/^[a-f0-9-]{36}$/.test(lease.agent.id) || !lease.session || lease.session.generation!==generation || !Number.isSafeInteger(generation) || generation<1)throw new Error(tx("Terminal yalnız Genel Müdür oturumuna açıktır."));
    if(this.current && (this.attach || this.attachment) && this.current.lease.agent.id===lease.agent.id && this.current.generation===generation && this.current.lease.key===lease.key && this.current.lease.agent.runner===lease.agent.runner && !restart)return;
    if(this.current && (this.current.lease.key!==lease.key || this.current.lease.agent.runner!==lease.agent.runner))restart=true;
    this.generationScope=generation;
    const trackingStarted=this.deps.now?.() ?? Date.now();
    this.opening=true;let cleanup:{socket:string;name:string;env:NodeJS.ProcessEnv}|undefined;
    try{
      if(lease.agent.runner==='claude' && !hasAuth(this.config.workDir,'claude',this.config.claudeAuth))throw new Error('CLAUDE_LOGIN_REQUIRED');
      const prepared=prepare(lease,this.config,true);directoryMaps(lease,prepared.work);
      const secrets=[this.config.key,lease.key,...profileSecrets(prepared.profile)];
      this.secretValues=()=>[...secrets,...profileSecrets(prepared.profile)];this.redactor=new TerminalRedactor(this.secretValues,()=>tx("[gizlendi]"));
      this.send({type:'secrets',values:this.secretValues().filter(v=>v.length>=8 && v.length<=16000).slice(0,128)});
      if(lease.agent.runner==='codex') {
        writeRestrictedProjectConfig(prepared.command.env.CODEX_HOME!,prepared.work);
        writeTerminalPolicy(prepared.command,prepared.profile);
      }
      this.deps.verify(prepared.command,this.config,lease,prepared.profile);
      // requirements.toml already defines the `ofis` profile; a second -c definition makes Codex refuse to start.
      const command=this.deps.box(withoutPermissionDefinition(prepared.command),this.config,lease,prepared.profile);
      const control=join(this.config.workDir,'.terminal-control');mkdirSync(control,{recursive:true,mode:0o700});
      if(lstatSync(control).isSymbolicLink() || realpathSync(control)!==resolve(control))throw new Error(tx("Terminal denetim yolu kullanılamıyor."));chmodSync(control,0o700);
      const socket=join(control,'tmux.sock'),name=`gm-${lease.agent.id}-${generation}`,spec=join(control,`${name}.json`),state=join(control,`${name}.state.json`),alive=join(control,`${name}.alive`);
      for(const path of [socket,spec,state,alive])if(existsSync(path) && lstatSync(path).isSymbolicLink())throw new Error(tx("Terminal denetim yolu kullanılamıyor."));
      writeFileSync(alive,'',{mode:0o600});writeTerminalJson(spec,{command,profile:prepared.profile,statePath:state,alivePath:alive,runner:lease.agent.runner});
      cleanup={socket,name,env:prepared.command.env};
      if(this.current && (restart || this.current.name!==name))this.stop();else this.detach();
      if(restart)this.deps.tmux(['-S',socket,'kill-session','-t',name],prepared.command.env);
      const compiled=import.meta.url.endsWith('/dist/runner/src/terminal.js'),loop=fileURLToPath(new URL(compiled?'./terminal-loop.js':'../dist/runner/src/terminal-loop.js',import.meta.url));
      if(this.deps.tmux(['-S',socket,'has-session','-t',name],prepared.command.env)!==0 && this.deps.tmux(tmuxLaunch(socket,name,prepared.work,spec,loop,this.cols,this.rows),prepared.command.env)!==0)throw new Error(tx("tmux terminali başlatılamadı."));
      // Dedicated tmux server ignores user config and binds only a Unix socket.
      // A browser must never reach tmux's host command prompt (run-shell, respawn).
      // This server is private to the runner, so disable both prefix and root bindings.
      for(const args of [
        ['set-option','-g','prefix','None'],['set-option','-g','prefix2','None'],
        ['unbind-key','-a'],['unbind-key','-a','-T','root'],
        ['set-option','-g','mouse','off'],['set-option','-g','allow-passthrough','off'],
        ['set-option','-t',name,'status','off'],
      ])if(this.deps.tmux(['-S',socket,...args],prepared.command.env)!==0)throw new Error(tx("tmux güvenlik ayarları uygulanamadı."));
      this.deps.tmux(['-S',socket,'set-option','-t',name,'history-limit','2000'],prepared.command.env);
      this.turnFinished=false;this.idleConfirmed=false;this.restrictedAt=-Infinity;this.restrictedSelectionPending=false;this.accessOpened=false;
      if(this.current?.generation!==generation){this.seen.clear();this.inputDirty=false;this.metadataFloor=trackingStarted;}
      this.current={lease,profile:prepared.profile,name,socket,alive,generation,initialAuth:prepared.initialAuth};
      // A fresh TUI briefly paints a composer before its access dialog. Keep
      // the client detached until onboarding is over, so owners never see it.
      this.attachment={work:prepared.work,env:prepared.command.env,readyAt:(this.deps.now?.() ?? Date.now())+2000};
      this.send({type:'status',status:'waiting',usageKnown:false});
      this.monitor=setInterval(()=>{try{this.observe();}catch{this.stop();this.send({type:'error',message:tx("Terminal kaydı güvenle okunamadı; terminal durduruldu.")});}},1000);
    }catch(error){this.stop();if(cleanup)this.deps.tmux(['-S',cleanup.socket,'kill-session','-t',cleanup.name],cleanup.env);this.current=undefined;this.send({type:'error',message:error instanceof Error && error.message==='CLAUDE_LOGIN_REQUIRED'?tx('Claude girişi yapılmamış — çalıştırıcıda claude girişi gerekli. Ayrı hesap için: {0}',[claudeLoginCommand(this.config.workDir)]):error instanceof Error && error.message.startsWith('tmux')?tx("Kalıcı terminal açılamadı. Çalıştırıcıda tmux kurulumunu ve izinlerini kontrol edin."):diagnose(error instanceof Error?error.message:'')});}finally{this.opening=false;}
  }
  private attachReady(){
      const c=this.current,a=this.attachment;if(!c || !a || this.attach)return;
      const handle=this.deps.spawn('tmux',['-S',c.socket,'-f','/dev/null','attach-session','-t',c.name],{name:'xterm-256color',cols:this.cols,rows:this.rows,cwd:a.work,env:{...a.env,TERM:'xterm-256color'}});this.attach=handle;
      handle.onData(text=>{if(this.attach!==handle)return;this.lastOutputAt=Date.now();try{const data=this.redactor!.push(text);let offset=0;while(offset<data.length){let end=Math.min(offset+30000,data.length);if(end<data.length && /[\uD800-\uDBFF]/.test(data[end-1]))end--;this.send({type:'output',data:data.slice(offset,end)});offset=end;}if(!this.idleConfirmed)this.send({type:'status',status:'working',idleConfirmed:false});}catch{this.stop();this.send({type:'error',message:tx("Terminalin gizli değer denetimi tamamlanamadı; oturum durduruldu.")});}});
      handle.onExit(()=>{if(this.attach===handle){this.attach=undefined;this.send({type:'status',status:'idle'});}});
  }
  input(value:unknown){if(this.resetPaused)return;const b=terminalCommand(value);if(!b)throw new Error(tx("Geçersiz terminal girdisi."));if(b.type==='resize'){this.cols=b.cols;this.rows=b.rows;this.attach?.resize(b.cols,b.rows);return;}if(!this.attach)return;const typed=terminalUserInput(b.data);if(typed){this.lastInput=this.deps.now?.() ?? Date.now();this.inputDirty=typed!=='\r' && typed!=='\n';this.idleConfirmed=false;this.turnFinished=false;}this.attach.write(b.data);}
  private screen(){
    const c=this.current;if(!c)return terminalScreen('',this.current?.lease.agent.runner);
    const args=['-S',c.socket,'capture-pane','-p','-t',c.name],env=prepareEnv(c.profile);
    if(this.deps.capture)return terminalScreen(this.deps.capture(args,env) || '',c.lease.agent.runner);
    const result=spawnSync('tmux',args,{env,encoding:'utf8',timeout:1000,maxBuffer:200000});
    return terminalScreen(result.status===0?result.stdout:'',c.lease.agent.runner);
  }
  inject(id:string,text:string){
    if(!/^[a-f0-9-]{36}$/.test(id) || typeof text!=='string' || Buffer.byteLength(text)>16384)throw new Error(tx("Geçersiz otomatik terminal girdisi."));
    const c=this.current;
    if(this.resetPaused || !c || !this.attach || !this.idleConfirmed || this.inputDirty || (this.deps.now?.() ?? Date.now())-this.lastInput<20000 || !this.screen().empty){this.idleConfirmed=false;this.send({type:'injected',id,accepted:false});return;}
    const env=prepareEnv(c.profile),name=`auto-${id}`;
    // Bracketed paste keeps a multiline event package in one Codex input.
    const accepted=this.deps.tmux(['-S',c.socket,'set-buffer','-b',name,'--',text],env)===0 && this.deps.tmux(['-S',c.socket,'paste-buffer','-p','-d','-b',name,'-t',c.name],env)===0 && this.deps.tmux(['-S',c.socket,'send-keys','-t',c.name,'Enter'],env)===0;
    this.idleConfirmed=false;this.turnFinished=false;this.send({type:'injected',id,accepted});
  }
  observe(){
    if(this.resetPaused || !this.current || !this.deps.report && this.ws?.readyState!==WebSocket.OPEN)return;
    if(this.current.lease.agent.runner==='claude')try{retainAuth(this.config.workDir,'claude',this.current.profile,this.current.initialAuth);}catch{/* Never log authentication. */}
    this.send({type:'secrets',values:this.secretValues!().filter(v=>v.length>=8 && v.length<=16000).slice(0,128)});
    const screen=this.screen(),now=this.deps.now?.() ?? Date.now();
    if(this.current.lease.agent.runner==='claude' && screen.login) {
      this.send({type:'error',message:tx('Claude girişi yapılmamış — çalıştırıcıda claude girişi gerekli. Ayrı hesap için: {0}',[claudeLoginCommand(this.config.workDir)])});this.stop();return;
    }
    if(this.current.lease.agent.runner==='claude' && this.attachment && now>=this.attachment.readyAt && screen.onboarding) {
      this.attachReady();this.send({type:'status',status:'waiting',idleConfirmed:false,usageKnown:false});return;
    }
    if(screen.restricted){
      this.idleConfirmed=false;this.turnFinished=false;
      // Separate selection from confirmation: the boot UI can lose keys sent
      // during its first paint. Enter is allowed only with option 1 selected.
      if(!this.inputDirty && this.restrictedSelectionPending && now-this.restrictedAt>=250 && screen.restrictedSelected){
        this.restrictedAt=now;this.restrictedSelectionPending=false;this.accessOpened=this.deps.tmux(['-S',this.current.socket,'send-keys','-t',this.current.name,'Enter'],prepareEnv(this.current.profile))===0;
      }else if(!this.inputDirty && now-this.restrictedAt>=3000){
        this.restrictedAt=now;this.restrictedSelectionPending=this.deps.tmux(['-S',this.current.socket,'send-keys','-t',this.current.name,screen.restrictedQuitSelected?'Up':'1'],prepareEnv(this.current.profile))===0;
      }
      this.send({type:'status',status:'waiting',idleConfirmed:false});return;
    }
    if(screen.folderAccess){this.idleConfirmed=false;this.send({type:'status',status:'waiting',idleConfirmed:false});return;}
    const rollout=providerRollout(this.current.profile,this.current.lease.agent.runner);
    const liveTurn=rollout?.events.some(e=>['task_started','task_complete','turn_aborted'].includes(e.type) && Date.parse(e.timestamp)>=this.metadataFloor);
    if(this.attachment && now>=this.attachment.readyAt && (this.accessOpened || liveTurn || this.current.lease.agent.runner==='claude' && screen.main) && (screen.empty || rollout && screen.main))this.attachReady();
    if(!rollout){this.idleConfirmed=false;this.send({type:'status',status:Date.now()-this.lastOutputAt<5000?'working':'waiting',idleConfirmed:false,usageKnown:false});return;}
    const state=join(this.config.workDir,'.terminal-control',`${this.current.name}.state.json`);
    writeTerminalJson(state,{provider_id:rollout.id});
    for(const event of rollout.events){
      const id=createHash('sha256').update(rollout.id+JSON.stringify(event)).digest('hex');
      const historical=!Number.isFinite(Date.parse(event.timestamp)) || Date.parse(event.timestamp)<this.metadataFloor;
      if(historical && event.type!=='token_count'){this.seen.add(id);continue;}
      if(event.type==='token_count'){
        const raw=event.info?.total_token_usage;
        if(raw && typeof raw.input_tokens==='number' && typeof raw.output_tokens==='number')this.send({type:'usage',session:rollout.id,total:{input_tokens:raw.input_tokens,cached_input_tokens:raw.cached_input_tokens || 0,output_tokens:raw.output_tokens},lastInput:event.info?.last_token_usage?.input_tokens});
      }else if(event.type==='native_call'){
        if(!this.seen.has(id)){this.send({type:'call',event:id,name:event.name});this.seen.add(id);}
      }else if(!this.seen.has(id)){
        this.turnFinished=event.type!=='task_started';
        this.send({type:'turn',event:id,state:event.type==='task_started'?'started':event.type==='task_complete'?'completed':'failed',text:event.type==='task_complete'?new TerminalRedactor(this.secretValues!).push(String(event.last_agent_message || ''),true).slice(0,3000):''});this.seen.add(id);
      }
    }
    const lastTurn=rollout.events.filter(e=>['task_started','task_complete','turn_aborted'].includes(e.type)).at(-1);
    this.idleConfirmed=this.turnFinished && screen.empty && !this.inputDirty && lastTurn?.type!=='task_started';
    this.send({type:'status',status:lastTurn?.type==='task_started'?'working':'waiting',idleConfirmed:this.idleConfirmed,usageKnown:rollout.events.some(e=>e.type==='token_count' && e.info?.total_token_usage)});
    if(this.seen.size>2000)this.seen=new Set([...this.seen].slice(-1000));
  }
  resetIdle(agents:string[]):boolean {
    this.resetPaused=true;
    const control=join(this.config.workDir,'.terminal-control');
    const sessions=new Map<string,{socket:string;name:string;profile:string}>();
    // A prior stop message may already have detached `current`. Also inspect
    // persisted supervisors, including a session left by a restarted runner.
    if(existsSync(control)){
      if(lstatSync(control).isSymbolicLink() || realpathSync(control)!==resolve(control))return false;
      for(const entry of readdirSync(control)){
        const match=/^gm-([a-f0-9-]{36})-(\d+)\.alive$/.exec(entry);
        if(match && agents.includes(match[1])){
          const name=entry.slice(0,-'.alive'.length);
          sessions.set(name,{name,socket:join(control,'tmux.sock'),profile:join(this.config.workDir,'.terminal',match[1],match[2])});
        }
      }
    }
    const current=this.current;
    if(current && agents.includes(current.lease.agent.id)){
      this.detach();sessions.set(current.name,current);
    }
    let idle=true;
    for(const session of sessions.values()){
      const env=prepareEnv(session.profile);
      this.deps.tmux(['-S',session.socket,'kill-session','-t',session.name],env);
      if(this.deps.tmux(['-S',session.socket,'has-session','-t',session.name],env)!==1)idle=false;
    }
    if(idle && current && agents.includes(current.lease.agent.id))this.current=undefined;
    return idle;
  }
  resumeAfterReset(){this.resetPaused=false;}
  private detach(){if(this.monitor)clearInterval(this.monitor);this.monitor=undefined;this.attachment=undefined;const handle=this.attach;this.attach=undefined;handle?.kill();}
  stop(){this.detach();if(this.current){if(this.current.lease.agent.runner==='claude')try{retainAuth(this.config.workDir,'claude',this.current.profile,this.current.initialAuth);}catch{/* Keep the previous dedicated authentication. */}this.deps.tmux(['-S',this.current.socket,'kill-session','-t',this.current.name],prepareEnv(this.current.profile));this.current=undefined;}}
  shutdown(){this.closing=true;this.stop();this.ws?.close();this.ws=undefined;}
}
function prepareEnv(profile:string){return {PATH:process.env.PATH,HOME:profile,LANG:'C.UTF-8'};}
