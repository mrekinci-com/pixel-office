import { test } from 'node:test';
import { mkdirSync,mkdtempSync,rmSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepare } from '../src/command.js';
import { verifyClaude } from '../src/claude-policy.js';
import { defaultPolicy,type Lease } from '../../office/shared/runtime.js';
import type { RunnerConfig } from '../src/config.js';
// Real installed CLI, but ONLY --version/--help in a new empty dedicated home.
// No .env, personal profile, authentication, model invocation, listener or service.
test("C1: installed Claude Code help/version output covers all generated options",()=>{
 const base=resolve('.test-data');mkdirSync(base,{recursive:true});const dir=mkdtempSync(join(base,'c1-help-'));
 try {
  const config:RunnerConfig={url:'http://127.0.0.1:9401',key:'fake-help-key',workDir:join(dir,'work'),allowedRoots:[],protectedRoots:[],concurrency:1,claude:'claude',codex:'codex',bwrap:'bwrap',codexModel:'test'};
  const lease={run:{id:randomUUID()},agent:{id:randomUUID(),builtin:'director',runner:'claude',model:'sonnet',effort:'high'},key:'fake-help-lease',policy:defaultPolicy,links:[],session:{generation:1,provider_id:null},prompt:'Merhaba.',terminalInstructions:'Yalnız ayrı hesapla çalış.'} as unknown as Lease;
  for(const terminal of [false,true]){const p=prepare(lease,config,terminal);verifyClaude(p.command,config,lease,p.profile);}
 } finally{rmSync(dir,{recursive:true,force:true});}
});
