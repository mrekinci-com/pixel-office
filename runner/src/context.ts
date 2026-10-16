import {existsSync,readdirSync,lstatSync,openSync,readSync,closeSync,constants} from 'node:fs';
import {join} from 'node:path';
// Codex exec stdout exposes a whole-turn aggregate. Its dedicated session rollout
// exposes token_count.info.last_token_usage for the last individual request.
// Read only this lease's profile and return numeric metadata, never conversation text.
export function codexContextInput(profile:string,sessionId:string|null|undefined,startedAt:number):number|undefined {
  if(!sessionId || !/^[a-zA-Z0-9-]{1,100}$/.test(sessionId))return;
  const root=join(profile,'codex','sessions');
  for(const path of [profile,join(profile,'codex'),root]){if(!existsSync(path) || lstatSync(path).isSymbolicLink())return;}
  let visited=0,result:number|undefined,latest=0;
  const visit=(dir:string,depth:number)=>{
    if(depth>6 || ++visited>1000 || !existsSync(dir) || lstatSync(dir).isSymbolicLink())return;
    for(const entry of readdirSync(dir,{withFileTypes:true})){
      if(entry.isSymbolicLink())continue;
      const path=join(dir,entry.name);
      if(entry.isDirectory()){visit(path,depth+1);continue;}
      if(!entry.isFile() || !entry.name.endsWith('.jsonl') || !entry.name.includes(sessionId))continue;
      const stat=lstatSync(path);if(stat.mtimeMs<startedAt || stat.mtimeMs<latest)continue;
      const bytes=Math.min(stat.size,1024*1024),offset=stat.size-bytes,buffer=Buffer.alloc(bytes),fd=openSync(path,constants.O_RDONLY | constants.O_NOFOLLOW);
      try{readSync(fd,buffer,0,bytes,offset);}finally{closeSync(fd);}
      const lines=buffer.toString('utf8').split('\n');if(offset)lines.shift();
      for(const line of lines){
        if(!line.includes('token_count'))continue;
        try{const event=JSON.parse(line),payload=event.payload || event;
          const timestamp=Date.parse(event.timestamp);
          if(!Number.isFinite(timestamp) || timestamp<startedAt)continue;
          if(payload.type!=='token_count')continue;
          const value=payload.info?.last_token_usage?.input_tokens;
          if(typeof value==='number' && Number.isFinite(value) && value>=0){result=value;latest=stat.mtimeMs;}
        }catch{/* Partial rollout line; the next completed event can supply it. */}
      }
    }
  };
  try{visit(root,0);}catch{/* Missing/rotated rollout leaves context size unknown. */}
  return result;
}
