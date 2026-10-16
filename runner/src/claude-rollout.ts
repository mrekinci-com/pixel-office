import { existsSync,lstatSync,readdirSync,openSync,readSync,closeSync,constants,fstatSync } from 'node:fs';
import { join } from 'node:path';
import { terminalRollout, type RolloutMetadata } from './terminal-rollout.js';
import { validTerminalId } from './terminal-state.js';
import { usageTotals } from '../../office/shared/runtime.js';
function boundedRead(path:string,limit:number):string|undefined {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=fstatSync(fd);if(!stat.isFile() || stat.nlink!==1 || stat.size>limit)return;
    const buffer=Buffer.alloc(stat.size);readSync(fd,buffer,0,buffer.length,0);return buffer.toString('utf8');
  } finally {closeSync(fd);}
}
// Claude transcripts hold per-message usage, not cumulative tail totals. Read a
// bounded complete file; a larger file is unknown instead of a partial charge.
export function claudeRollout(profile:string,id?:string,after=0):RolloutMetadata|undefined {
  const root=join(profile,'claude','projects');
  for(const path of [profile,join(profile,'claude')])if(!existsSync(path) || lstatSync(path).isSymbolicLink())return;
  let visited=0,candidate:{path:string;id:string;mtime:number}|undefined;
  try {
    const idFile=join(profile,'claude','terminal-session.json');
    if(!id && existsSync(idFile)){
      const raw=boundedRead(idFile,1000);if(!raw)return;
      id=JSON.parse(raw).provider_id;if(!validTerminalId(id))return;
    }
    if(existsSync(root)){
      if(lstatSync(root).isSymbolicLink())return;
      for(const dir of readdirSync(root,{withFileTypes:true})){
        if(++visited>2000)return;
        if(!dir.isDirectory() || dir.isSymbolicLink())continue;
        for(const entry of readdirSync(join(root,dir.name),{withFileTypes:true})){
          if(++visited>2000)return;
          const provider=entry.name.replace(/\.jsonl$/,'');
          if(!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.jsonl') || !validTerminalId(provider) || id && id!==provider)continue;
          const path=join(root,dir.name,entry.name),stat=lstatSync(path);
          if(stat.nlink!==1 || stat.mtimeMs<after || stat.mtimeMs<(candidate?.mtime || 0))continue;
          candidate={path,id:provider,mtime:stat.mtimeMs};
        }
      }
    }
    const journal=join(profile,'claude-terminal-events.jsonl');let lifecycle:any[]=[];
    if(existsSync(journal)){
      const raw=boundedRead(journal,2*1024*1024);if(!raw)return;
      for(const line of raw.split('\n'))try {
        const v=JSON.parse(line);
        if(validTerminalId(v.session_id) && (!id || v.session_id===id) && ['task_started','task_complete'].includes(v.type)){
          id ||= v.session_id;
          lifecycle.push({type:v.type,timestamp:v.timestamp,uuid:v.uuid,...(v.type==='task_complete'?{last_agent_message:String(v.last_agent_message || '').slice(0,3000)}:{})});
        }
      } catch { /* incomplete journal append is retried next time */ }
    }
    const provider=candidate?.id || id;if(!provider || !candidate && !lifecycle.length)return;
    const events:any[]=[...lifecycle],messages=new Map<string,Record<string,number>>();let lastInput:number|undefined;
    const text=candidate?boundedRead(candidate.path,8*1024*1024):undefined;
    for(const line of (text || '').split('\n'))try {
      const value=JSON.parse(line);
      if(value.sessionId && value.sessionId!==provider)continue;
      const timestamp=value.timestamp;
      if(!lifecycle.length && value.type==='user' && typeof value.message?.content==='string')events.push({type:'task_started',timestamp,uuid:value.uuid});
      if(value.type!=='assistant' || !value.message)continue;
      const message=value.message,contents=message.content || [];
      if(message.usage && typeof message.usage.input_tokens==='number' && typeof message.usage.output_tokens==='number' && message.id){
        const numeric=Object.fromEntries(Object.entries(message.usage).filter(([,n])=>typeof n==='number' && Number.isFinite(n) && n>=0)) as Record<string,number>;
        const previous=messages.get(message.id) || {};
        messages.set(message.id,Object.fromEntries(Object.keys({...previous,...numeric}).map(key=>[key,Math.max(previous[key] || 0,numeric[key] || 0)])));
        lastInput=usageTotals(messages.get(message.id)!).input_tokens;
      }
      for(const block of contents)if(block.type==='tool_use' && typeof block.name==='string' && !block.name.startsWith('mcp__ofis__'))events.push({type:'native_call',timestamp,name:block.name.slice(0,120),call_id:block.id});
      if(!lifecycle.length && ['end_turn','stop_sequence'].includes(message.stop_reason))events.push({type:'task_complete',timestamp,uuid:value.uuid,last_agent_message:contents.filter((b:any)=>b.type==='text').map((b:any)=>b.text || '').join('\n')});
    } catch { /* incomplete lines never become completion or usage evidence */ }
    events.sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
    if(messages.size){
      const total={input_tokens:0,cached_input_tokens:0,output_tokens:0};
      for(const usage of messages.values()){const v=usageTotals(usage);total.input_tokens+=v.input_tokens;total.cached_input_tokens+=v.cached_input_tokens;total.output_tokens+=v.output_tokens;}
      events.push({type:'token_count',info:{total_token_usage:total,last_token_usage:{input_tokens:lastInput}},timestamp:new Date(candidate!.mtime).toISOString()});
    }
    return {id:provider,path:candidate?.path || journal,events};
  } catch {return;}
}
export function providerRollout(profile:string,runner:'codex'|'claude',id?:string,after=0){return runner==='claude'?claudeRollout(profile,id,after):terminalRollout(profile,id,after);}
