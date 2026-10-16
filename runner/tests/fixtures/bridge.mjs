import { writeFile, readFile, unlink, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
globalThis.fetch=async(url,init)=>{
 const id=randomUUID(),request=join(process.env.BRIDGE_DIR,id+'.request'),response=join(process.env.BRIDGE_DIR,id+'.response');
 await writeFile(request+'.tmp',JSON.stringify({url,method:init.method || 'GET',headers:init.headers,body:init.body ? JSON.parse(init.body) : undefined}),{mode:0o600});await rename(request+'.tmp',request);
 const until=Date.now()+15000;
 while(Date.now()<until){try{const value=JSON.parse(await readFile(response,'utf8'));await unlink(response);return new Response(JSON.stringify(value.body),{status:value.status,headers:{'content-type':'application/json'}});}catch(e){if(e.code!=='ENOENT')throw e;}await new Promise(r=>setTimeout(r,5));}
 throw new Error("Fake connection timeout.");
};
