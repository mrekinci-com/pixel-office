import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../../office/server/app.js";
import {
  testConfig,
  fakeTududi,
  input,
  cleanup,
} from "../../office/tests/helpers.js";
import { DirtyWorkspaceError, type gitCopies } from '../src/workspace.js';
import { Worker } from "../src/worker.js";
import { TududiClient } from "../../office/server/tududi.js";
import type { RunnerConfig } from "../src/config.js";
async function setup(runner: "claude" | "codex" = "codex", workspace?: typeof gitCopies) {
  mkdirSync(resolve(".test-data"), { recursive: true });
  const dir = mkdtempSync(resolve(".test-data/e2e-")),
    serverConfig = { ...testConfig(), runnerKey: "test-runner-key-".repeat(4) },
    fake = fakeTududi(),
    s = await createApp(serverConfig, { fetcher: fake.fetcher });
  const dept = randomUUID();
  s.store.db
    .prepare("INSERT INTO departments(id,name,description,color,sort_order) VALUES (?,?,?,?,?)")
    .run(dept, "Ekip", "", "#498f87", 0);
  const a = await s.office.createAgent({
      ...input(dept),
      runner,
      name: "Deniz",
    }),
    b = await s.office.createAgent({ ...input(dept), runner, name: "Ece" });
  const c: RunnerConfig = {
    url: "http://127.0.0.1:9400",
    key: serverConfig.runnerKey,
    workDir: join(dir, "work"),
    allowedRoots: [],
    protectedRoots: [],
    concurrency: 2,
    claude: "claude",
    codex: "codex",
    bwrap: "bwrap",
    codexModel: "secilen-model",
    claudeModels: ["secilen-model"],
    smoke: true,
  };
  c.allowedRoots = [join(dir, "allowed")];
  mkdirSync(c.allowedRoots[0]);
  c.codexAuth = join(dir, "dedicated-auth.json");
  writeFileSync(c.codexAuth, JSON.stringify({ OPENAI_API_KEY: "diagnostic-test-secret" }));
  const bridge = join(dir, "bridge");
  mkdirSync(bridge);
  const fetcher: typeof fetch = async (url, init) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const r = await s.app.inject({
      method: "POST",
      url: new URL(String(url)).pathname,
      headers,
      payload: JSON.parse(init?.body as string),
    });
    return new Response(r.body, {
      status: r.statusCode,
      headers: { "content-type": "application/json" },
    });
  };
  const launch: NonNullable<ConstructorParameters<typeof Worker>[2]> = (command, l, profile) => {
    const p = profile + "/mcp.json",
      cfg = JSON.parse(readFileSync(p, "utf8"));
    cfg.mcpServers.ofis.args = [resolve("dist/runner/src/mcp.js")];
    writeFileSync(p, JSON.stringify(cfg), { mode: 0o600 });
    writeFileSync(profile+"/scheduled-prompt.txt",l.prompt);
    return {
      ...command,
      bin: process.execPath,
      args: l.agent.runner==='claude' ? [resolve("tests/fixtures/claude.mjs"),...command.args] : [
        resolve("tests/fixtures/fake.mjs"),profile,l.run.summary,l.agent.runner,String(l.run.retry),
      ],
      env: {
        ...command.env,
        BRIDGE_DIR: bridge,
        FAKE_RESUME:l.session?.provider_id || '',
        FAKE_PROMPT_TOKENS:String(Math.ceil(l.prompt.length/4)),
        FAKE_CLAUDE_DELEGATE:'1',FAKE_CLAUDE_FILES:'1',FAKE_SUMMARY:l.run.summary,FAKE_RETRY:String(l.run.retry),
        NODE_OPTIONS: `--import=${resolve("tests/fixtures/bridge.mjs")}`,
      },
    };
  };
  const worker=new Worker(c,fetcher,launch,workspace);
  const pump = async () => {
    for (const file of readdirSync(bridge).filter((f) =>
      f.endsWith(".request"),
    )) {
      const p = join(bridge, file),
        request = JSON.parse(readFileSync(p, "utf8"));
      unlinkSync(p);
      const r = await s.app.inject({
        method: request.method || "POST",
        url: new URL(request.url).pathname,
        headers: request.headers,
        payload: request.body,
      });
      const responsePath = p.replace(".request", ".response");
      writeFileSync(
        responsePath + ".tmp",
        JSON.stringify({ status: r.statusCode, body: r.json() }),
        { mode: 0o600 },
      );
      renameSync(responsePath + ".tmp", responsePath);
    }
  };
  const until = async (check: () => boolean) => {
    const end = Date.now() + 10000;
    while (!check()) {
      if (Date.now() > end)
        throw new Error("The fake run did not finish in the expected state.");
      await pump();
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return {
    ...s,
    a,
    b,
    worker,
    makeWorker:()=>new Worker(c,fetcher,launch),
    fake,
    dir,
    pump,
    until,
    close: async () => {
      await worker.shutdown();
      await s.app.close();
      cleanup(serverConfig);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
for (const runner of ["claude", "codex"] as const)
  test(`${runner} fake CLI + real stdio MCP: message → memory/note/file → reply`, async () => {
    const c = await setup(runner);
    try {
      c.office.message(null, "agent", c.a.id, "merhaba");
      await c.worker.tick();
      await c.until(() => !c.worker.active.size);
      const r = c.runtime.runs()[0];
      assert.equal(r.state, "completed");
      assert.equal(c.runtime.memory(c.a.id), "deneme");
      assert.equal(
        (await c.office.tududi.read(c.office.token(c.a.id))).notes.filter(n => n.title === "Deneme notu").length,
        1,
      );
      assert.equal(c.runtime.artifacts().length, 1);
      assert.equal(c.store.messages().at(-1)?.text, "İş tamamlandı.");
      assert.equal(r.usage?.input_tokens, 10);
    } finally {
      await c.close();
    }
  });
test("Handoff chains run two agents; approval pauses work and decisions restart it", async () => {
  const c = await setup();
  try {
    c.office.message(null, "agent", c.a.id, `devret:${c.b.id}`);
    await c.worker.tick();
    await c.until(() => !c.worker.active.size);
    await c.worker.tick();
    await c.until(() => !c.worker.active.size);
    assert.equal(c.runtime.runs().length, 2);
    assert.equal(c.runtime.runs()[0].depth, 1);
    assert.equal(c.store.snapshot().handoffs.length, 1);
    c.office.message(null, "agent", c.a.id, "onay");
    await c.worker.tick();
    await c.until(() => !c.worker.active.size);
    const approval = c.runtime.approvals()[0];
    assert.equal(approval.state, "pending");
    assert.equal(c.store.agent(c.a.id)?.status, "bekliyor");
    c.runtime.decide(approval.id, false, "Henüz paylaşma");
    await c.worker.tick();
    await c.until(() => !c.worker.active.size);
    assert.equal(c.runtime.runs()[0].state, "completed");
  } finally {
    await c.close();
  }
});
test("Timeout/emergency stop terminates child processes and freezes the queue", async () => {
  const c = await setup();
  try {
    c.runtime.heartbeat(c.worker.id);
    c.runtime.enqueue(c.a.id, "Elle", "uyku");
    const lease = c.runtime.claim(c.worker.id)!;
    lease.policy.timeoutMinutes = 0.002;
    await c.worker.execute(lease);
    assert.equal(c.runtime.run(lease.run.id).state, "failed");
    assert.match(c.runtime.run(lease.run.id).reason, /süresi aşıldı/);
    c.office.message(null, "agent", c.a.id, "uyku");
    await c.worker.tick();
    assert.equal(c.worker.active.size, 1);
    c.runtime.stop();
    await c.worker.tick();
    await c.until(() => !c.worker.active.size);
    assert.equal(c.runtime.runs()[0].state, "stopped");
    assert.equal(c.runtime.paused(), true);
  } finally {
    await c.close();
  }
});

test("Single-command smoke driver: fake CLI, real MCP, cleanup and real-evidence distinction", async () => {
  const c = await setup();
  const login = await c.app.inject({ method: "POST", url: "/api/login", headers: { "x-ofis-islem": "1" }, payload: { password: c.office.config.ownerPassword } });
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  const api = async (path: string, method: any = "GET", body?: unknown, asText = false) => {
    if (method === "POST" && body === undefined) body = {};
    const r = await c.app.inject({ url: "/api" + path, method, headers: { cookie, "x-ofis-islem": "1", "x-ofis-duman": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
    if (r.statusCode >= 400) throw Object.assign(new Error(r.json().error), { status: r.statusCode, retryAfterMs: Number(r.headers['retry-after'] || 0) * 1000 });
    return asText ? r.body : r.json();
  };
  let pumping = false;
  const timer = setInterval(() => {
    if (pumping) return;
    pumping = true;
    void c.pump().then(() => c.worker.tick()).finally(() => { pumping = false; });
  }, 10);
  try {
    await c.worker.tick();
    // @ts-expect-error JavaScript smoke driver deliberately has no generated declarations.
    const { runSmoke } = await import("../scripts/smoke-real.mjs");
    let limited = false, deleteRequests = 0, transient = false;
    c.office.tududi = new TududiClient(c.office.config, async (url, init) => {
      if (init?.method === 'DELETE' && new URL(String(url)).pathname.startsWith('/api/admin/users/')) {
        deleteRequests++;
        if (!limited) { limited = true; return new Response('{}', { status: 429, headers: { 'retry-after': '1' } }); }
      }
      return c.fake.fetcher(url, init);
    });
    const flakyApi = async (path: string, method: any, body?: unknown, asText = false) => {
      if (!transient && method === 'DELETE' && path.startsWith('/links/')) {
        transient = true;
        throw Object.assign(new Error('Kısa süreli giriş sınırı'), { status: 429, retryAfterMs: 1 });
      }
      const result = await api(path, method, body, asText);
      if (path.startsWith('/runs/') && !asText)
        result.logs.push({ kind: 'diagnostic', text: 'password="duman-test-secret" sk-abcdefghijklmnopqrstuv' });
      return result;
    };
    const accounts = c.fake.users.length;
    const reports: string[] = [];
    const rows = await runSmoke({ api: flakyApi, runner: "all", roots: c.worker.config.allowedRoots, workDir: c.worker.config.workDir, simulated: true, timeoutMs: 10000,
      archiveRoot: join(c.dir, 'duman'),
      pause: () => new Promise(r => setTimeout(r, 5)), report: (text: string) => reports.push(text) });
    const failed = rows.filter((r: any) => r.sonuc === "FAIL");
    assert.ok(rows.some((r:any)=>r.senaryo==='File handoff: recipient reads and delivers the incoming file' && r.sonuc==='UNTESTED'));
    // No fake result may claim to have proven real isolation.
    assert.deepEqual(failed.map((r: any) => r.senaryo), ["Unapproved folder writes: direct operating-system probe","Isolation probes: files, writes and network"], JSON.stringify(failed));
    assert.match(failed[0].tani, /cannot prove/);
    assert.ok(reports.some((text) => /Total runs: \d+/.test(text)));
    assert.equal(c.fake.users.length, accounts);
    assert.equal(deleteRequests, 15); assert.ok(transient); assert.equal(c.office.pendingDeletions().length, 0);
    assert.equal(c.store.agents().filter(a=>!a.builtin).length, 2);
    assert.equal(c.store.departments().filter(d=>d.id!==c.runtime.director.agent().department_id).length, 1);
    assert.equal(c.runtime.links().length, 0);
    assert.ok(!readdirSync(c.worker.config.allowedRoots[0]).length);
    const archive = join(c.dir, 'duman', readdirSync(join(c.dir, 'duman'))[0]);
    const runFiles=readdirSync(archive).filter((f)=>f.endsWith('.json') && !['sonuclar.json','token-karsilastirma.json'].includes(f));
    assert.ok(runFiles.length>=70 && runFiles.length<=90,`Expected 70–90 runs, observed ${runFiles.length}`);
    const saved = JSON.parse(readFileSync(join(archive, 'sonuclar.json'), 'utf8'));
    for (const file of readdirSync(archive)) {
      const text = readFileSync(join(archive, file), 'utf8');
      assert.doesNotThrow(() => JSON.parse(text));
      for (const secret of ['duman-test-secret', 'sk-abcdefghijklmnopqrstuv', 'diagnostic-test-secret']) assert.ok(!text.includes(secret));
    }
    assert.equal(saved.simulated, true);
    const comparison=JSON.parse(readFileSync(join(archive,'token-karsilastirma.json'),'utf8'));
    assert.equal(comparison.simulated,true);assert.equal(comparison.comparisons.length,12);
    console.log(`A3.1 fake smoke: ${runFiles.length} runs, ${comparison.comparisons.length} comparison rows; not evidence of real token savings.`);
    for(const provider of ['codex','claude'])for(const steps of [2,6])assert.deepEqual(comparison.comparisons.filter((c:any)=>c.provider===provider && c.steps===steps).map((c:any)=>c.mode),['single','work','persistent']);
    for(const row of comparison.comparisons) {assert.equal(row.input_tokens,row.cached_input_tokens+row.uncached_input_tokens);assert.equal(row.step_run_ids.length,row.steps);assert.ok(row.runs.length>=row.steps);}
    assert.ok(Object.values(saved.leftovers).every((items: any) => items.length === 0));
  } finally { clearInterval(timer); while (pumping) await new Promise(r => setTimeout(r, 5)); await c.close(); }
});

test("Failed CLI reports redacted stderr diagnostics and a clean shutdown record", async () => {
  const c = await setup();
  try {
    c.office.message(null, "agent", c.a.id, "hata");
    await c.worker.tick();
    await c.until(() => !c.worker.active.size);
    const r = c.runtime.runs().find((r) => r.state === 'failed')!;
    assert.equal(r.state, "failed");
    assert.match(r.reason, /ayarları/);
    const logs = c.runtime.db.prepare("SELECT text FROM run_logs WHERE run_id=? AND kind='diagnostic'").all(r.id);
    const text = logs.map(l => l.text).join("\n");
    assert.ok(text.includes("unknown config"));
    for (const secret of ["diagnostic-test-secret", "sk-abcdefghijklmnopqrstuv", "sahte-parola"]) assert.ok(!text.includes(secret));
    assert.ok(text.includes("process_exit"));
    await c.worker.shutdown();
    assert.equal(c.runtime.runnerId, "");
    assert.equal(c.runtime.snapshot().connecting, true);
  } finally { await c.close(); }
});

const scenarioNames: Record<string, string> = {
  'cokus-sonra': 'crash after answer', 'cokus-tur': 'crash after turn',
  'cokus-satirsonusuz': 'crash without final newline', 'cokus-once': 'initial crash',
  'cokus-surekli': 'repeated crash', 'gecici-mcp': 'transient MCP failure',
  'token-akis': 'token stream', kota: 'quota', 'kota-son-satir': 'quota on final line',
  uyku: 'sleep', hata: 'error', normal: 'normal',
};
for (const summary of ['cokus-sonra', 'cokus-tur', 'cokus-satirsonusuz'])
  test(`A2.2: ${scenarioNames[summary] || summary}, exit 134 does not invalidate completed work`, async () => {
    const c = await setup();
    try {
      c.runtime.enqueue(c.a.id, 'Elle', summary);
      await c.worker.tick(); await c.until(() => !c.worker.active.size);
      const r = c.runtime.runs()[0];
      assert.equal(r.state, 'completed');
      assert.equal(c.runtime.runs().length, 1);
      if (summary !== 'cokus-tur') assert.equal(r.output, 'Son cevap.');
      else assert.equal(r.usage.input_tokens, 12);
      const text = c.store.db.prepare('SELECT text FROM run_logs WHERE run_id=?').all(r.id).map((l) => l.text).join('\n');
      assert.match(text, /kapanırken çöktü/); assert.match(text, /"code":134/);
    } finally { await c.close(); }
  });

for (const summary of ['cokus-once', 'cokus-surekli'])
  test(`A2.2: ${scenarioNames[summary] || summary}, crashes before completion retry only once`, async () => {
    const c = await setup();
    try {
      const root = c.runtime.enqueue(c.a.id, 'Elle', summary)!;
      await c.worker.tick(); await c.until(() => !c.worker.active.size);
      assert.equal(c.runtime.run(root.id).state, 'failed');
      const retry = c.runtime.runs().find((r) => r.retry === 1)!;
      assert.equal(retry.state, 'queued'); assert.equal(retry.chain_id, root.chain_id); assert.equal(retry.depth, 0);
      await c.worker.tick(); await c.until(() => !c.worker.active.size);
      assert.equal(c.runtime.run(retry.id).state, summary === 'cokus-once' ? 'completed' : 'failed');
      assert.equal(c.runtime.runs().length, 2);
      await c.worker.tick(); assert.equal(c.worker.active.size, 0);
    } finally { await c.close(); }
  });

test("A2.2: model errors/timeouts fail even after final messages; production ignores smoke fields", async () => {
  const c = await setup();
  try {
    c.runtime.enqueue(c.a.id, 'Elle', 'cokus-hata-sonra');
    await c.worker.tick(); await c.until(() => !c.worker.active.size);
    assert.equal(c.runtime.runs()[0].state, 'failed'); assert.equal(c.runtime.runs().length, 1);
    c.runtime.enqueue(c.a.id, 'Elle', 'cokus-bekle');
    const lease = c.runtime.claim(c.worker.id)!;
    c.worker.config.smoke = false;
    lease.smokeTimeoutSeconds = 0.01; lease.policy.timeoutMinutes = 0.005;
    await c.worker.execute(lease);
    const r = c.runtime.run(lease.run.id);
    assert.equal(r.state, 'failed'); assert.match(r.reason, /süresi aşıldı/);
    assert.ok(r.duration_ms >= 200);
    const logs = c.store.db.prepare('SELECT text FROM run_logs WHERE run_id=?').all(r.id).map((l) => String(l.text)).join('\n');
    assert.ok(!logs.includes('smoke_timeout')); assert.match(logs, /"signal":"SIGKILL"/);
  } finally { await c.close(); }
});

for (const scenario of ["gecici-mcp", "token-akis"])
  test(`A2.3: real fake-process ${scenarioNames[scenario] || scenario} stop and retry`, async () => {
    const c = await setup();
    try {
      const root = c.runtime.enqueue(c.a.id, "Elle", scenario)!;
      await c.worker.tick(); await c.until(() => !c.worker.active.size);
      assert.equal(c.runtime.run(root.id).state, scenario === "token-akis" ? "budget_exceeded" : "failed");
      if (scenario === "token-akis") {
        assert.match(c.runtime.run(root.id).reason, /Token bütçesi/);
        const logs = c.store.db.prepare("SELECT text FROM run_logs WHERE run_id=?").all(root.id).map((r) => r.text).join("\n");
        assert.match(logs, /SIGKILL/); assert.equal(c.runtime.runs().length, 2);
        const retry=c.runtime.runs().find(r=>r.id!==root.id)!;assert.equal(retry.state,'queued');assert.equal(retry.work_item_id,c.runtime.run(root.id).work_item_id);
        assert.equal(c.runtime.a3.session(c.a.id).provider_id,null);
      } else {
        const child = c.runtime.runs().find((r) => r.state === "queued")!;
        assert.equal(child.startup_retry, 1); assert.equal(child.chain_id, root.chain_id);
        assert.ok(child.not_before! > Date.now());
      }
    } finally { await c.close(); }
  });

for(const scenario of ['kota','kota-son-satir'])test(`A3: ${scenarioNames[scenario] || scenario} process exits; same work queues without consuming a retry`,async()=>{
  const c=await setup();try{
    c.office.message(null,'agent',c.a.id,scenario);await c.worker.tick();await c.until(()=>!c.worker.active.size);
    const r=c.runtime.runs()[0];assert.equal(r.state,'queued');assert.equal(r.retry,0);assert.equal(c.runtime.a3.pauses()[0].provider,'codex');
    assert.equal(c.runtime.claim(c.worker.id),null);assert.equal(c.runtime.runs().length,1);
  }finally{await c.close();}
});

test("A3: reset removes old profiles before starting new model work",async()=>{
  const c=await setup();try{
    const session=c.runtime.a3.session(c.a.id),old=join(c.worker.config.workDir,'.oturum',c.a.id,String(session.generation));
    mkdirSync(old,{recursive:true,mode:0o700});writeFileSync(join(old,'eski-konuşma.txt'),'Eski konuşma');
    c.runtime.a3.rotate(c.a.id);await c.worker.tick();
    assert.equal(existsSync(old),false);assert.equal(c.runtime.runs().length,0);
  }finally{await c.close();}
});

for(const provider of ['codex','claude'] as const)test(`A3.1: ${provider} work profiles persist; restarted runners resume old work with the same identity`,async()=>{
  const c=await setup(provider);let resumed:Worker | undefined;
  try {
    const first=c.runtime.enqueue(c.a.id,'Elle',`İlk iş\nDUMAN ${JSON.stringify({scenario:'oturum-ilk',memory:'birinci-is-bilgisi'})}`)!;
    await c.worker.tick();await c.until(()=>!c.worker.active.size);
    assert.equal(c.runtime.run(first.id).state,'completed');const one=c.runtime.a3.session(c.a.id);
    const firstProfile=join(c.worker.config.workDir,'.oturum',c.a.id,String(one.generation));assert.ok(existsSync(firstProfile));
    c.runtime.enqueue(c.a.id,'Elle',`İkinci iş\nDUMAN ${JSON.stringify({scenario:'oturum-ilk',memory:'ikinci-is-bilgisi'})}`);
    await c.worker.tick();await c.until(()=>!c.worker.active.size);const two=c.runtime.a3.session(c.a.id);
    assert.notEqual(two.provider_id,one.provider_id);assert.ok(existsSync(firstProfile));
    const secondProfile=join(c.worker.config.workDir,'.oturum',c.a.id,String(two.generation));
    await c.worker.shutdown();resumed=c.makeWorker();
    c.runtime.enqueue(c.a.id,'Devam','Eski işe dönüş\nDUMAN {"scenario":"oturum-sonraki"}',c.runtime.run(first.id),undefined,false);
    await resumed.tick();await c.until(()=>!resumed!.active.size);
    const result=c.runtime.runs()[0];assert.equal(result.state,'completed');assert.equal(result.output,'birinci-is-bilgisi');
    const after=c.runtime.a3.session(c.a.id);assert.equal(after.provider_id,one.provider_id);assert.ok(existsSync(secondProfile));
    after.closed=true;c.runtime.a3.saveSession(after);await resumed.tick();
    assert.equal(existsSync(firstProfile),false);assert.equal(existsSync(secondProfile),true);
  }finally{await resumed?.shutdown();await c.close();}
});

for(const runner of ['codex','claude'] as const)test(`B1: ${runner} scheduler → fake CLI → MCP work note → owner message → second fresh run`,async()=>{
 const c=await setup(runner);try{
  let at=Date.parse('2026-10-12T05:59:00Z');c.runtime.clock=()=>at;c.runtime.scheduler.clock=()=>at;
  const plan=(note:string,reply:string,expect='')=>'DUMAN '+JSON.stringify({scenario:'zamanlanmis',note,reply,expect});
  const task=c.runtime.scheduler.upsert({name:'Düzenli kontrol',agent_id:c.a.id,instruction:plan('İlk doğrulanmış bulgu','İlk sonuç'),timing:{kind:'daily',time:'09:00'}});
  at=Date.parse('2026-10-12T06:00:00Z');await c.worker.tick();await c.until(()=>!c.worker.active.size);c.runtime.scheduler.reconcile();
  assert.equal(c.runtime.scheduler.history(task.id)[0].state,'completed',JSON.stringify(c.runtime.scheduler.history(task.id)[0])+' '+JSON.stringify(c.store.db.prepare('SELECT kind,text FROM run_logs WHERE run_id=?').all(c.runtime.runs()[0].id)));assert.ok(c.store.messages().at(-1)!.text.includes('Zamanlanmış: Düzenli kontrol'));assert.ok(c.runtime.scheduler.note(task.id).includes('İlk doğrulanmış bulgu'));
  assert.equal(c.runtime.a3.sessions().length,0);const first=c.runtime.runs()[0];assert.equal(first.trigger,'Zamanlanmış görev: Düzenli kontrol');
  c.runtime.scheduler.upsert({name:task.name,agent_id:task.agent_id,instruction:plan('İkinci doğrulanmış bulgu','İkinci sonuç','İlk doğrulanmış bulgu'),timing:task.timing},task.id);
  at=Date.parse('2026-10-13T06:00:00Z');await c.worker.tick();await c.until(()=>!c.worker.active.size);c.runtime.scheduler.reconcile();
  assert.equal(c.runtime.scheduler.history(task.id).filter(h=>h.state==='completed').length,2);assert.equal((await c.runtime.notebook.data(c.a.id)).tasks.filter(t=>t.name==='Zamanlanmış: Düzenli kontrol').length,1);assert.ok(c.runtime.scheduler.note(task.id).includes('İkinci doğrulanmış bulgu'));assert.ok(c.store.messages().at(-1)!.text.includes('İkinci sonuç'));assert.equal(c.runtime.a3.sessions().length,0);assert.notEqual(c.runtime.runs()[0].chain_id,first.chain_id);
 }finally{await c.close();}
});

for(const scenario of ['token-akis','uyku','hata','cokus-once','normal'])test(`B1.3: ${scenarioNames[scenario] || scenario} completion records Git changes`,async()=>{
  const calls:{finish:boolean;reason:string}[]=[];
  const workspace:typeof gitCopies=async(_lease,_config,finish,_secrets,reason='')=>{calls.push({finish,reason});return finish ? ['Kayıt: '+ 'b'.repeat(40)] : [];};
  const c=await setup('codex',workspace);try {
    const root=c.runtime.enqueue(c.a.id,'Elle',scenario)!;
    await c.worker.tick();
    if(scenario==='uyku')await c.worker.shutdown();else await c.until(()=>!c.worker.active.size);
    assert.equal(calls.filter(c=>c.finish).length,1);assert.equal(calls[0].finish,false);
    assert.ok(c.store.db.prepare("SELECT 1 FROM run_logs WHERE run_id=? AND kind='git_change'").get(root.id));
    if(scenario==='token-akis') {
      assert.equal(c.runtime.run(root.id).state,'budget_exceeded');
      assert.match(c.runtime.run(root.id).output,/Bütçe öncesi son cevap/);
      assert.ok(c.store.messages().some(m=>m.text==='Bütçe öncesi son cevap.'));
      assert.match(calls.find(c=>c.finish)!.reason,/Token bütçesi/);
    }
  }finally{await c.close();}
});
test("B1.3: external dirty trees are not saved without permission; explicit save requests work",async()=>{
  let saved=false,checks=0;
  const workspace:typeof gitCopies=async(_lease,_config,finish)=>{if(finish){saved=true;return ['Kayıt: '+ 'c'.repeat(40)];}checks++;if(!saved)throw new DirtyWorkspaceError();return [];};
  const c=await setup('codex',workspace);try {
    const root=c.runtime.enqueue(c.a.id,'Elle','normal')!;await c.worker.tick();await c.until(()=>!c.worker.active.size);
    assert.equal(saved,false);assert.equal(checks,1);assert.match(c.runtime.run(root.id).reason,/kaydedilmemiş/);
    assert.ok(c.store.db.prepare("SELECT 1 FROM run_logs WHERE run_id=? AND kind='workspace_dirty'").get(root.id));
    const next=c.runtime.enqueue(c.a.id,'Elle','normal')!;c.runtime.log(next.id,'workspace_save_authorized','Sahip istedi');
    await c.worker.tick();await c.until(()=>!c.worker.active.size);assert.equal(saved,true);assert.equal(c.runtime.run(next.id).state,'completed');
  }finally{await c.close();}
});

test("B1.3: real timeout timer terminates the process and records the timeout reason with files",async()=>{
  const reasons:string[]=[];const workspace:typeof gitCopies=async(_l,_c,finish,_s,reason='')=>{if(finish)reasons.push(reason);return [];};
  const c=await setup('codex',workspace);try {
    c.runtime.heartbeat(c.worker.id);c.runtime.enqueue(c.a.id,'Elle','uyku');const lease=c.runtime.claim(c.worker.id)!;lease.policy.timeoutMinutes=.002;
    await c.worker.execute(lease);assert.equal(reasons.length,1);assert.match(reasons[0],/süresi aşıldı/);assert.equal(c.runtime.run(lease.run.id).state,'failed');
  }finally{await c.close();}
});

test("C1: real-process Claude JSON split into individual bytes preserves Turkish characters",async()=>{
 const c=await setup('claude');try{
  c.office.message(null,'agent',c.a.id,'utf8-parca');await c.worker.tick();await c.until(()=>!c.worker.active.size);
  const r=c.runtime.runs().find(r=>r.agent_id===c.a.id)!;assert.equal(r.state,'completed');assert.equal(r.output,'Şirketin işi: ığüşöç İĞÜŞÖÇ.');assert.equal(r.usage.input_tokens,10);
 }finally{await c.close();}
});
