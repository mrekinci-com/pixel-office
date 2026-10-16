import { existsSync,lstatSync,readdirSync,openSync,readSync,closeSync,constants } from 'node:fs';
import { join } from 'node:path';
export interface RolloutMetadata {id:string;path:string;events:any[];}
// Inspect only the dedicated GM profile. Read one bounded tail and export numeric
// usage, lifecycle/call metadata and the final answer (redacted before forwarding).
export function terminalRollout(profile:string,id?:string,after=0):RolloutMetadata|undefined {
  const root=join(profile,'codex','sessions');
  for(const p of [profile,join(profile,'codex'),root])if(!existsSync(p) || lstatSync(p).isSymbolicLink())return;
  let visited=0,truncated=false,candidate:{path:string;size:number;mtime:number;id?:string}|undefined;
  const visit=(dir:string,depth:number)=>{
    if(depth>6 || visited>2000)return;
    for(const e of readdirSync(dir,{withFileTypes:true})){
      if(++visited>2000){truncated=true;return;}
      if(e.isSymbolicLink())continue;const path=join(dir,e.name);
      if(e.isDirectory()){visit(path,depth+1);continue;}
      if(!e.isFile() || !e.name.endsWith('.jsonl') || (id && !e.name.includes(id)))continue;
      const stat=lstatSync(path);if(stat.mtimeMs<after || stat.mtimeMs<(candidate?.mtime || 0))continue;
      candidate={path,size:stat.size,mtime:stat.mtimeMs,id:e.name.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i)?.[0]};
    }
  };
  try{
    visit(root,0);if(truncated || !candidate)return;
    const {path,size:total}=candidate,bytes=Math.min(total,1024*1024),buffer=Buffer.alloc(bytes),fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{readSync(fd,buffer,0,bytes,total-bytes);}finally{closeSync(fd);}
    const lines=buffer.toString('utf8').split('\n');if(total>bytes)lines.shift();
    // UUID in the rollout filename remains available even if the metadata header
    // contains long instructions or has rotated beyond the bounded tail.
    let provider=id || candidate.id;const events:any[]=[];
    for(const line of lines)try{
      const v=JSON.parse(line);
      if(v.type==='session_meta' && /^[a-f0-9-]{36}$/.test(v.payload?.id))provider=v.payload.id;
      else if(v.type==='response_item' && ['function_call','custom_tool_call'].includes(v.payload?.type) && typeof v.payload?.name==='string' && !v.payload.name.includes('mcp__ofis__'))events.push({timestamp:v.timestamp,type:'native_call',name:v.payload.name.slice(0,120),call_id:v.payload.call_id});
      else if(v.type==='event_msg' && ['token_count','task_started','task_complete','turn_aborted'].includes(v.payload?.type))events.push({timestamp:v.timestamp,...v.payload});
    }catch{/* Incomplete trailing line is picked up on the next observation. */}
    if(provider && /^[a-f0-9-]{36}$/.test(provider))return {id:provider,path,events};
  }catch{/* Missing or rotated data is explicitly unknown; no usage estimate. */}
}
