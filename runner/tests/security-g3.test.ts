import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, linkSync, symlinkSync, unlinkSync, chmodSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readSafe, validateFolder } from '../src/files.js';
import { prepare } from '../src/command.js';
import type { RunnerConfig } from '../src/config.js';
import { defaultPolicy, type Lease } from '../../office/shared/runtime.js';
import { TerminalRedactor } from '../../office/shared/terminal-redactor.js';

function fixture() {
  const base=resolve('.test-data'); mkdirSync(base,{recursive:true});
  const dir=mkdtempSync(join(base,'g3-')),allowed=join(dir,'allowed'); mkdirSync(allowed);
  const config:RunnerConfig={url:'http://127.0.0.1:9400',key:'g3-fake-runner-key'.repeat(3),workDir:join(dir,'work'),allowedRoots:[allowed],protectedRoots:[],concurrency:1,claude:'claude',codex:'codex',bwrap:'bwrap',codexModel:'test'};
  const lease={run:{id:randomUUID()},agent:{id:randomUUID(),runner:'codex',model:'test',effort:'low'},policy:defaultPolicy,links:[],key:'g3-fake-lease-key',prompt:'Denetle'} as unknown as Lease;
  return {dir,allowed,config,lease,close:()=>rmSync(dir,{recursive:true,force:true})};
}

test("G3: terminal secrets ending with their own prefix never leak across chunk boundaries",()=>{
  for(const secret of ['abcabcabc','g3-secret-ending-g','1212121212']){
    for(let split=0;split<=secret.length;split++){
      const redactor=new TerminalRedactor(()=>[secret]);
      const output=redactor.push('Selam '+secret.slice(0,split))+redactor.push(secret.slice(split))+redactor.push('\n',true);
      assert.ok(!output.includes(secret));assert.match(output,/gizlendi/);
    }
  }
});

test("G3: hard links cannot deliver or mount files outside the folder",()=>{
  const f=fixture();
  try {
    const outside=join(f.dir,'private.txt'),linked=join(f.allowed,'rapor.txt'); writeFileSync(outside,'yalnız sahte gizli test verisi'); linkSync(outside,linked);
    assert.throws(()=>validateFolder(f.allowed,f.config),/özel dosya/);
    assert.throws(()=>readSafe(f.allowed,'rapor.txt'),/özel dosya/);
    unlinkSync(linked); writeFileSync(linked,'normal dosya');
    assert.equal(readSafe(f.allowed,'rapor.txt').toString(),'normal dosya');
    assert.equal(validateFolder(f.allowed,f.config),f.allowed);
    mkdirSync(join(f.allowed,'alt')); symlinkSync(f.dir,join(f.allowed,'alt','disari'));
    assert.throws(()=>readSafe(f.allowed,'alt/disari/private.txt'));
  } finally { f.close(); }
});

test("G3: protected-root symlinks never expose the real target",()=>{
  const f=fixture();
  try {
    const protectedDir=join(f.allowed,'korunan'),alias=join(f.dir,'korunan-baglanti');mkdirSync(protectedDir);symlinkSync(protectedDir,alias);
    f.config.protectedRoots=[alias];
    assert.throws(()=>validateFolder(protectedDir,f.config),/korunan/);
    assert.throws(()=>validateFolder(f.allowed,f.config),/korunan/);
  } finally { f.close(); }
});

test("G3/C1: Claude file permissions never expose identity/MCP profiles; chat remains tool-free",async()=>{
  const {claudeFileAllowed}=await import('../src/claude-policy.js');
  const f=fixture();
  try {
    f.lease.agent.runner='claude';
    for(const permission of ['workspace','folders'] as const){
      f.lease.policy={...defaultPolicy,permission};
      const p=prepare(f.lease,f.config),files=JSON.parse(readFileSync(join(p.profile,'claude-files.json'),'utf8'));
      assert.equal(p.command.args[p.command.args.indexOf('--tools')+1],'Read,Edit,Write');
      for(const path of ['mcp.json','mcp-links.json','claude/.credentials.json','claude-files.json','claude-policy/managed-settings.json'])
        for(const tool of ['Read','Edit','Write'])assert.equal(claudeFileAllowed(files,tool,{file_path:join(p.profile,path)}),false);
      const policy=JSON.parse(readFileSync(join(p.profile,'claude-policy','managed-settings.json'),'utf8'));
      assert.ok(policy.permissions.deny.includes(`Read(/${p.profile}/**)`));
      assert.equal(policy.permissions.disableBypassPermissionsMode,'disable');
      assert.equal(policy.allowManagedPermissionRulesOnly,true);
    }
    f.lease.policy={...defaultPolicy,permission:'chat'};
    const {command}=prepare(f.lease,f.config);
    assert.equal(command.args[command.args.indexOf('--tools')+1],'');
    assert.equal(command.args[command.args.indexOf('--allowedTools')+1],'mcp__ofis__*');
  } finally { f.close(); }
});

test("G3: file preparation never follows links inside profiles/workspaces",()=>{
  const f=fixture();
  try {
    const first=prepare(f.lease,f.config),outside=join(f.dir,'outside'); mkdirSync(outside);
    const source=join(outside,'keep.txt'); writeFileSync(source,'korunacak');
    const target=join(first.profile,'mcp.json'); unlinkSync(target); symlinkSync(source,target);
    assert.throws(()=>prepare(f.lease,f.config),/ayar dosyası/); assert.equal(readFileSync(source,'utf8'),'korunacak');
    unlinkSync(target); linkSync(source,target);
    assert.throws(()=>prepare(f.lease,f.config),/ayar dosyası/); assert.equal(readFileSync(source,'utf8'),'korunacak');
    unlinkSync(target); writeFileSync(target,'{}',{mode:0o644}); chmodSync(target,0o644);
    prepare(f.lease,f.config); assert.equal(statSync(target).mode&0o777,0o600);
    rmSync(join(first.work,'gelen'),{recursive:true}); symlinkSync(outside,join(first.work,'gelen'));
    assert.throws(()=>prepare(f.lease,f.config),/profil yolu/);
    const alias=join(f.dir,'alias');symlinkSync(outside,alias);f.config.workDir=alias;
    assert.throws(()=>prepare(f.lease,f.config),/profil yolu/);
    assert.equal(existsSync(join(outside,'ofis')),false,"Do not even create directories beneath a symlink.");
  } finally { f.close(); }
});
