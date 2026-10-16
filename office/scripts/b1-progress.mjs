// Only the agents' Tududi copy may be used for project progress.
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
const env=parseEnv(readFileSync('../tududi/.env','utf8')),origin='http://127.0.0.1:9393';
const login=await fetch(origin+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:env.TUDUDI_USER_EMAIL,password:env.TUDUDI_USER_PASSWORD}),redirect:'error'});
if(!login.ok)throw new Error("Agent Tududi progress login failed.");
const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
const response=await fetch(origin+'/api/projects',{headers:{Cookie:cookie},redirect:'error'});
if(!response.ok)throw new Error("Could not read progress projects.");
const data=await response.json(),rows=data.projects || data;
const found=rows.some(project=>project.uid==='u6ngi28gamscp4u');
console.log(JSON.stringify({origin,projectFound:found,writePerformed:false}));
