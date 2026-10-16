import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { FactoryReset } from '../server/factory-reset.js';
import { TududiClient, TududiError } from '../server/tududi.js';
import { testConfig, cleanup, fakeTududi, input } from './helpers.js';
async function fixture() {
    const config = testConfig();
    const ctx = await createApp(config, { fetcher: fakeTududi().fetcher, background: false });
    const did = randomUUID();
    ctx.store.db.prepare('INSERT INTO departments(id,name,color) VALUES (?,?,?)').run(did, 'Deneme', '#498f87');
    const a = await ctx.office.createAgent({ ...input(did), name: 'A', username: 'ajan-a' }), b = await ctx.office.createAgent({ ...input(did), name: 'B', username: 'ajan-b' });
    await ctx.office.provision(ctx.store.agents().find(a => a.builtin === 'director')!.id);
    const remote = new Map<string, Record<string, any[]>>();
    for (const agent of ctx.store.agents()) {
        ctx.store.db.prepare('UPDATE agents SET tududi_user_id=COALESCE(tududi_user_id,?) WHERE id=?').run(agent.id, agent.id);
        remote.set(agent.id, { Task: [{ uid: agent.id + '-task', user_id: agent.tududi_user_id || agent.id, status: 2 }], Note: [], Project: [] });
        ctx.store.db.prepare('INSERT INTO memories VALUES (?,?)').run(agent.id, 'Özel hafıza');
    }
    ctx.office.tududi.resetInventory = async (token, user) => structuredClone(remote.get(ctx.store.agents().find(a => a.tududi_user_id === user)!.id)!);
    let failure = false, calls = 0;
    ctx.office.tududi.resetDelete = async (token, kind, uid) => { calls++; if (failure)
        throw new Error('Deneme hatası'); for (const data of remote.values())
        data[kind] = data[kind].filter(v => v.uid !== uid); };
    return { ...ctx, config, a, b, remote, reset: new FactoryReset(ctx.runtime), fail: (v: boolean) => failure = v, calls: () => calls, close: async () => { await ctx.app.close(); cleanup(config); } };
}
test("Reset one agent while preserving other agents, identities, accounts and rules", async () => { const f = await fixture(); try {
    const before = f.office.agent(f.a.id);
    const preview = await f.reset.preview('owner', f.a.id);
    assert.equal(preview.agents[0].counts.Task, 1);
    const done = await f.reset.execute(preview.id, 'owner', 'SIFIRLA');
    assert.equal(done.state, 'completed');
    assert.equal(f.store.db.prepare('SELECT 1 FROM memories WHERE agent_id=?').get(f.a.id), undefined);
    assert.ok(f.store.db.prepare('SELECT 1 FROM memories WHERE agent_id=?').get(f.b.id));
    assert.equal(f.office.agent(f.a.id).tududi_user_id, before.tududi_user_id);
    assert.equal(f.office.agent(f.a.id).prompt, before.prompt);
    assert.equal(f.remote.get(f.b.id)!.Task.length, 1);
}
finally {
    await f.close();
} });
test("Resetting all agents includes the Director", async () => { const f = await fixture(); try {
    const p = await f.reset.preview('owner');
    assert.equal(p.agents.length, 3);
    assert.equal((await f.reset.execute(p.id, 'owner', 'SIFIRLA')).state, 'completed');
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM memories').get()!.n, 0);
    assert.equal(f.store.agents().length, 3);
}
finally {
    await f.close();
} });
test("Wrong confirmation, canceled previews and other owner sessions cannot delete data", async () => { const f = await fixture(); try {
    const p = await f.reset.preview('owner', f.a.id);
    await assert.rejects(f.reset.execute(p.id, 'owner', 'sıfırla'));
    await assert.rejects(f.reset.execute(p.id, 'other', 'SIFIRLA'));
    assert.equal(f.calls(), 0);
    assert.equal(f.office.resetBlocked(), false);
}
finally {
    await f.close();
} });
test("Backup write failure prevents deletion", async () => { const f = await fixture(); try {
    const p = await f.reset.preview('owner', f.a.id);
    f.store.db.exec("CREATE TRIGGER deny_backup BEFORE UPDATE OF backup ON factory_resets BEGIN SELECT RAISE(ABORT,'deneme');END");
    await assert.rejects(f.reset.execute(p.id, 'owner', 'SIFIRLA'));
    assert.equal(f.calls(), 0);
    assert.equal(f.office.resetBlocked(), false);
}
finally {
    await f.close();
} });
test("Data changes after preview prevent deletion", async () => { const f = await fixture(); try {
    const p = await f.reset.preview('owner', f.a.id);
    f.remote.get(f.a.id)!.Task[0].status = 0;
    await assert.rejects(f.reset.execute(p.id, 'owner', 'SIFIRLA'));
    assert.equal(f.calls(), 0);
}
finally {
    await f.close();
} });
test("Partial failure and retry of remaining items", async () => { const f = await fixture(); try {
    const p = await f.reset.preview('owner', f.a.id);
    f.fail(true);
    assert.equal((await f.reset.execute(p.id, 'owner', 'SIFIRLA')).state, 'partial');
    assert.equal(f.office.resetBlocked(), true);
    f.fail(false);
    assert.equal((await f.reset.execute(p.id, 'owner', 'SIFIRLA')).state, 'completed');
    assert.equal(f.calls(), 2);
}
finally {
    await f.close();
} });
test("Unauthorized HTTP requests fail; write gate blocks new work", async () => { const f = await fixture(); try {
    const r = await f.app.inject({ method: 'POST', url: '/api/factory-reset/preview', headers: { 'x-ofis-islem': '1' }, payload: {} });
    assert.equal(r.statusCode, 401);
    f.store.db.prepare('INSERT INTO reset_gate VALUES(1,?)').run(randomUUID());
    assert.equal(f.runtime.enqueue(f.a.id, 'Deneme', 'İş'), null);
}
finally {
    await f.close();
} });
test("Pagination includes completed and child records; listing failure is not an empty result", async () => { const config = testConfig(); let fail = false; const calls: string[] = []; const c = new TududiClient(config, async (url) => { const u = new URL(String(url)); calls.push(u.pathname + u.search); if (fail)
    return new Response('{}', { status: 503 }); if (u.pathname === '/api/search') {
    const kind = u.searchParams.get('filters'), offset = Number(u.searchParams.get('offset'));
    const results = kind === 'Task' ? (offset === 0 ? Array.from({ length: 100 }, (_, i) => ({ uid: 't' + i })) : [{ uid: 't100' }]) : [];
    return Response.json({ results, pagination: { offset, limit: 100, total: kind === 'Task' ? 101 : 0, hasMore: kind === 'Task' && offset === 0 } });
} const uid = u.pathname.split('/').at(-1); return Response.json({ uid, user_id: 7, status: 2, parent_task_id: uid === 't100' ? 1 : null }); }); try {
    const data = await c.resetInventory('deneme', '7');
    assert.equal(data.Task.length, 101);
    assert.equal(data.Task.find(t => t.uid === 't100')!.parent_task_id, 1);
    assert.ok(calls.includes('/api/search?filters=Task&limit=100&offset=100'));
    fail = true;
    await assert.rejects(c.resetInventory('deneme', '7'));
}
finally {
    cleanup(config);
} });
for (const kind of ['Task', 'Note', 'Project']) {
    test(`${kind}: mismatched or missing detail IDs prevent preview creation`, async () => {
        const f = await fixture();
        try {
            const user = f.office.agent(f.a.id).tududi_user_id;
            for (const uid of ['baska-kayit', undefined]) {
                const client = new TududiClient(f.config, async (url) => {
                    const parsed = new URL(String(url));
                    if (parsed.pathname === '/api/search') {
                        const results = parsed.searchParams.get('filters') === kind ? [{ uid: 'beklenen-kayit' }] : [];
                        return Response.json({ results, pagination: { offset: 0, limit: 100, total: results.length, hasMore: false } });
                    }
                    return Response.json({ uid, user_id: user });
                });
                f.office.tududi.resetInventory = client.resetInventory.bind(client);
                await assert.rejects(f.reset.preview('owner', f.a.id), (error: unknown) => error instanceof TududiError && error.code === 'inventory_identity_mismatch');
                assert.equal(f.store.db.prepare('SELECT count(*) n FROM factory_resets').get()!.n, 0);
                assert.equal(f.calls(), 0);
                assert.equal(f.office.resetBlocked(), false);
                assert.ok(f.store.db.prepare('SELECT 1 FROM memories WHERE agent_id=?').get(f.a.id));
            }
        }
        finally {
            await f.close();
        }
    });
}
async function owner(f: Awaited<ReturnType<typeof fixture>>, language: 'tr' | 'en' = 'tr') {
    f.office.setLanguage(language);
    const response = await f.app.inject({ method: 'POST', url: '/api/login', headers: { 'x-ofis-islem': '1', 'accept-language': language }, payload: { password: f.config.ownerPassword } });
    assert.equal(response.statusCode, 200);
    return { cookie: `ofis_session=${response.cookies.find(c => c.name === 'ofis_session')!.value}`, 'x-ofis-islem': '1' };
}
async function until(check: () => boolean) { const deadline = Date.now() + 3000; while (!check()) {
    if (Date.now() > deadline)
        throw new Error("Reset did not reach the expected state.");
    await new Promise(r => setTimeout(r, 5));
} }
for (const language of ['tr', 'en'] as const)
    test(`${language}: HTTP preview, encrypted backup, session isolation and localized confirmation word`, async () => {
        const f = await fixture();
        try {
            const headers = await owner(f, language), other = await owner(f, language), word = language === 'tr' ? 'SIFIRLA' : 'RESET';
            const preview = await f.app.inject({ method: 'POST', url: '/api/factory-reset/preview', headers, payload: { agent_id: f.a.id } });
            assert.equal(preview.statusCode, 200, preview.body);
            const p = preview.json();
            assert.equal(p.backupReady, true);
            assert.match(p.scope, language === 'tr' ? /Alanlar, etiketler/ : /Areas, tags/);
            if (language === 'en')
                assert.doesNotMatch(p.scope, /[çğıöşüÇĞİÖŞÜ]/);
            const stored = f.store.db.prepare('SELECT json,backup FROM factory_resets WHERE id=?').get(p.id)!;
            assert.ok(!String(stored.json).includes('Özel hafıza'));
            assert.ok(!String(stored.backup).includes('Özel hafıza'));
            const backup = await f.app.inject({ url: `/api/factory-reset/${p.id}/backup`, headers });
            assert.equal(backup.statusCode, 200);
            assert.match(String(backup.headers['content-disposition']), /attachment/);
            assert.equal(backup.json().data[0].local.memories[0].text, 'Özel hafıza');
            assert.equal((await f.app.inject({ url: `/api/factory-reset/${p.id}/backup`, headers: other })).statusCode, 403);
            assert.equal((await f.app.inject({ url: `/api/factory-reset/${p.id}/backup` })).statusCode, 401);
            assert.equal((await f.app.inject({ method: 'POST', url: `/api/factory-reset/${p.id}/execute`, headers, payload: { confirmation: language === 'tr' ? 'RESET' : 'SIFIRLA' } })).statusCode, 400);
            assert.equal((await f.app.inject({ method: 'POST', url: `/api/factory-reset/${p.id}/execute`, headers: other, payload: { confirmation: word } })).statusCode, 403);
            assert.equal(f.calls(), 0);
            const done = await f.app.inject({ method: 'POST', url: `/api/factory-reset/${p.id}/execute`, headers, payload: { confirmation: word } });
            assert.equal(done.statusCode, 200, done.body);
            assert.equal(done.json().state, 'completed');
            assert.equal(f.calls(), 1);
            assert.equal((await f.app.inject({ url: '/api/factory-reset/current', headers })).json(), null);
            assert.equal(f.office.inFlight, 0);
        }
        finally {
            await f.close();
        }
    });
test("Director reset proposals always require the owner; approval opens only a preview", async () => {
    const f = await fixture();
    try {
        const headers = await owner(f), gm = f.runtime.director.agent(), settings = f.runtime.settings();
        f.store.db.prepare('UPDATE runtime_settings SET json=?').run(JSON.stringify({ ...settings, director: { ...settings.director, destructiveApproval: false, ownerApprovalTypes: [] } }));
        f.runtime.heartbeat('runner');
        f.runtime.enqueue(gm.id, 'Elle', 'Önizleme öner');
        const lease = f.runtime.claim('runner')!;
        const result: any = await f.runtime.tool(lease.run, 'yonetim_islem', { islem: 'fabrika_ayarlari_onizle', kimlik: f.a.id });
        assert.equal(result.sahibin_karari, true);
        assert.equal(result.onizleme.agents.length, 1);
        const approval = f.runtime.approvals().find(a => a.id === result.onay)!;
        assert.equal(approval.type, 'factory_reset');
        assert.equal(f.runtime.director.ownerOnly(approval), true);
        assert.equal(f.calls(), 0);
        assert.equal(f.office.resetBlocked(), false);
        await assert.rejects(f.runtime.director.decideAction(approval.id, true, '', 'director'), /sahibe/);
        await assert.rejects(f.runtime.director.action(lease.run, { islem: 'onay_karari', kimlik: approval.id, veri: { approved: true } }), /sahibe/);
        const opened = await f.app.inject({ method: 'POST', url: `/api/approvals/${approval.id}/decision`, headers, payload: { approved: true } });
        assert.equal(opened.statusCode, 200, opened.body);
        assert.equal(opened.json().sonuc.state, 'preview');
        assert.equal(f.calls(), 0);
        assert.equal(f.office.resetBlocked(), false);
        const id = opened.json().sonuc.id;
        assert.equal((await f.app.inject({ url: `/api/factory-reset/${id}/backup`, headers })).statusCode, 200);
        assert.equal((await f.app.inject({ method: 'POST', url: `/api/factory-reset/${id}/execute`, headers: { authorization: `Bearer ${lease.key}`, 'x-ofis-islem': '1' }, payload: { confirmation: 'SIFIRLA' } })).statusCode, 401);
        await assert.rejects(f.runtime.director.dispatch!({ islem: 'fabrika_ayarlari_onizle', kimlik: f.a.id, veri: { confirmation: 'SIFIRLA' } }), /geçersiz/);
        assert.equal(f.calls(), 0);
    }
    finally {
        await f.close();
    }
});
test("Deletion waits for the current nonce and quiescence confirmation; gate blocks new jobs", async () => {
    const f = await fixture();
    try {
        f.config.runnerKey = 'yalniz-sahte-runner-'.repeat(3);
        const headers = await owner(f);
        f.runtime.heartbeat('runner');
        const p = await f.reset.preview('owner', f.a.id);
        const execution = f.reset.execute(p.id, 'owner', 'SIFIRLA');
        await until(() => !!f.reset.read(p.id).nonce);
        assert.equal(f.calls(), 0);
        assert.equal(f.runtime.enqueue(f.a.id, 'Elle', 'Engellenmeli'), null);
        assert.equal(f.runtime.claim('runner'), null);
        assert.equal((await f.app.inject({ method: 'PUT', url: '/api/rules', headers, payload: { text: 'Engellenmeli' } })).statusCode, 409);
        const beat = f.runtime.heartbeat('runner');
        assert.deepEqual(beat.reset!.agents, [f.a.id]);
        assert.equal(beat.paused, true);
        const runnerHeaders = { authorization: `Bearer ${f.config.runnerKey}` };
        for (const body of [{ runner: 'other', reset: p.id, nonce: beat.reset!.nonce }, { runner: 'runner', reset: p.id, nonce: randomUUID() }])
            assert.equal((await f.app.inject({ method: 'POST', url: '/api/runner/reset-idle', headers: runnerHeaders, payload: body })).statusCode, 409);
        assert.equal(f.calls(), 0);
        assert.equal((await f.app.inject({ method: 'POST', url: '/api/runner/reset-idle', headers: runnerHeaders, payload: { runner: 'runner', reset: p.id, nonce: beat.reset!.nonce } })).statusCode, 200);
        assert.equal((await execution).state, 'completed');
        assert.equal(f.office.resetBlocked(), false);
    }
    finally {
        await f.close();
    }
});
test("Delete deep child/repeating tasks first; partial retries tolerate shrinking project lists", async () => {
    const f = await fixture();
    try {
        const remote = f.remote.get(f.a.id)!;
        remote.Task = [{ id: 1, uid: 'root', subtasks: [{ uid: 'child' }] }, { id: 2, uid: 'child', parent_task_id: 1 }, { id: 3, uid: 'grandchild', parent_task_id: 2 }, { id: 4, uid: 'recurring', recurring_parent_id: 1 }];
        remote.Note = [{ uid: 'note', project_id: 7 }];
        remote.Project = [{ id: 7, uid: 'project', name: 'Korunan ad', Tasks: [{ uid: 'root' }], Notes: [{ uid: 'note' }] }];
        let failProject = true;
        const removed: string[] = [];
        f.office.tududi.resetDelete = async (_token, kind, uid) => { if (kind === 'Project' && failProject)
            throw new Error('Deneme'); removed.push(uid); remote[kind] = remote[kind].filter(v => v.uid !== uid); remote.Task.forEach(t => { if (t.subtasks)
            t.subtasks = t.subtasks.filter((v: any) => v.uid !== uid); }); remote.Project.forEach(p => { p.Tasks = p.Tasks.filter((v: any) => v.uid !== uid); p.Notes = p.Notes.filter((v: any) => v.uid !== uid); }); };
        const p = await f.reset.preview('owner', f.a.id), partial = await f.reset.execute(p.id, 'owner', 'SIFIRLA');
        assert.equal(partial.state, 'partial');
        assert.equal(partial.results![0].counts!.Project, 1);
        assert.ok(removed.indexOf('grandchild') < removed.indexOf('child'));
        assert.ok(removed.indexOf('child') < removed.indexOf('root'));
        assert.ok(removed.indexOf('recurring') < removed.indexOf('root'));
        failProject = false;
        assert.equal((await f.reset.execute(p.id, 'owner', 'SIFIRLA')).state, 'completed');
        assert.equal(removed.filter(id => id === 'root').length, 1);
        assert.equal(removed.at(-1), 'project');
    }
    finally {
        await f.close();
    }
});
test("Director reset preserves usage/identity settings and clears ledger, watches and sessions", async () => {
    const f = await fixture();
    try {
        const gm = f.runtime.director.agent(), state = f.runtime.director.state();
        state.ledger = 'Özel GM notu';
        state.terminal_enabled = true;
        state.terminal_generation = 4;
        state.terminal_usage = { conversation: { input_tokens: 123, output_tokens: 45 } };
        state.provider_selected = true;
        f.runtime.director.save(state);
        f.runtime.a3.session(gm.id);
        f.store.db.prepare('INSERT INTO director_followups VALUES (?,?)').run('is', 'sonuc');
        f.store.db.prepare('INSERT INTO director_terminal(run_id,kind,text,created_at) VALUES (NULL,?,?,?)').run('input', 'Özel konuşma', new Date().toISOString());
        const before = f.office.agent(gm.id), p = await f.reset.preview('owner', gm.id);
        assert.equal((await f.reset.execute(p.id, 'owner', 'SIFIRLA')).state, 'completed');
        assert.equal(f.runtime.director.state().ledger, '');
        assert.equal(f.runtime.director.state().terminal_enabled, true);
        assert.equal(f.runtime.director.state().terminal_generation, 5);
        assert.deepEqual(f.runtime.director.state().terminal_usage, state.terminal_usage);
        for (const table of ['director_terminal', 'director_followups'])
            assert.equal(f.store.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 0);
        assert.equal(f.store.db.prepare('SELECT count(*) n FROM agent_sessions WHERE agent_id=?').get(gm.id)!.n, 0);
        assert.ok(f.store.db.prepare('SELECT 1 FROM profile_deletions WHERE agent_id=?').get(gm.id));
        assert.equal(f.office.agent(gm.id).prompt, before.prompt);
        assert.deepEqual(f.office.agent(gm.id).policy, before.policy);
        assert.equal(f.office.agent(gm.id).tududi_user_id, before.tududi_user_id);
    }
    finally {
        await f.close();
    }
});
for (const invalid of [undefined, null, 'false', 0])
    test(`Pagination rejects invalid hasMore=${String(invalid)} rather than accepting an empty list`, async () => {
        const config = testConfig();
        try {
            const client = new TududiClient(config, async () => Response.json({ results: [], pagination: { offset: 0, limit: 100, total: 0, hasMore: invalid } }));
            await assert.rejects(client.resetInventory('sahte', '1'), (e: unknown) => e instanceof TududiError && e.code === 'incomplete_inventory');
        }
        finally {
            cleanup(config);
        }
    });

test("Schedule history and Director follow-up records enter encrypted backups before deletion", async () => {
    const f = await fixture();
    try {
        const gm = f.runtime.director.agent();
        const schedule = f.runtime.scheduler.upsert({name:'Deneme',agent_id:gm.id,instruction:'Deneme işi',timing:{kind:'daily',time:'09:00'}});
        f.store.db.prepare('INSERT INTO schedule_history VALUES (?,?,?,?,?,?)').run(randomUUID(),schedule.id,new Date().toISOString(),null,null,JSON.stringify({state:'completed',note:'Eski sonuç'}));
        f.store.db.prepare('INSERT INTO director_redirects VALUES (?,?)').run('ornek-is',2);
        const preview = await f.reset.preview('owner',gm.id);
        assert.equal(preview.agents[0].counts.schedule_history,1);
        const backup = f.reset.db.prepare('SELECT backup FROM factory_resets WHERE id=?').get(preview.id)!;
        const {decrypt}=await import('../server/security.js');
        const data=JSON.parse(decrypt(String(backup.backup),f.config.secretKey,preview.id));
        assert.equal(data.data[0].local.schedule_history.length,1);
        assert.equal(data.local[0].director.director_redirects[0].work_key,'ornek-is');
        const done=await f.reset.execute(preview.id,'owner','SIFIRLA');
        assert.equal(done.state,'completed');assert.equal(done.results![0].counts!.schedule_history,0);
        assert.equal(f.store.db.prepare('SELECT count(*) n FROM schedule_history').get()!.n,0);
    } finally { await f.close(); }
});

test("After a partial all-agent reset, successful agents are not reset twice", async () => {
    const f=await fixture();
    try {
        const original=f.office.tududi.resetDelete;
        let fail=true;
        f.office.tududi.resetDelete=async(token,kind,uid)=>{if(fail && uid===f.a.id+'-task')throw new Error('Deneme kesintisi');await original(token,kind,uid);};
        const preview=await f.reset.preview('owner');
        assert.equal((await f.reset.execute(preview.id,'owner','SIFIRLA')).state,'partial');
        const generation=f.runtime.director.state().terminal_generation;
        fail=false;
        const done=await f.reset.execute(preview.id,'owner','SIFIRLA');
        assert.equal(done.state,'completed');assert.equal(f.runtime.director.state().terminal_generation,generation);
        assert.equal(f.calls(),3);
        await f.reset.execute(preview.id,'owner','SIFIRLA');assert.equal(f.calls(),3);
    } finally {await f.close();}
});

test("Partial-reset gate, backup and ownership survive application restart", async () => {
    const f=await fixture();let reopened:Awaited<ReturnType<typeof createApp>>|undefined;
    try {
        const preview=await f.reset.preview('owner',f.a.id);f.fail(true);
        assert.equal((await f.reset.execute(preview.id,'owner','SIFIRLA')).state,'partial');
        await f.app.close();
        reopened=await createApp(f.config,{fetcher:fakeTududi().fetcher,background:false});
        reopened.office.tududi.resetInventory=async(_token,user)=>structuredClone(f.remote.get(reopened!.store.agents().find(a=>a.tududi_user_id===user)!.id)!);
        reopened.office.tududi.resetDelete=f.office.tududi.resetDelete;
        const reset=new FactoryReset(reopened.runtime);
        assert.equal(reopened.office.resetBlocked(),true);assert.equal(reset.current('owner')!.id,preview.id);
        assert.throws(()=>reset.current('different-owner'),/başka sahip/);
        assert.equal(reopened.runtime.enqueue(f.a.id,'Elle','Kapıda bekler'),null);
        f.fail(false);assert.equal((await reset.execute(preview.id,'owner','SIFIRLA')).state,'completed');
    } finally {await reopened?.app.close();await f.close();}
});
