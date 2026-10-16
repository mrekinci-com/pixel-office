import { test } from 'node:test';
import { withLanguage } from '../src/i18n.js';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { gitCopies, DirtyWorkspaceError, endingLabel } from '../src/workspace.js';
import type { Lease } from '../../office/shared/runtime.js';
import type { RunnerConfig } from '../src/config.js';
import type { runCommand } from '../src/command-box.js';
for(const reason of ['', 'Token bütçesi aşıldı.', 'Çalışma süresi aşıldı.', 'Ofis çalışmayı durdurdu.', 'Komut satırı çöktü.'])test(`Git record: ${withLanguage("en", () => endingLabel(reason))}`,async()=>{
  mkdirSync(resolve('.test-data'),{recursive:true});const dir=mkdtempSync(resolve('.test-data/git-copy-'));mkdirSync(join(dir,'.git'));
  const lease={run:{id:'run',summary:'Dosyaları düzenle'},agent:{id:'agent',name:"O'kan",tududi_email:'ajan@example.test'},links:[{id:'folder',name:'Kod',path:dir,access:'write',approved_write:false}]} as Lease;
  const commands:string[]=[];let dirty=true;
  const execute:typeof runCommand=async job=>{const cmd=job.command.command;commands.push(cmd);
    if(cmd.includes('commit --no-verify')){assert.ok(cmd.includes(withLanguage("en", () => endingLabel(reason))));assert.ok(cmd.includes("'O'\\''kan'"));dirty=false;return {exit_code:0,output:'Kayıt alındı'};}
    if(cmd.includes('rev-parse'))return {exit_code:0,output:'a'.repeat(40)+'\n'};
    return {exit_code:0,output:cmd.includes('status --porcelain') ? dirty ? ' M app.ts' : '' : 'app.ts | 2 +'};};
  try {
    await assert.rejects(gitCopies(lease,{} as RunnerConfig,false,[],reason,execute),DirtyWorkspaceError);assert.equal(dirty,true);
    const result=await gitCopies(lease,{} as RunnerConfig,true,[],reason,execute);assert.equal(dirty,false);assert.match(result[0],/Kayıt: a{40}/);
    const count=commands.length;await gitCopies(lease,{} as RunnerConfig,true,[],reason,execute);assert.equal(commands.length,count+1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("Git excludes secrets and recording errors; verified cleanup is required",async()=>{
  const dir=mkdtempSync(resolve('.test-data/git-secret-'));mkdirSync(join(dir,'.git'));
  const lease={run:{id:'r',summary:'İş'},agent:{id:'a',name:'Deniz',tududi_email:'a@example.test'},links:[{id:'f',name:'Kod',path:dir,access:'write',approved_write:false}]} as Lease;
  try {
    const secret:typeof runCommand=async()=>({exit_code:0,output:' M .env'});
    await assert.rejects(gitCopies(lease,{} as RunnerConfig,true,[],'',secret),/gizli dosya/);
    const failed:typeof runCommand=async job=>({exit_code:job.command.command.includes('commit --no-verify') ? 1:0,output:' M app.ts'});
    await assert.rejects(gitCopies(lease,{} as RunnerConfig,true,[],'',failed),/Git kaydına alınamadı/);
    const notClean:typeof runCommand=async()=>({exit_code:0,output:' M app.ts'});
    await assert.rejects(gitCopies(lease,{} as RunnerConfig,true,[],'',notClean),/temiz bırakılamadı/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
