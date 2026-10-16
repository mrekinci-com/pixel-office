import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance, InjectOptions } from "fastify";
import { createApp } from "../server/app.js";
import {
  testConfig,
  cleanup,
  fakeTududi,
  input,
  agentBody,
} from "./helpers.js";
import type { Agent } from "../shared/types.js";
async function owner(app: FastifyInstance, password: string) {
  const r = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { "x-ofis-islem": "1" },
    payload: { password },
  });
  assert.equal(r.statusCode, 200);
  return {
    cookie: r.headers["set-cookie"]!.toString().split(";")[0],
    "x-ofis-islem": "1",
  };
}
test("SSE delivers events/messages/state to authorized sessions and closes on logout", async () => {
  const config = testConfig();
  const { app, office } = await createApp(config, {
    fetcher: fakeTududi().fetcher,
  });
  try {
    const headers = await owner(app, config.ownerPassword);
    const listenersBeforeStream=office.bus.listenerCount("update");
    const response = await app.inject({
      url: "/api/live",
      headers,
      payloadAsStream: true,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "text/event-stream");
    const stream = response.stream();
    let payload = "";
    stream.on("data", (chunk) => {
      payload += chunk.toString();
    });
    office.message(null, "everyone", null, "Canlı mesaj");
    office.changed("agent", { id: "test", status: "calisiyor" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(payload.includes("event: ready"));
    assert.ok(payload.includes("Canlı mesaj"));
    assert.ok(payload.includes('"type":"agent"'));
    assert.ok(payload.includes('"type":"event"'));
    const ended = new Promise<void>((resolve) => stream.once("end", resolve));
    await app.inject({ method: "POST", url: "/api/logout", headers });
    await ended;
    assert.equal(
      office.bus.listenerCount("update"),
      listenersBeforeStream,
      "Queue and Director listeners remain; the SSE listener is removed.",
    );
  } finally {
    await app.close();
    cleanup(config);
  }
});
test("Login, signed cookies, expiry, logout, request validation and attempt limits", async () => {
  const config = testConfig();
  const { app, store } = await createApp(config, {
    fetcher: fakeTududi().fetcher,
  });
  try {
    for (const url of [
      "/api/snapshot",
      "/api/events",
      "/api/agents/no/tududi",
      "/api/live",
    ])
      assert.equal((await app.inject({ url })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/login",
          payload: { password: config.ownerPassword },
        })
      ).statusCode,
      403,
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      headers: { "x-ofis-islem": "1" },
      payload: { password: config.ownerPassword },
    });
    const cookie = login.headers["set-cookie"]!.toString();
    assert.ok(cookie.includes("HttpOnly"));
    assert.ok(cookie.includes("SameSite=Strict"));
    const headers = { cookie: cookie.split(";")[0], "x-ofis-islem": "1" };
    assert.equal(
      (await app.inject({ url: "/api/snapshot", headers })).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/snapshot",
          headers: { cookie: headers.cookie + "tamper" },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: "/api/rules",
          headers: { ...headers, origin: "https://baska.example" },
          payload: { text: "Değiştir" },
        })
      ).statusCode,
      403,
    );
    store.db.prepare("UPDATE sessions SET expires_at=0").run();
    assert.equal(
      (await app.inject({ url: "/api/snapshot", headers })).statusCode,
      401,
    );
    const newer = await owner(app, config.ownerPassword);
    await app.inject({ method: "POST", url: "/api/logout", headers: newer });
    assert.equal(
      (await app.inject({ url: "/api/session", headers: newer })).statusCode,
      401,
    );
    for (let i = 0; i < 3; i++)
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/login",
            headers: { "x-ofis-islem": "1" },
            payload: { password: "yanlis" },
          })
        ).statusCode,
        401,
      );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/login",
          headers: { "x-ofis-islem": "1" },
          payload: { password: "yanlis" },
        })
      ).statusCode,
      429,
    );
  } finally {
    await app.close();
    cleanup(config);
  }
});
test("Department, agent, encrypted account, messages, instructions, handoff and deletion flow", async () => {
  const config = testConfig();
  const fake = fakeTududi();
  const { app, store, office } = await createApp(config, {
    fetcher: fake.fetcher,
  });
  try {
    const headers = await owner(app, config.ownerPassword);
    const request = async (
      method: InjectOptions["method"],
      url: string,
      payload?: unknown,
    ) => app.inject({ method, url, headers, payload: payload as any });
    const department = await request("POST", "/api/departments", {
      name: "Araştırma",
      color: "#548879",
    });
    assert.equal(department.statusCode, 201);
    const did = department.json().id;
    const department2 = await request("POST", "/api/departments", {
      name: "Yönetim",
      color: "#778899",
    });
    const did2 = department2.json().id;
    assert.equal(
      (await request("PUT", "/api/departments/order", { ids: [did2, did,...store.departments().filter(d=>![did,did2].includes(d.id)).map(d=>d.id)] }))
        .statusCode,
      200,
    );
    assert.equal(store.departments()[0].id, did2);
    assert.equal(
      (await request("PUT", "/api/departments/order", { ids: [did, did] }))
        .statusCode,
      400,
    );
    const a = (
      await request("POST", "/api/agents", input(did))
    ).json() as Agent;
    assert.equal(a.tududi_state, "ready");
    const b = (
      await request("POST", "/api/agents", {
        ...input(did),
        name: "Diğer ajan",
      })
    ).json() as Agent;
    assert.equal(fake.users.length, 2);
    assert.notEqual(a.tududi_email, b.tududi_email);
    assert.equal(
      (await request("DELETE", `/api/departments/${did}`)).statusCode,
      409,
    );
    const row = store.db
      .prepare(
        "SELECT tududi_token_encrypted,tududi_password_encrypted FROM agents WHERE id=?",
      )
      .get(a.id)!;
    assert.ok(!String(row.tududi_token_encrypted).includes("fake-token"));
    assert.ok(row.tududi_password_encrypted);
    await request("PUT", "/api/rules", { text: "Türkçe yaz." });
    const full = (await request("GET", `/api/agents/${a.id}/prompt`)).json()
      .prompt;
    assert.ok(full.indexOf("Türkçe yaz.") < full.indexOf("Kaynak göster."));
    assert.ok(full.includes("Diğer ajan"));
    const eventChanges: string[] = [];
    office.bus.on("update", (e) => eventChanges.push(e.type));
    const message = await request("POST", "/api/messages", {
      recipient_type: "department",
      recipient_id: did,
      text: "Merhaba ekip",
    });
    assert.equal(message.statusCode, 201);
    const snapshot = (await request("GET", "/api/snapshot")).json();
    assert.equal(snapshot.messages.length, 1);
    assert.ok(!JSON.stringify(snapshot).includes("encrypted"));
    assert.ok(!JSON.stringify(snapshot).includes("agent_key_hash"));
    assert.ok(!JSON.stringify(snapshot).includes("fake-token"));
    assert.ok(
      eventChanges.includes("message") && eventChanges.includes("event"),
    );
    await request("POST", `/api/messages/${message.json().id}/read`);
    assert.ok(store.messages()[0].read_by!.includes("owner"));
    const handoff = await request("POST", "/api/handoffs", {
      to_agent_id: b.id,
      title: "Kaynakları kontrol et",
      description: "Tarihe bak",
    });
    assert.equal(handoff.statusCode, 201);
    assert.equal(handoff.json().status, "created");
    assert.ok(handoff.json().tududi_task_uid);
    assert.equal(
      (await request("POST", `/api/handoffs/${handoff.json().id}/retry`)).json()
        .tududi_task_uid,
      handoff.json().tududi_task_uid,
    );
    const readA = (await request("GET", `/api/agents/${a.id}/tududi`)).json();
    const readB = (await request("GET", `/api/agents/${b.id}/tududi`)).json();
    assert.equal(readA.tasks.length, 0);
    assert.equal(readB.tasks.length, 1);
    await request(
      "PATCH",
      `/api/agents/${b.id}/tasks/${handoff.json().tududi_task_uid}`,
      { status: 2 },
    );
    assert.equal(store.snapshot().handoffs[0].status, "completed");
    assert.equal(
      (
        await request("PUT", `/api/agents/${b.id}`, {
          ...agentBody(b),
          name: "Yeni ad",
          active: false,
        })
      ).json().status,
      "kapali",
    );
    assert.equal(
      (await request("DELETE", `/api/agents/${b.id}`)).statusCode,
      400,
    );
    assert.equal(
      (await request("DELETE", `/api/agents/${b.id}?account=delete`))
        .statusCode,
      200,
    );
    assert.equal(fake.users.length, 1);
    assert.equal(
      (await request("DELETE", `/api/agents/${a.id}?account=keep`)).statusCode,
      200,
    );
    assert.equal(fake.users.length, 1);
    assert.equal(
      (await request("DELETE", `/api/departments/${did}`)).statusCode,
      200,
    );
  } finally {
    await app.close();
    cleanup(config);
  }
});
test("Agent API acts only as its own identity; inboxes and read state are separate", async () => {
  const config = testConfig();
  const { app, store } = await createApp(config, {
    fetcher: fakeTududi().fetcher,
  });
  try {
    const headers = await owner(app, config.ownerPassword);
    const d = (
      await app.inject({
        method: "POST",
        url: "/api/departments",
        headers,
        payload: { name: "Bölüm", color: "#667788" },
      })
    ).json();
    const create = async (name: string) =>
      (
        await app.inject({
          method: "POST",
          url: "/api/agents",
          headers,
          payload: { ...input(d.id), name },
        })
      ).json() as Agent;
    const a = await create("A"),
      b = await create("B");
    const key = (
      await app.inject({
        method: "POST",
        url: `/api/agents/${a.id}/key`,
        headers,
      })
    ).json().key;
    const bkey = (
      await app.inject({
        method: "POST",
        url: `/api/agents/${b.id}/key`,
        headers,
      })
    ).json().key;
    const bearer = { authorization: `Bearer ${key}` };
    const internal = async (
      method: InjectOptions["method"],
      url: string,
      payload?: unknown,
    ) =>
      app.inject({
        method,
        url: "/api/internal" + url,
        headers: bearer,
        payload: payload as any,
      });
    assert.equal((await internal("GET", "/me")).json().agent.id, a.id);
    assert.equal(
      (await app.inject({ url: "/api/snapshot", headers: bearer })).statusCode,
      401,
    );
    assert.equal(
      (
        await internal("PATCH", "/status", {
          agent_id: b.id,
          status: "calisiyor",
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await internal("PATCH", "/status", {
          status: "calisiyor",
          current_job: "Kanıt arıyorum",
        })
      ).statusCode,
      200,
    );
    assert.equal(store.agent(a.id)!.status, "calisiyor");
    assert.equal(store.agent(b.id)!.status, "bosta");
    assert.equal(
      (
        await internal("POST", "/messages", {
          sender_agent_id: b.id,
          recipient_type: "everyone",
          text: "Sahte",
        })
      ).statusCode,
      400,
    );
    const sent = (
      await internal("POST", "/messages", {
        recipient_type: "agent",
        recipient_id: b.id,
        text: "Birlikte bakalım",
      })
    ).json();
    assert.equal(sent.sender_agent_id, a.id);
    assert.equal(
      (await internal("POST", `/inbox/${sent.id}/read`)).statusCode,
      404,
    );
    const broad = (
      await internal("POST", "/messages", {
        recipient_type: "everyone",
        text: "Ortak mesaj",
      })
    ).json();
    assert.equal(
      (await internal("POST", `/inbox/${broad.id}/read`)).statusCode,
      200,
    );
    const binbox = (
      await app.inject({
        url: "/api/internal/inbox",
        headers: { authorization: `Bearer ${bkey}` },
      })
    ).json();
    assert.equal(binbox.length, 2);
    assert.deepEqual(binbox.find((m: any) => m.id === broad.id).read_by, [
      a.id,
    ]);
    assert.equal(
      (
        await internal("POST", "/handoffs", {
          to_agent_id: b.id,
          title: "Yeni iş",
        })
      ).statusCode,
      201,
    );
    assert.equal(
      (await internal("POST", "/events", { agent_id: b.id, text: "Taklit" }))
        .statusCode,
      400,
    );
    assert.equal(
      (await internal("POST", "/events", { text: "Kanıt hazır" })).statusCode,
      201,
    );
    await app.inject({
      method: "POST",
      url: `/api/agents/${a.id}/key`,
      headers,
    });
    assert.equal((await internal("GET", "/me")).statusCode, 401);
    await app.inject({
      method: "PUT",
      url: `/api/agents/${b.id}`,
      headers,
      payload: { ...agentBody(b), active: false },
    });
    assert.equal(
      (
        await app.inject({
          url: "/api/internal/me",
          headers: { authorization: `Bearer ${bkey}` },
        })
      ).statusCode,
      401,
    );
    await app.inject({
      method: "DELETE",
      url: `/api/agents/${a.id}?account=keep`,
      headers,
    });
    const archived = store.messages().find((m) => m.id === sent.id)!;
    assert.equal(archived.sender_agent_id, null);
    assert.equal(archived.sender_type, "agent");
    assert.equal(archived.sender_name, "A");
  } finally {
    await app.close();
    cleanup(config);
  }
});
test("Interruptions preserve agents and handoffs; retries create one account/task", async () => {
  const config = testConfig();
  const fake = fakeTududi();
  const { app, store, office } = await createApp(config, {
    fetcher: fake.fetcher,
  });
  try {
    const headers = await owner(app, config.ownerPassword);
    const d = (
      await app.inject({
        method: "POST",
        url: "/api/departments",
        headers,
        payload: { name: "Bölüm", color: "#667788" },
      })
    ).json();
    fake.setUnavailable(true);
    const a = (
      await app.inject({
        method: "POST",
        url: "/api/agents",
        headers,
        payload: input(d.id),
      })
    ).json() as Agent;
    assert.equal(a.tududi_state, "pending");
    assert.ok(
      store.db
        .prepare("SELECT tududi_password_encrypted AS p FROM agents WHERE id=?")
        .get(a.id)!.p,
    );
    const handoff = await office.handoff(
      null,
      a.id,
      "Bekleyen iş",
      "Bağlantı gelince aktar",
    );
    assert.equal(handoff.status, "pending");
    assert.ok(store.agent(a.id));
    fake.setUnavailable(false);
    await Promise.all([office.provision(a.id), office.provision(a.id)]);
    assert.equal(fake.users.length, 1);
    assert.equal(store.agent(a.id)!.tududi_state, "ready");
    const results = await Promise.all([
      office.retryHandoff(handoff.id),
      office.retryHandoff(handoff.id),
    ]);
    assert.equal(results[0].tududi_task_uid, results[1].tududi_task_uid);
    assert.equal(
      (await office.tududi.read(office.token(a.id))).tasks.length,
      1,
    );
    fake.setUnavailable(true);
    const removed = await app.inject({ method: "DELETE", url: `/api/agents/${a.id}?account=delete`, headers });
    assert.equal(removed.statusCode, 200);
    assert.equal(removed.json().pending, true);
    assert.equal(store.agent(a.id), undefined);
    assert.equal(office.pendingDeletions().length, 1);
    fake.setUnavailable(false);
    store.db.prepare("UPDATE tududi_deletions SET next_at=0").run();
    await office.retryDeletions();
    assert.equal(office.pendingDeletions().length, 0);
    assert.equal(fake.users.length, 0);
  } finally {
    await app.close();
    cleanup(config);
  }
});
