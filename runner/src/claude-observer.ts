import { appendFileSync,existsSync,lstatSync,readFileSync,realpathSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validTerminalId,writeTerminalText } from './terminal-state.js';
// Managed lifecycle hooks supply positive completion evidence without guessing
// from a painted prompt or a transcript's sometimes-null stop_reason. No user
// prompt, tool arguments or authentication fields are retained here.
try {
  let raw='';for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>200000)throw new Error();}
  const value=JSON.parse(raw),profile=resolve(process.argv[2]);
  if(realpathSync(profile)!==profile || !validTerminalId(value.session_id))throw new Error();
  const type=value.hook_event_name==='UserPromptSubmit'?'task_started':value.hook_event_name==='Stop'?'task_complete':undefined;
  if(!type)throw new Error();
  const path=join(profile,'claude-terminal-events.jsonl');
  if(existsSync(path)){
    const stat=lstatSync(path);if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1)throw new Error();
    if(stat.size>1024*1024)writeTerminalText(path,readFileSync(path,'utf8').split('\n').slice(-501).join('\n'));
  }
  appendFileSync(path,JSON.stringify({session_id:value.session_id,type,timestamp:new Date().toISOString(),uuid:randomUUID(),...(type==='task_complete'?{last_agent_message:String(value.last_assistant_message || '').slice(0,3000)}:{})})+'\n',{mode:0o600});
} catch { /* Unknown lifecycle never establishes idle or invents usage. */ }
