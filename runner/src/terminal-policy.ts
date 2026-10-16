import { t as tx } from "./i18n.js";
import {mkdirSync,existsSync,lstatSync,realpathSync} from 'node:fs';
import {writeTerminalText} from './terminal-state.js';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import type {Lease} from '../../office/shared/runtime.js';
import type {RunnerConfig} from './config.js';
import {isolate,verifyShell,type Command} from './command.js';
const deniedExit=73;
const deniedMarker='OFIS_TERMINAL_PROFILE_DENIED';
// Codex 0.159.1 falls back to the managed default for a disallowed -P name.
// /usr/bin/true therefore cannot prove rejection: test the forbidden abilities.
export function terminalPermissionProbe(command:Command,profile:string,negative:boolean):Command {
  const script=`import socket,errno,os,sys
for family,kind in [(socket.AF_INET,socket.SOCK_STREAM),(socket.AF_INET6,socket.SOCK_STREAM),(socket.AF_INET,socket.SOCK_DGRAM)]:
 try:
  s=socket.socket(family,kind)
  s.close()
  raise SystemExit(0)
 except OSError as e:
  if e.errno not in (errno.EPERM,errno.EACCES): raise SystemExit(74)
try:
 fd=os.open(${JSON.stringify(join(profile,'terminal-policy','requirements.toml'))},os.O_RDONLY)
 os.close(fd)
 raise SystemExit(0)
except OSError as e:
 if e.errno not in (errno.EPERM,errno.EACCES,errno.ENOENT): raise SystemExit(74)
print("${deniedMarker}",file=sys.stderr)
raise SystemExit(${deniedExit})`;
  return {...command,args:['sandbox','--include-managed-config','-P',negative?':danger-full-access':'ofis','-C',command.cwd,'--',...(negative?['/usr/bin/python3','-c',script]:['/usr/bin/true'])]};
}
export function terminalVersionSupported(output:string){const m=/codex(?:-cli)?\s+(\d+)\.(\d+)\.(\d+)/i.exec(output);return !!m && (Number(m[1])>0 || Number(m[2])>=138);}
export function writeTerminalPolicy(command:Command,profile:string){
  const definition=command.args.find(arg=>arg.startsWith('permissions='));if(!definition)throw new Error(tx("Terminal izin tanımı bulunamadı."));
  const dir=join(profile,'terminal-policy');mkdirSync(dir,{recursive:true,mode:0o700});
  if(lstatSync(dir).isSymbolicLink() || realpathSync(dir)!==resolve(dir))throw new Error(tx("Terminal izin yolu kullanılamıyor."));
  const path=join(dir,'requirements.toml');if(existsSync(path) && lstatSync(path).isSymbolicLink())throw new Error(tx("Terminal izin dosyası kullanılamıyor."));
  writeTerminalText(path,`default_permissions = "ofis"\nallowed_permission_profiles = {ofis=true}\nallowed_approval_policies = ["never"]\nallowed_web_search_modes = []\n${definition}\n[features]\nplugins = false\nremote_plugin = false\napps = false\nhooks = false\nbrowser_use = false\ncomputer_use = false\nimage_generation = false\nmulti_agent = false\nmemories = false\n`);
}
export function verifyTerminal(command:Command,c:RunnerConfig,l:Lease,profile:string){
  const version=spawnSync(command.bin,['--version'],{env:command.env,cwd:command.cwd,encoding:'utf8',timeout:5000,maxBuffer:16000});
  if(version.status!==0 || !terminalVersionSupported(version.stdout))throw new Error(tx("Etkileşimli terminal için Codex 0.138 veya üstü gerekiyor."));
  verifyShell(command,c,l,profile);
  // Both probes load the actual read-only managed file, with no CLI policy copy.
  const positive=isolate(terminalPermissionProbe(command,profile,false),c,l,profile);
  const allowed=spawnSync(positive.bin,positive.args,{env:positive.env,cwd:positive.cwd,encoding:'utf8',timeout:10000,maxBuffer:16000});
  if(allowed.status!==0 || allowed.error || allowed.signal)throw new Error(tx("Terminalin güvenli izin profili doğrulanamadı; güvenlik için oturum açılmadı."));
  const negative=isolate(terminalPermissionProbe(command,profile,true),c,l,profile);
  const result=spawnSync(negative.bin,negative.args,{env:negative.env,cwd:negative.cwd,encoding:'utf8',timeout:10000,maxBuffer:16000});
  if(result.status!==deniedExit || result.error || result.signal || !result.stderr.split('\n').includes(deniedMarker))throw new Error(tx("Terminal izin kilidi doğrulanamadı; güvenlik için oturum açılmadı."));
}
