// Local audit with real bwrap; no Office/Tududi requests or model calls.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import type {CommandJob} from '../../office/shared/runtime.js';
import {randomUUID} from 'node:crypto';
import type {Agent} from '../../office/shared/types.js';
import {defaultPolicy} from '../../office/shared/runtime.js';
import {approvedWriteSmoke} from '../src/isolation-smoke.js';
import {loadConfig} from '../src/config.js';
import {runCommand} from '../src/command-box.js';

test("A3: real command box checks Node, network namespace, writes, dependencies, timeout and stop",async()=>{
  const root=resolve('.test-data');mkdirSync(root,{recursive:true});
  const directory=mkdtempSync(join(root,'a3-command-live-'));
  try {
    const config={...loadConfig(),allowedRoots:[directory],protectedRoots:[]};
    mkdirSync(join(directory,'node_modules','hazir-deneme'),{recursive:true});
    writeFileSync(join(directory,'ornek.txt'),'deneme');
    writeFileSync(join(directory,'node_modules','hazir-deneme','index.js'),'module.exports="hazır";');
    const job={id:'deneme',run_id:'deneme',agent_id:'deneme',state:'running',exit_code:null,output:'',folder:{path:directory,access:'read',approved_write:false},command:{directory:'.',write:false,command:'',timeout_seconds:10}} as CommandJob;
    const node=(script:string)=>`node -e '${script}'`;
    job.command.command=node('const fs=require("fs"),os=require("os");if(fs.readFileSync("ornek.txt","utf8")!=="deneme" || require("hazir-deneme")!=="hazır")process.exit(2);try{fs.writeFileSync("yasak.txt","x");process.exit(3)}catch(e){if(e.code!=="EROFS" && e.code!=="EACCES")throw e}if(Object.keys(os.networkInterfaces()).some(n=>n!=="lo"))process.exit(4);console.log("OKUMA_GECTI");');
    const read=await runCommand(job,config,[config.key]);
    assert.equal(read.exit_code,0,read.output);assert.match(read.output,/OKUMA_GECTI/);assert.equal(existsSync(join(directory,'yasak.txt')),false);
    job.folder.access='write';job.command.write=true;
    job.command.command=node('const fs=require("fs");fs.writeFileSync("izinli.txt","x");try{fs.writeFileSync("node_modules/yasak.txt","x");process.exit(2)}catch(e){if(e.code!=="EROFS" && e.code!=="EACCES")throw e}console.log("YAZMA_GECTI");');
    const write=await runCommand(job,config,[config.key]);
    assert.equal(write.exit_code,0,write.output);assert.match(write.output,/YAZMA_GECTI/);assert.ok(existsSync(join(directory,'izinli.txt')));assert.equal(existsSync(join(directory,'node_modules','yasak.txt')),false);
    job.command.command=node('setInterval(()=>{},1000)');job.command.timeout_seconds=1;
    const timeout=await runCommand(job,config,[config.key]);
    assert.equal(timeout.exit_code,null,timeout.output);assert.match(timeout.output,/Süre sınırı aşıldı/);
    job.command.timeout_seconds=10;const cancel=new AbortController();
    const timer=setTimeout(()=>cancel.abort(),200);
    try {
      const stop=await runCommand(job,config,[config.key],cancel.signal);
      assert.equal(stop.exit_code,null,stop.output);assert.match(stop.output,/Sahibi çalışmayı durdurdu/);
    }finally{clearTimeout(timer);}
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test("A3.1: real agent box rejects direct approved-folder writes without model calls",()=>{
  const root=resolve('.test-data');mkdirSync(root,{recursive:true});
  const directory=mkdtempSync(join(root,'a3-1-write-live-'));
  try {
    const work=join(directory,'work'),folderPath=join(directory,'onayli');mkdirSync(folderPath);
    const auth=join(directory,'sahte-auth.json');writeFileSync(auth,JSON.stringify({OPENAI_API_KEY:'yalniz-yerel-sonda-sahte-anahtar'}),{mode:0o600});
    const config={...loadConfig(),key:'yalniz-yerel-sonda-anahtari',workDir:work,allowedRoots:[folderPath],protectedRoots:[],codexAuth:auth,claudeAuth:undefined};
    for(const runner of ['codex','claude'] as const) {
      const id=randomUUID(),agent={id,runner,model:runner==='codex' ? 'gpt-6.1-sol' : 'sonnet',effort:'low',policy:{...defaultPolicy,permission:'folders'}} as Agent;
      const folder={id:randomUUID(),name:'Onaylı deneme',path:folderPath,access:'write' as const,approved_write:true,agent_ids:[id],validation:'valid' as const,detail:''};
      if(runner==='codex')assert.doesNotThrow(()=>approvedWriteSmoke({agent,workDir:work,folder},config));
      else assert.throws(()=>approvedWriteSmoke({agent,workDir:work,folder},config),/yalnız sohbet/);
    }
  }finally{rmSync(directory,{recursive:true,force:true});}
});
