import { t as tx } from './i18n.js';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Lease } from '../../office/shared/runtime.js';
import type { Command } from './command.js';
import { writeTerminalJson } from './terminal-state.js';
export const CLAUDE_MANAGED_DIR = '/etc/claude-code';
export const CLAUDE_NATIVE_TOOLS = 'Read,Edit,Write';
export const CLAUDE_DENIED_TOOLS = ['Bash','PowerShell','WebFetch','WebSearch','Agent','Task','Skill','NotebookEdit','Grep','Glob','Cd'];
export interface ClaudeFiles { profile: string; work: string; roots: { path: string; write: boolean }[]; terminal?: boolean; }
const within = (root:string,path:string) => path===root || path.startsWith(root+sep);
const absoluteRule = (path:string) => {
  if (!path.startsWith('/') || /[\x00-\x1f,*?\[\](){}\\]/.test(path)) throw new Error(tx('Claude izin yolu kullanılamıyor.'));
  return '/'+path;
};
export function claudePolicy(files:ClaudeFiles, chat=false) {
  const protectedPaths=[files.profile, '/proc', '/etc', '/opt'];
  const deny=[...CLAUDE_DENIED_TOOLS,...protectedPaths.flatMap(path=>['Read','Edit'].flatMap(tool=>[`${tool}(${absoluteRule(path)})`,`${tool}(${absoluteRule(path)}/**)`]))];
  if(chat)deny.push('Read','Edit','Write');
  // Both native deny rules and a managed hook protect the CLI's own readable
  // credentials/MCP files. The hook also rejects symlink and hard-link aliases.
  const compiled=import.meta.url.endsWith('/dist/runner/src/claude-policy.js');
  const guard=fileURLToPath(new URL(compiled?'./claude-guard.js':'../dist/runner/src/claude-guard.js',import.meta.url));
  const observer=fileURLToPath(new URL(compiled?'./claude-observer.js':'../dist/runner/src/claude-observer.js',import.meta.url));
  const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`;
  return {
    allowManagedPermissionRulesOnly:true, allowManagedHooksOnly:true, disableAllHooks:false,
    autoMemoryEnabled:false, enableAllProjectMcpServers:false,
    allowedMcpServers:[{serverName:'ofis'}],
    permissions:{defaultMode:'dontAsk',disableBypassPermissionsMode:'disable',disableAutoMode:'disable',blockReadsOutsideWorkingDirectories:true,
      additionalDirectories:files.roots.filter(r=>r.path!==files.work).map(r=>r.path),
      allow:['mcp__ofis__*',...(!chat?files.roots.flatMap(root=>[`Read(${absoluteRule(root.path)}/**)`,...(root.write?[`Edit(${absoluteRule(root.path)}/**)`]:[])]):[])],deny},
    hooks:{PreToolUse:[{matcher:'Read|Edit|Write',hooks:[{type:'command',command:`${quote(process.execPath)} ${quote(guard)} ${quote(join(files.profile,'claude-files.json'))} || exit 2`,timeout:10}]}],
      ...(files.terminal?Object.fromEntries(['UserPromptSubmit','Stop'].map(event=>[event,[{hooks:[{type:'command',command:`${quote(process.execPath)} ${quote(observer)} ${quote(files.profile)}`,timeout:5}]}]])):{}),
    },
  };
}
export function writeClaudePolicy(profile:string,work:string,lease:Lease,links:Lease['links'],terminal=false) {
  const files:ClaudeFiles={profile,work,terminal,roots:[{path:work,write:lease.policy.permission!=='chat'},...links.map(l=>({path:l.path,write:l.access==='write' && !l.approved_write}))]};
  const dir=join(profile,'claude-policy');mkdirSync(dir,{recursive:true,mode:0o700});
  if(lstatSync(dir).isSymbolicLink() || realpathSync(dir)!==resolve(dir))throw new Error(tx('Claude izin yolu kullanılamıyor.'));
  writeTerminalJson(join(profile,'claude-files.json'),files);
  writeTerminalJson(join(dir,'managed-settings.json'),claudePolicy(files,lease.policy.permission==='chat'));
}
export function verifyClaudePolicy(command:Command,profile:string) {
  const files=JSON.parse(readFileSync(join(profile,'claude-files.json'),'utf8')) as ClaudeFiles;
  const path=join(profile,'claude-policy','managed-settings.json');
  if(lstatSync(path).isSymbolicLink() || lstatSync(path).nlink!==1)throw new Error(tx('Claude izin kilidi doğrulanamadı.'));
  const policy=JSON.parse(readFileSync(path,'utf8'));
  if(files.profile!==profile || files.work!==command.cwd || JSON.stringify(policy)!==JSON.stringify(claudePolicy(files,command.args[command.args.indexOf('--tools')+1]==='')))throw new Error(tx('Claude izin kilidi doğrulanamadı.'));
  const option=(name:string)=>command.args[command.args.indexOf(name)+1];
  const native=option('--tools');
  if(!['',CLAUDE_NATIVE_TOOLS].includes(native) || option('--mcp-config')!==join(profile,'mcp.json') || option('--setting-sources')!=='' || option('--disallowedTools')!==policy.permissions.deny.join(',') || !command.args.includes('--restricted') || !command.args.includes('--strict-mcp-config') || option('--permission-mode')!=='dontAsk')throw new Error(tx('Claude izin kilidi doğrulanamadı.'));
  for(const flag of ['--dangerously-skip-permissions','--allow-dangerously-skip-permissions'])if(command.args.includes(flag))throw new Error(tx('Claude izin kilidi doğrulanamadı.'));
}
export function verifyClaude(command:Command,_config:unknown,_lease:Lease,profile:string) {
  verifyClaudePolicy(command,profile);
  // Only help/version: no authentication, model request or user's personal home.
  const opts={env:command.env,cwd:command.cwd,encoding:'utf8' as const,timeout:5000,maxBuffer:64000};
  const version=spawnSync(command.bin,['--version'],opts), help=spawnSync(command.bin,['--help'],opts);
  const match=/(\d+)\.(\d+)\.(\d+) \(Claude Code\)/.exec(version.stdout || '');
  if(version.status!==0 || !match || Number(match[1])<2 || Number(match[1])===2 && Number(match[2])===1 && Number(match[3])<285 || Number(match[1])===2 && Number(match[2])<1)throw new Error(tx('Claude Code 2.1.285 veya üstü gerekiyor.'));
  const flags=new Set(['--restricted','--strict-mcp-config','--permission-mode','--tools','--disallowedTools','--session-id','--resume','--effort',...command.args.filter(arg=>arg.startsWith('--'))]);
  for(const flag of flags){
    const documented=help.stdout.includes(flag) || flag==='--append-system-prompt-file' && help.stdout.includes('--append-system-prompt[-file]');
    if(help.status!==0 || !documented)throw new Error(tx('Claude komut seçenekleri bu sürümle uyumlu değil.'));
  }
}
// A real PreToolUse decision; no file content is opened. Relative traversal,
// symlinked parents, hard-linked files and hidden settings aliases fail closed.
export function claudeFileAllowed(files:ClaudeFiles,tool:string,input:Record<string,unknown>):boolean {
  if(!['Read','Edit','Write'].includes(tool) || typeof input.file_path!=='string')return false;
  const path=resolve(files.work,input.file_path),write=tool!=='Read';
  if(within(files.profile,path) || !files.roots.some(root=>within(root.path,path) && (!write || root.write)))return false;
  if(path.split(sep).some(piece=>['.claude','.codex','.agents','.config','.git','.mcp.json','.env','CLAUDE.md','CLAUDE.local.md'].includes(piece) || piece.startsWith('.env.')))return false;
  if(write && [join(files.work,'gelen'),join(files.work,'dizin-haritasi')].some(root=>within(root,path)))return false;
  let current='/';
  try {
    const pieces=path.split(sep).filter(Boolean);
    for(let i=0;i<pieces.length;i++){
      current=join(current,pieces[i]);
      if(!existsSync(current)) { try{lstatSync(current);return false;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return false;} return write; }
      const stat=lstatSync(current);
      if(stat.isSymbolicLink() || i<pieces.length-1 && !stat.isDirectory() || stat.isFile() && stat.nlink!==1)return false;
    }
    return lstatSync(path).isFile();
  } catch {return false;}
}
