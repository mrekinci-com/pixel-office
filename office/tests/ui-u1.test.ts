import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { testConfig, fakeTududi, cleanup, input } from './helpers.js';

test("U1: terminal marks old Director messages read in bulk while preserving other chats and decisions", async () => {
  const config = testConfig();
  const c = await createApp(config, { fetcher: fakeTududi().fetcher, background: false });
  try {
    const login = await c.app.inject({ method: 'POST', url: '/api/login', headers: { 'x-ofis-islem': '1' }, payload: { password: config.ownerPassword } });
    const cookie = login.cookies[0].name + '=' + login.cookies[0].value;
    const headers = { cookie, 'x-ofis-islem': '1' };
    const gm = c.runtime.director.agent();
    const other = await c.office.createAgent(input(gm.department_id));
    const add = c.store.db.prepare('INSERT INTO messages(id,sender_agent_id,recipient_type,recipient_id,text,created_at,sender_type) VALUES (?,?,?,?,?,?,?)');
    const ids: string[] = [];
    for (let i = 0; i < 521; i++) {
      const id = randomUUID(); ids.push(id);
      add.run(id, gm.id, 'agent', gm.id, 'Eski cevap', new Date(i * 1000).toISOString(), 'agent');
    }
    const system = randomUUID(); ids.push(system);
    add.run(system, null, 'agent', gm.id, 'Eski sistem kaydı', new Date().toISOString(), 'system');
    const group = c.office.message(gm.id, 'everyone', null, 'Grup cevabı');
    const direct = c.office.message(other.id, 'agent', other.id, 'Başka sohbet');
    const outgoing = c.office.message(null, 'agent', gm.id, 'Sahibin girdisi');
    const interAgent = c.office.message(gm.id, 'agent', other.id, 'GM başka bir ajana yazdı');
    c.office.readMessage(ids[0], 'owner');
    const oldReceipt = c.store.db.prepare("SELECT read_at FROM message_reads WHERE message_id=? AND reader_id='owner'").get(ids[0])!.read_at;
    const run = c.runtime.enqueue(gm.id, 'Deneme', 'Karar bekleyen iş')!;
    const approval = { id: randomUUID(), agent_id: gm.id, run_id: run.id, title: 'Bekleyen karar', detail: '', type: 'external', state: 'pending' as const, note: '', created_at: new Date().toISOString(), decided_at: null, link_id: null, files: [] };
    c.runtime.saveApproval(approval);
    const beforeRuns = c.runtime.runs().length;
    assert.equal(c.store.messages().length, 500);
    assert.equal((await c.app.inject({ method: 'POST', url: '/api/director/read', headers: { 'x-ofis-islem': '1' }, payload: {} })).statusCode, 401);
    assert.equal((await c.app.inject({ method: 'POST', url: '/api/director/read', headers: { cookie }, payload: {} })).statusCode, 403);
    const result = await c.app.inject({ method: 'POST', url: '/api/director/read', headers, payload: {} });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().read, ids.length - 1);
    for (const id of ids) assert.ok(c.store.db.prepare("SELECT 1 FROM message_reads WHERE message_id=? AND reader_id='owner'").get(id));
    for (const m of [group, direct, outgoing, interAgent]) assert.equal(c.store.db.prepare("SELECT 1 FROM message_reads WHERE message_id=? AND reader_id='owner'").get(m.id), undefined);
    assert.equal(c.store.db.prepare("SELECT read_at FROM message_reads WHERE message_id=? AND reader_id='owner'").get(ids[0])!.read_at, oldReceipt);
    assert.equal((await c.app.inject({ method: 'POST', url: '/api/director/read', headers, payload: {} })).json().read, 0);
    assert.deepEqual(c.runtime.approvals(), [approval]);
    assert.equal(c.runtime.runs().length, beforeRuns);
  } finally {
    await c.app.close(); cleanup(config);
  }
});
