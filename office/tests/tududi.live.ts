import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.js";
import {prepareLegacyPassword} from '../server/legacy-password.js';
import { testConfig, cleanup, input } from "./helpers.js";
test("9393: agent → separate account → project/task/note → read → status → cleanup", {timeout:20*60*1000},async () => {
  const config = testConfig();
  const env = parseEnv(readFileSync("../tududi/.env", "utf8"));
  config.tududiAdminEmail = env.TUDUDI_USER_EMAIL || "";
  config.tududiAdminPassword = env.TUDUDI_USER_PASSWORD || "";
  assert.ok(
    config.tududiAdminEmail && config.tududiAdminPassword,
    "Tududi administrator credentials are required for this test.",
  );
  assert.equal(config.tududiUrl, "http://127.0.0.1:9393");
  config.publicOrigin='http://127.0.0.1:9400';config.tududiPublicUrl='http://127.0.0.1:9394';
  const logins = { admin: 0, agent: 0 };
  let retryAt=0;
  const { app, office, store, runtime } = await createApp(config, { background:false,fetcher: async (url, init) => {
    const response=await fetch(url,init);
    if(response.status===429){const seconds=Number(response.headers.get('retry-after'));retryAt=Date.now()+(Number.isFinite(seconds) && seconds>0 ? seconds : 900)*1000;}
    if (response.ok && new URL(String(url)).pathname === "/api/login") {
      const email = JSON.parse(String(init?.body)).email;
      logins[email === config.tududiAdminEmail ? "admin" : "agent"]++;
    }
    return response;
  } });
  let aid: string | undefined;
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      headers: { "x-ofis-islem": "1" },
      payload: { password: config.ownerPassword },
    });
    assert.equal(login.statusCode, 200);
    const headers = {
      cookie: login.headers["set-cookie"]!.toString().split(";")[0],
      "x-ofis-islem": "1",
    };
    const d = await app.inject({
      method: "POST",
      url: "/api/departments",
      headers,
      payload: { name: "Canlı test", color: "#348877" },
    });
    assert.equal(d.statusCode, 201);
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers,
      payload: {...input(d.json().id),username:'staging-'+randomUUID().slice(0,8)},
    });
    assert.equal(created.statusCode, 201);
    aid = created.json().id;
    for(let retry=0;office.agent(aid!).tududi_state!=='ready' && retryAt>Date.now() && retry<2;retry++){
      // Honor the real service's Retry-After; do not disable or bypass the limit.
      await new Promise(resolve=>setTimeout(resolve,retryAt-Date.now()+100));
      retryAt=0;await office.provision(aid!);
    }
    assert.equal(
      office.agent(aid!).tududi_state,
      "ready",
      "Administrator-created accounts must be able to sign in. " + store.events().find(e=>e.kind==='tududi_pending')?.text,
    );
    const project = await app.inject({
      method: "POST",
      url: `/api/agents/${aid}/projects`,
      headers,
      payload: { name: "Canlı test projesi" },
    });
    assert.equal(project.statusCode, 201);
    const task = await app.inject({
      method: "POST",
      url: `/api/agents/${aid}/tasks`,
      headers,
      payload: {
        name: "Canlı test görevi",
        description: "Görevin açıklaması korunmalı.",
        project_uid: project.json().uid,
      },
    });
    assert.equal(task.statusCode, 201);
    const note = await app.inject({
      method: "POST",
      url: `/api/agents/${aid}/notes`,
      headers,
      payload: {
        title: "Canlı test notu",
        content: "Bu kayıt test bitince hesabıyla birlikte silinir.",
        project_uid: project.json().uid,
      },
    });
    assert.equal(note.statusCode, 201);
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/agents/${aid}/tasks/${task.json().uid}`,
      headers,
      payload: { status: 2 },
    });
    assert.equal(updated.statusCode, 200);
    const read = await app.inject({
      url: `/api/agents/${aid}/tududi`,
      headers,
    });
    assert.equal(read.statusCode, 200);
    assert.ok(
      read
        .json()
        .tasks.some(
          (t: any) =>
            t.uid === task.json().uid &&
            t.status === 2 &&
            t.description === "Görevin açıklaması korunmalı.",
        ),
    );
    assert.ok(
      read.json().notes.some((n: any) => n.title === "Canlı test notu"),
    );
    assert.ok(read.json().projects.some((p:any)=>p.name==='Çalışma defteri'));
    assert.ok(read.json().notes.some((n:any)=>n.title==='Canlı oturum' && n.content.includes(`?oturum=${aid}`)));
    await office.migrateEmail(aid!, 'a3-tasinan-'+randomUUID().slice(0,8));
    assert.ok(office.agent(aid!).tududi_email.startsWith('a3-tasinan-'),"The real administrator API must support email migration.");
    const cookie=await office.tududi.login(office.agent(aid!).tududi_email,await office.password(aid!));
    assert.ok(cookie.includes('='),"Migrated accounts must accept the stored password.");
    store.db.prepare('UPDATE agents SET tududi_password_encrypted=NULL WHERE id=?').run(aid!);
    const legacyLink=await app.inject({method:'POST',url:`/api/agents/${aid}/tududi-link`,headers,payload:{}});
    const legacyOpened=await app.inject({url:legacyLink.json().url,headers});
    // The old fork ignored admin password changes (409, password not stored); pixel-office-tududi 0.87-po.3
    // accepts the verified new password. Neither case may store an unverified password.
    const extraAgentLogins=legacyOpened.statusCode===409?0:2;
    const storedAfterLink=store.db.prepare('SELECT tududi_password_encrypted FROM agents WHERE id=?').get(aid!)!.tududi_password_encrypted;
    if(legacyOpened.statusCode===409)assert.equal(storedAfterLink,null,"Unverified passwords must not be stored.");
    else{assert.ok([200,302,303].includes(legacyOpened.statusCode),`The legacy account must open (status ${legacyOpened.statusCode}).`);assert.ok(storedAfterLink,"The verified new password must be stored.");store.db.prepare('UPDATE agents SET tududi_password_encrypted=NULL WHERE id=?').run(aid!);}
    const retainedToken=office.token(aid!);assert.deepEqual(await prepareLegacyPassword(office,aid!),{prepared:true});
    assert.equal(office.token(aid!),retainedToken,"Local password preparation must preserve the API key.");
    const link=await app.inject({method:'POST',url:`/api/agents/${aid}/tududi-link`,headers,payload:{}});
    assert.equal(link.statusCode,200);const opened=await app.inject({url:link.json().url,headers});assert.equal(opened.statusCode,303);
    const transferred=[opened.headers['set-cookie']].flat().map(c=>String(c).split(';')[0]).join('; ');
    const current=await fetch('http://127.0.0.1:9393/api/current_user',{headers:{Cookie:transferred},redirect:'error'});
    assert.equal(current.status,200,"Forwarded/re-encoded cookies must preserve real Tududi login.");
    const currentUser=await current.json();assert.equal((currentUser.user || currentUser.currentUser || currentUser).email,office.agent(aid!).tududi_email);
    const run=runtime.enqueue(aid!,'Canlı iş notu','Yalnız test')!;
    await runtime.notebook.writeWork(run,'Amaç: test; yapılan: doğrulama; sıradaki: temizlik.');
    const meta=await runtime.notebook.upsert(aid!,'Harita','2026-10-11: deneme haritası');
    assert.equal((await runtime.notebook.readNote(aid!,meta.uid)).content,'2026-10-11: deneme haritası');
    const searched=await office.tududi.search(office.token(aid!),'deneme haritası');
    assert.ok(JSON.stringify(searched).includes(meta.uid),"Real search must find the selected note.");
    const result=await runtime.notebook.tool(run,'tududi_ara',{sorgu:'deneme haritası'}) as {notlar:{uid:string}[]};
    assert.ok(result.notlar.some(n=>n.uid===meta.uid),"Selective reading must handle the real search response.");
    assert.equal((await office.tududi.read(office.token(aid!))).notes.filter(n=>n.title==='Harita').length,1,"The fixed information note must not be duplicated.");
    const finalEmail=office.agent(aid!).tududi_email;
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/agents/${aid}?account=delete`,
      headers,
    });
    assert.equal(deleted.statusCode, 200);
    assert.equal(deleted.json().pending, false, "The real test account must be deleted.");
    assert.deepEqual(logins,{admin:1,agent:4+extraAgentLogins});
    aid = undefined;
    assert.equal(await office.tududi.findUser(finalEmail), null, "All test-account records, including the migrated address, must be cleaned up.");
  } finally {
    if (aid && store.agent(aid)) await office.removeAgent(aid, true);
    await app.close();
    cleanup(config);
  }
});
