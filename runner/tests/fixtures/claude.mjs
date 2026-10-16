#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,mkdirSync,appendFileSync,existsSync } from 'node:fs';
import { dirname,join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const args=process.argv.slice(2);
const flags=['--model','--effort','--restricted','--setting-sources','--strict-mcp-config','--mcp-config','--disable-slash-commands','--no-chrome','--permission-mode','--tools','--allowedTools','--disallowedTools','--append-system-prompt-file','--session-id','--resume','--print','--output-format','--verbose','--include-partial-messages','--permission-prompts','--no-session-persistence'];
if(args.includes('--version')){console.log('2.1.285 (Claude Code)');process.exit(0);}
if(args.includes('--help')){console.log(flags.join('\n'));process.exit(0);}
const booleans=['--restricted','--strict-mcp-config','--disable-slash-commands','--no-chrome','--print','--verbose','--include-partial-messages','--no-session-persistence'];
const options={},positional=[];
for(let i=0;i<args.length;i++){
 if(args[i].startsWith('--')){assert.ok(flags.includes(args[i]),"Invalid CLI option.");options[args[i]]=booleans.includes(args[i])?true:args[++i];}
 else positional.push(args[i]);
}
assert.equal(options['--permission-mode'],'dontAsk');assert.equal(options['--restricted'],true);assert.equal(options['--strict-mcp-config'],true);
assert.ok(['','Read,Edit,Write'].includes(options['--tools']));
assert.ok(options['--disallowedTools'].includes('Bash'));assert.equal(options['--setting-sources'],'');
const profile=dirname(process.env.CLAUDE_CONFIG_DIR),policy=JSON.parse(readFileSync(join(profile,'claude-policy','managed-settings.json'),'utf8'));
assert.equal(policy.permissions.disableBypassPermissionsMode,'disable');assert.equal(policy.allowManagedPermissionRulesOnly,true);
if(process.env.FAKE_CLAUDE_DELEGATE==='1'){
 process.argv=[process.argv[0],process.argv[1],profile,process.env.FAKE_SUMMARY,'claude',process.env.FAKE_RETRY || '0'];
 await import('./fake.mjs');
} else {
 const id=options['--resume'] || options['--session-id'] || randomUUID();
 if(process.env.FAKE_CLAUDE_RECORD)appendFileSync(process.env.FAKE_CLAUDE_RECORD,JSON.stringify({args,id})+'\n');
 if(options['--print']){
  process.stdin.setEncoding('utf8');let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
  if(process.env.FAKE_EXPECT_HASH)assert.equal((await import('node:crypto')).createHash('sha256').update(prompt).digest('hex'),process.env.FAKE_EXPECT_HASH);
  assert.equal(positional.length,0,"Task input must arrive only through stdin.");
  console.log(JSON.stringify({type:'system',subtype:'init',session_id:id}));
  console.log(JSON.stringify({type:'assistant',message:{id:'message-1',content:[{type:'tool_use',name:'Read',input:{file_path:'rapor.txt'}}],usage:{input_tokens:40,cache_read_input_tokens:20,output_tokens:8}}}));
  console.log(JSON.stringify({type:'result',result:'Tamamlandı.',is_error:false,usage:{input_tokens:40,cache_read_input_tokens:20,output_tokens:8}}));
 } else {
  assert.equal(options['--no-session-persistence'],undefined);
  assert.ok(options['--resume'] || positional.length===1);
  const root=join(process.env.CLAUDE_CONFIG_DIR,'projects','fake-work');mkdirSync(root,{recursive:true});
  const path=join(root,id+'.jsonl');
  if(options['--resume'])assert.ok(existsSync(path),"Nonexistent conversations cannot be resumed.");
  const timestamp=new Date().toISOString();
  appendFileSync(path,[{type:'user',sessionId:id,timestamp,uuid:randomUUID(),message:{content:'Merhaba'}},{type:'assistant',sessionId:id,timestamp,uuid:randomUUID(),message:{id:randomUUID(),stop_reason:'end_turn',content:[{type:'text',text:'Hazırım.'}],usage:{input_tokens:40,cache_read_input_tokens:20,output_tokens:8}}}].map(v=>JSON.stringify(v)).join('\n')+'\n');
  for(const name of ['UserPromptSubmit','Stop'])for(const group of policy.hooks[name] || [])for(const hook of group.hooks){
   const result=spawnSync('/bin/sh',['-c',hook.command],{env:process.env,input:JSON.stringify({hook_event_name:name,session_id:id,last_assistant_message:'Hazırım.'}),encoding:'utf8',timeout:2000});
   assert.equal(result.status,0,result.stderr);
  }
  process.stdout.write('Claude Code\r\n❯ \r\n');
 }
}
