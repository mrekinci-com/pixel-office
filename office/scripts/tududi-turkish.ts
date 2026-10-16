// Use only the separate agent instance on 9393. Never print credentials.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../server/config.js';
import { TududiClient } from '../server/tududi.js';
import { decrypt } from '../server/security.js';
const env = {...process.env,...parseEnv(readFileSync(resolve('.env'),'utf8'))};
const config = loadConfig({...env,OFIS_DATA_DIR:resolve('data'),TUDUDI_BASE_URL:'http://127.0.0.1:9393'});
const db = new DatabaseSync(resolve(config.dataDir,'ofis.sqlite'),{readOnly:true});
try {
  const settings=JSON.parse(String(db.prepare('SELECT json FROM runtime_settings WHERE id=1').get()?.json || '{}'));
  const timeZone=settings.timeZone || 'Europe/Istanbul', client=new TududiClient(config);
  const agents=db.prepare("SELECT id,tududi_token_encrypted FROM agents WHERE tududi_state='ready'").all();
  let changed=0;
  for(const agent of agents) {
    const token=decrypt(String(agent.tududi_token_encrypted),config.secretKey,String(agent.id));
    const profile=await client.profile(token);
    if(profile.language!=='tr' || profile.timezone!==timeZone) {await client.localizeProfile(token,timeZone);changed++;}
    const verified=await client.profile(token);
    if(verified.language!=='tr' || verified.timezone!==timeZone)throw new Error("Could not verify the Turkish profile setting.");
  }
  console.log(`Verified Turkish and the Office timezone for ${agents.length} agent accounts; updated ${changed} accounts.`);
} catch {
  console.error("Profile update failed; check connectivity and local settings.");
  process.exitCode=1;
} finally {db.close();}
