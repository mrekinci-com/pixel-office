import { test } from "node:test";
import assert from "node:assert/strict";
import { TududiClient, TududiError } from "../server/tududi.js";
import { createApp } from "../server/app.js";
import { testConfig, cleanup, fakeTududi, input } from "./helpers.js";
test("Tududi sessions and separate Bearer keys reach the correct endpoints", async () => {
  const config = testConfig();
  const fake = fakeTududi();
  try {
    const client = new TududiClient(config, fake.fetcher);
    const uid = await client.createUser(
      "ajan@example.test",
      "test-password",
      "Ajan",
    );
    assert.equal(uid, "101");
    assert.equal(
      await client.createUser("ajan@example.test", "test-password", "Ajan",uid),
      uid,
    );
    await assert.rejects(()=>client.createUser("ajan@example.test", "different-test-password", "Other"),/başka bir hesapta kullanılıyor/);
    assert.equal(fake.users.length, 1);
    await assert.rejects(() => client.login("ajan@example.test", "different-test-password"),
      (error) => error instanceof TududiError && error.status === 401);
    const key = await client.createKey("ajan@example.test", "test-password");
    const p = await client.project(key, "Proje");
    const task = await client.task(key, { name: "İş", project_uid: p.uid });
    await client.note(key, { title: "Not", content: "İçerik" });
    await client.updateTask(key, task.uid, 2);
    const data = await client.read(key);
    assert.equal(data.tasks[0].status, 2);
    assert.equal(data.notes[0].content, "İçerik");
    assert.ok(
      fake.calls
        .filter((c) =>
          ["/api/task", "/api/notes", "/api/projects"].includes(c.path),
        )
        .every((c) => c.auth === `Bearer ${key}`),
    );
    await client.deleteUser(uid);
    assert.equal(fake.users.length, 0);
  } finally {
    cleanup(config);
  }
});

test("B2.3.1: linked accounts with incomplete key setup recover with the same identity/data after restart", async () => {
  const config = testConfig(), fake = fakeTududi();
  let failKey = true;
  const fetcher: typeof fetch = async (url, init) => {
    if (new URL(String(url)).pathname === "/api/profile/api-keys" && failKey) {
      failKey = false;
      return new Response("{}", { status: 503 });
    }
    return fake.fetcher(url, init);
  };
  let c = await createApp(config, { fetcher, background: false });
  try {
    const pending = await c.office.createAgent(input(c.store.departments()[0].id));
    assert.equal(pending.tududi_state, "pending");
    assert.ok(pending.tududi_user_id, "Account identity must persist before key setup.");
    await c.app.close();
    c = await createApp(config, { fetcher, background: false });
    const ready = await c.office.provision(pending.id);
    assert.equal(ready.tududi_state, "ready");
    assert.equal(ready.tududi_user_id, pending.tududi_user_id);
    const token = c.office.token(ready.id);
    const note = await c.office.tududi.note(token, { title: "Korunan not", content: "Doğrulandı." });
    c.store.db.prepare("UPDATE agents SET tududi_state='pending',tududi_token_encrypted=NULL WHERE id=?").run(ready.id);
    assert.equal((await c.office.provision(ready.id)).tududi_state, "ready");
    assert.ok((await c.office.tududi.read(c.office.token(ready.id))).notes.some((n) => n.uid === note.uid));
    assert.equal(fake.users.length, 1);
    assert.equal(fake.calls.filter((call) => call.path === "/api/admin/users" && call.method === "POST").length, 1,
      "Linked accounts must not be recreated.");
    assert.equal(fake.calls.filter((call) => call.method === "DELETE" || call.method === "PUT").length, 0,
      "Recovery must not change another account or password.");
  } finally {
    await c.app.close();
    cleanup(config);
  }
});

test("B2.3.1: fake Tududi rejects duplicate account emails", async () => {
  const fake = fakeTududi();
  const create = (email: string) => fake.fetcher("http://127.0.0.1:9393/api/admin/users", {
    method: "POST", body: JSON.stringify({ email, password: "only-test" }),
  });
  assert.equal((await create("ajan@example.test")).status, 201);
  assert.equal((await create("AJAN@example.test")).status, 409);
  assert.equal(fake.users.length, 1);
  assert.deepEqual(Object.keys(fake.users[0]).sort(), ["email", "id"]);
});

test("A2.2: concurrent admin actions share one session; 401 refreshes it once", async () => {
  const config = testConfig();
  let logins = 0, expired = false;
  const calls: { path: string; cookie: string }[] = [];
  const client = new TududiClient(config, async (url, init) => {
    const path = new URL(String(url)).pathname;
    const cookie = new Headers(init?.headers).get('cookie') || '';
    calls.push({ path, cookie });
    if (path === '/api/login') return new Response('{}', { headers: { 'set-cookie': `session=${++logins}; HttpOnly` } });
    if (expired && cookie === 'session=1') return new Response('{}', { status: 401 });
    return new Response('[]');
  });
  try {
    await Promise.all(Array.from({ length: 10 }, () => client.findUser('test@example.test')));
    assert.equal(logins, 1);
    expired = true;
    await Promise.all([client.findUser('test@example.test'), client.deleteUser('101'), client.findUser('test@example.test')]);
    assert.equal(logins, 2);
    await client.deleteUser('102'); assert.equal(logins, 2);
    assert.equal(calls.at(-1)?.cookie, 'session=2');
  } finally { cleanup(config); }
});

test("A2.2: 429 explains the retry delay without causing a login storm", async () => {
  const config = testConfig(); let calls = 0;
  const client = new TududiClient(config, async () => { calls++; return new Response('gizli', { status: 429, headers: { 'retry-after': '121' } }); });
  try {
    for (let i = 0; i < 3; i++) await assert.rejects(() => client.findUser('test@example.test'),
      (e) => e instanceof TududiError && e.status === 429 && e.retryAfterSeconds <= 121 && /3 dakika/.test(e.message) && !e.message.includes('gizli'));
    assert.equal(calls, 1);
  } finally { cleanup(config); }
});
test("Tududi validation errors, network failures and malformed responses reveal no secrets", async () => {
  const config = testConfig();
  try {
    for (const status of [401, 403, 500]) {
      const client = new TududiClient(
        config,
        async () => new Response("gizli-sunucu-yaniti", { status }),
      );
      await assert.rejects(
        () => client.login("secret@email", "secret-password"),
        (e) =>
          e instanceof TududiError &&
          !e.message.includes("secret") &&
          !e.message.includes("gizli"),
      );
    }
    const down = new TududiClient(config, async () => {
      throw new Error("secret-password");
    });
    await assert.rejects(
      () => down.read("secret-token"),
      (e) => e instanceof TududiError && !e.message.includes("secret"),
    );
    const malformed = new TududiClient(
      config,
      async () => new Response("bozuk", { status: 200 }),
    );
    await assert.rejects(() => malformed.read("secret-token"), TududiError);
  } finally {
    cleanup(config);
  }
});
