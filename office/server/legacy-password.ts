// Local operator tool only; no HTTP/MCP route or Docker privileges.
import { spawn } from 'node:child_process';
import type { Office } from './service.js';
import { Problem } from './service.js';
import { encrypt,newKey } from './security.js';
type AccountPassword={id:string;email:string;password:string};
const backendScript=`
const fs=require('fs');
(async()=>{
 let sequelize;
 try {
  const input=JSON.parse(fs.readFileSync(0,'utf8'));
  if(!/^[0-9]+$/.test(input.id) || typeof input.email!=='string' || typeof input.password!=='string' || input.password.length<32)throw Error();
  const models=require('/app/backend/models');sequelize=models.sequelize;
  const user=await models.User.findByPk(input.id,{logging:false});
  const role=await models.Role.findOne({where:{user_id:input.id},logging:false});
  if(!user || user.email!==input.email || !role || role.is_admin)throw Error();
  await user.update({password_digest:await models.User.hashPassword(input.password)},{logging:false});
  process.stdout.write('OFIS_HESAP_HAZIR\\n');
 }catch{process.exitCode=1;}
 finally{if(sequelize)await sequelize.close();}
})();`;
export async function updateLocalAgentPassword(account:AccountPassword) {
  await new Promise<void>((resolve,reject)=>{
    const child=spawn('docker',['exec','-i','pixel-office-tududi','node','-e',backendScript],{stdio:['pipe','pipe','ignore']});
    let output='',ended=false;
    const fail=()=>{if(ended)return;ended=true;clearTimeout(timer);child.kill('SIGKILL');reject(new Problem(503,'Yerel ajan hesabı hazırlanamadı. Kapsayıcı adını ve işletmeci yetkisini kontrol edin.'));};
    const timer=setTimeout(fail,15000);
    child.stdin.on('error',fail);child.on('error',fail);
    child.stdout.on('data',b=>{output+=b.toString();if(output.length>20000)fail();});
    child.on('close',code=>{if(ended)return;if(code!==0 || !output.includes('OFIS_HESAP_HAZIR\n')){fail();return;}ended=true;clearTimeout(timer);resolve();});
    // Pass the password only through child stdin, never arguments, output or files.
    child.stdin.end(JSON.stringify(account));
  });
}
export async function prepareLegacyPassword(office:Office,id:string,update=updateLocalAgentPassword) {
  if(office.config.tududiUrl!=='http://127.0.0.1:9393')throw new Problem(400,office.t('Yerel hazırlama yalnız ajanların 9393 Tududi kopyasında kullanılabilir.'));
  const agent=office.agent(id),row=office.store.db.prepare('SELECT tududi_password_encrypted FROM agents WHERE id=?').get(id)!;
  if(row.tududi_password_encrypted)return {prepared:false};
  if(!agent.tududi_user_id || await office.tududi.findUser(agent.tududi_email)!==agent.tududi_user_id)throw new Problem(409,office.t('Ajanın hesabı doğrulanamadı; hiçbir şifre değiştirilmedi.'));
  const password=newKey();await update({id:agent.tududi_user_id,email:agent.tududi_email,password});
  await office.tududi.login(agent.tududi_email,password);
  office.store.db.prepare('UPDATE agents SET tududi_password_encrypted=? WHERE id=?').run(encrypt(password,office.config.secretKey,id),id);
  office.event(id,'tududi_password_prepared',office.t('İşletmeci eski ajan hesabının girişini hazırladı; görevler ve notlar korundu.'));
  return {prepared:true};
}
