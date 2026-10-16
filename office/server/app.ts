import { messageInfo } from "../shared/i18n/messages.js";
import { translate } from "../shared/i18n/index.js";
import websocket from "@fastify/websocket";
import { terminalRoutes } from "./terminal.js";
import { toolGroups } from "../shared/director.js";
import { directorRoutes } from "./director-api.js";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Agent } from "../shared/types.js";
import { statuses, statusLabels } from "../shared/types.js";
import type { Config } from "./config.js";
import { serverBuildId } from "./build-version.js";
import { scheduleRoutes } from "./schedules.js";
import { Store } from "./db.js";
import { equals, hash, newKey, canonicalRequestPath } from "./security.js";
import { Office, Problem } from "./service.js";
import { TududiClient, TududiError, type Fetcher } from "./tududi.js";
import { factoryResetRoutes } from "./factory-reset.js";
import { Runtime } from "./runtime.js";
import { runtimeRoutes } from "./runtime-api.js";
import { policySchema, workOptionsSchema } from "./runtime-schemas.js";
const text = (max = 200) => z.string().trim().min(1).max(max);
const id = z.string().uuid();
export const departmentSchema = z
  .object({
    name: text(80),
    description: z.string().max(2000).default(""),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
    responsible_agent_id: id.nullable().optional(),
    sort_order: z.number().int().min(0).max(10000).default(0),
  })
  .strict();
export const agentSchema = z
  .object({
    tool_groups: z.array(z.enum(toolGroups)).max(5).optional(),
    username: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(40).optional(),
    session_mode: z.enum(["work", "persistent", "single"]).default("work"),
    watch_tasks: z.boolean().default(false),
    watch_due: z.boolean().default(false),
    name: text(80),
    title: text(120),
    policy: policySchema.optional(),
    department_id: id,
    prompt: z.string().max(60000).default(""),
    runner: z.enum(["claude", "codex"]),
    model: text(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
    appearance: z
      .object({
        skin: z.string().regex(/^#[0-9a-f]{6}$/i),
        hair: z.string().regex(/^#[0-9a-f]{6}$/i),
        shirt: z.string().regex(/^#[0-9a-f]{6}$/i),
        style: z.enum(["kisa", "uzun", "topuz", "kivircik", "kel", "sapkali"]),
        pants: z
          .string()
          .regex(/^#[0-9a-f]{6}$/i)
          .optional(),
        glasses: z.boolean().optional(),
        tie: z.boolean().optional(),
        headphones: z.boolean().optional(),
      })
      .strict(),
    desk_x: z.number().int().min(0).max(100).default(0),
    desk_y: z.number().int().min(0).max(100).default(0),
    status: z.enum(statuses).default("bosta"),
    current_job: z.string().max(2000).default(""),
    active: z.boolean().default(true),
  })
  .strict();
const messageSchema = z
  .object({
    recipient_type: z.enum(["agent", "department", "everyone"]),
    recipient_id: id.nullable().default(null),
    text: text(10000),
  })
  .strict()
  .refine((v) => v.recipient_type === "everyone" || v.recipient_id !== null);
const handoffSchema = z
  .object({
    secenekler: workOptionsSchema.optional(),
    to_agent_id: id,
    title: text(200),
    description: z.string().max(20000).default(""),
  })
  .strict();
const taskSchema = z
  .object({
    name: text(200),
    description: z.string().max(20000).optional(),
    project_uid: text(120).optional(),
  })
  .strict();
const noteSchema = z
  .object({
    title: text(200),
    content: text(60000),
    project_uid: text(120).optional(),
  })
  .strict();
declare module "fastify" {
  interface FastifyRequest {
    ownerSession?: string;
    resetTracked?: boolean;
    internalAgent?: Agent;
  }
}
export async function createApp(
  config: Config,
  options: { fetcher?: Fetcher; staticDir?: string; background?: boolean; scheduleClock?:()=>number; buildId?:string } = {},
) {
  const app = Fastify({ logger: false, bodyLimit: 150000 });
  const store = new Store(config.dataDir);
  const office = new Office(
    store,
    config,
    new TududiClient(config, options.fetcher, () => store.language()),
  );
  if (!store.languageInitialized()) office.setLanguage(store.language());
  office.ensureDirector();
  const runtime = new Runtime(office,options.scheduleClock);
  const reaper = setInterval(() => {
    if(options.background===false || office.resetBlocked())return;
    runtime.reap();
    void office.track(office.retryDeletions()).catch(() => {});
    void office.track(runtime.director.syncLedger()).catch(()=>{});
    void office.track(runtime.director.expireTrash()).catch(()=>{});
    void office.track(runtime.notebook.poll()).catch(() => {});
    void office.track(runtime.scheduler.syncTasks()).catch(()=>{});
  }, 5000);
  reaper.unref();
  const streams = new Set<{ close: () => void; session: string }>();
  await app.register(websocket,{options:{maxPayload:100000}});
  await app.register(cookie, { secret: config.secretKey });
  await app.register(rateLimit, { global: false });
  app.addHook("onRequest", async (req, reply) => {
    const path = canonicalRequestPath(req.url);
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "same-origin")
      .header("X-Frame-Options", "DENY")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
      );
    if (path === null) throw new Problem(400, office.t("Adres bulunamadı."));
    if (!path.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    if (path.startsWith("/api/runner/")) {
      const raw = req.headers.authorization?.replace(/^Bearer /, "") || "";
      if (
        !config.runnerKey ||
        config.runnerKey.length < 32 ||
        !equals(raw, config.runnerKey)
      )
        throw new Problem(401, office.t("Çalıştırıcı anahtarı geçersiz."));
      return;
    }
    if (path.startsWith("/api/agent-tools/")) {
      runtime.authenticate(
        req.headers.authorization?.replace(/^Bearer /, "") || "",path==='/api/agent-tools/catalog',
      );
      return;
    }
    if (path.startsWith("/api/internal/")) {
      if (config.runnerKey)
        throw new Problem(
          410,
          office.t("Kalıcı ajan anahtarları kapalı. Kısa ömürlü ofis araçlarını kullanın."),
        );
      const raw = req.headers.authorization?.replace(/^Bearer /, "");
      const row =
        raw &&
        store.db
          .prepare("SELECT id FROM agents WHERE agent_key_hash=? AND active=1")
          .get(hash(raw));
      if (!row) throw new Problem(401, office.t("Ajan anahtarı geçersiz."));
      req.internalAgent = office.agent(row.id as string);
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      if (
        req.headers["x-ofis-islem"] !== "1" ||
        (origin &&
          origin !==
            (config.publicOrigin || `${req.protocol}://${req.headers.host}`))
      )
        throw new Problem(403, office.t("İstek doğrulanamadı. Sayfayı yenileyin."));
    }
    if (path === "/api/login" || (path === "/api/language" && req.method === "GET")) return;
    const signed =
      req.cookies.ofis_session && req.unsignCookie(req.cookies.ofis_session);
    const session = signed && signed.valid && signed.value;
    const row =
      session &&
      store.db
        .prepare("SELECT expires_at FROM sessions WHERE id_hash=?")
        .get(hash(session));
    if (!row || Number(row.expires_at) <= Date.now())
      throw new Problem(401, office.t("Lütfen giriş yapın."));
    req.ownerSession = hash(session);
  });
  app.addHook('preHandler', async req => {
    const path=canonicalRequestPath(req.url)!;
    if(path.startsWith('/api/factory-reset') || ['/api/runner/heartbeat','/api/runner/reset-idle','/api/runner/finish'].includes(path))return;
    if(office.resetBlocked() && path.startsWith('/api/') && !(path==='/api/language' && req.method==='GET') && !['/api/session','/api/snapshot','/api/logout','/api/login'].includes(path))throw new Problem(409,office.t('Sıfırlama sürüyor; işlemler geçici olarak duraklatıldı.'));
    // Long-lived WebSocket upgrades (GM terminal, runner terminal bridge) never finish while open; counting them would block a factory reset forever.
    if(path.startsWith('/api/') && path!=='/api/live' && String(req.headers.upgrade||'').toLowerCase()!=='websocket'){office.inFlight++;req.resetTracked=true;}
  });
  app.addHook('onResponse',async req=>{if(req.resetTracked)office.inFlight--;});
  factoryResetRoutes(app,runtime);
  app.addHook("onSend", async (req, reply, payload) => {
    if (store.languageInitialized() && reply.statusCode < 400 && ["/api/login","/api/language","/api/runtime/settings","/api/snapshot"].includes(canonicalRequestPath(req.url) || '')) {
      reply.setCookie("ofis_language", office.language, {path:"/",httpOnly:true,sameSite:"strict",secure:config.secureCookie,maxAge:365*24*60*60});
    }
    if (reply.statusCode < 400 || typeof payload !== "string" || !String(reply.getHeader("content-type") || "").includes("application/json")) return payload;
    try {
      const body = JSON.parse(payload);
      if (typeof body.error !== "string") return payload;
      const language = office.language;
      return JSON.stringify({...body, ...messageInfo(language, body.error)});
    } catch { return payload; }
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: office.t("Alanları kontrol edin. Eksik ya da geçersiz bilgi var."),
        fields: error.issues.map((i) => i.path.join(".")),
      });
    if (error instanceof Problem)
      return reply.code(error.status).send({ error: error.message });
    if (error instanceof TududiError) {
      if (error.status === 429) reply.header("Retry-After", String(error.retryAfterSeconds));
      return reply.code(error.status === 429 ? 429 : 502).send({ error: error.message });
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 429)
      return reply.code(429).send({
        error: office.t("Çok fazla deneme yapıldı. Biraz bekleyip tekrar deneyin."),
      });
    if (statusCode && statusCode < 500)
      return reply
        .code(statusCode)
        .send({ error: office.t("İstek işlenemedi. Bilgileri kontrol edin.") });
    return reply
      .code(500)
      .send({ error: office.t("İşlem tamamlanamadı. Lütfen tekrar deneyin.") });
  });
  app.post(
    "/api/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { password } = z
        .object({ password: z.string().max(1024) })
        .strict()
        .parse(req.body);
      if (!equals(password, config.ownerPassword))
        throw new Problem(401, office.t("Şifre yanlış."));
      const token = newKey();
      store.db
        .prepare("DELETE FROM sessions WHERE expires_at<?")
        .run(Date.now());
      store.db
        .prepare("INSERT INTO sessions VALUES (?,?)")
        .run(hash(token), Date.now() + 12 * 60 * 60 * 1000);
      reply.setCookie("ofis_session", token, {
        signed: true,
        httpOnly: true,
        secure: config.secureCookie,
        sameSite: "strict",
        path: "/",
        maxAge: 12 * 60 * 60,
      });
      return { ok: true };
    },
  );
  app.get("/api/language", async () => ({ language: store.language() }));
  app.put("/api/language", async (req) => {
    const { language } = z.object({language:z.enum(["tr","en"])}).strict().parse(req.body);
    office.setLanguage(language);
    return {language};
  });
  const buildId=options.buildId || serverBuildId(options.staticDir || resolve("dist/client"));
  app.get("/api/session", async () => ({ ok: true, build_id:buildId }));
  app.post("/api/logout", async (req, reply) => {
    store.db
      .prepare("DELETE FROM sessions WHERE id_hash=?")
      .run(req.ownerSession!);
    runtime.terminal?.logout(req.ownerSession!);
    for (const s of streams) if (s.session === req.ownerSession) s.close();
    reply.clearCookie("ofis_session", { path: "/" });
    return { ok: true };
  });
  app.get("/api/snapshot", async () => ({
    ...store.snapshot(),
    events: store.events().map(e => ({...e, text:runtime.publicText(e.text)})),
    messages: store.messages().map((m) => ({ ...m, text: runtime.publicText(m.text) })),
    handoffs: store.snapshot().handoffs.map((h) => ({ ...h, title: runtime.publicText(h.title), description: runtime.publicText(h.description), note: runtime.publicText(h.note || "") })),
    runtime: runtime.snapshot(),
  }));
  runtimeRoutes(app, runtime);
  scheduleRoutes(app,runtime);
  directorRoutes(app,runtime);
  terminalRoutes(app,runtime);
  app.get("/api/events", async (req) => {
    const query = z
      .object({ agent_id: id.optional(), department_id: id.optional() })
      .parse(req.query);
    return store
      .events().map(e => ({...e, text:runtime.publicText(e.text)}))
      .filter(
        (e) =>
          (!query.agent_id || e.agent_id === query.agent_id) &&
          (!query.department_id || e.department_id === query.department_id),
      );
  });
  app.get("/api/live", async (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write("retry: 3000\nevent: ready\ndata: {}\n\n");
    const listener = (data: unknown) => {
      if (reply.raw.writableLength > 1024 * 1024) {
        close();
        return;
      }
      reply.raw.write(`event: update\ndata: ${JSON.stringify(data)}\n\n`);
    };
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      office.bus.off("update", listener);
      streams.delete(stream);
      reply.raw.end();
    };
    const stream = { close, session: req.ownerSession! };
    const timer = setInterval(() => {
      const session = store.db
        .prepare("SELECT expires_at FROM sessions WHERE id_hash=?")
        .get(stream.session);
      if (!session || Number(session.expires_at) <= Date.now()) return close();
      reply.raw.write(": canlı\n\n");
    }, 15000);
    timer.unref();
    office.bus.on("update", listener);
    streams.add(stream);
    reply.raw.on("close", close);
  });
  app.post("/api/departments", async (req, reply) => {
    const d = departmentSchema.parse(req.body);
    if (d.responsible_agent_id) throw new Problem(400, office.t("Önce bölümü oluşturun, sonra bu bölümdeki sorumlu ajanı seçin."));
    const departmentId = randomUUID();
    store.db
      .prepare("INSERT INTO departments(id,name,description,color,sort_order) VALUES (?,?,?,?,?)")
      .run(departmentId, d.name, d.description, d.color, d.sort_order);
    office.event(null, "department_created", office.t("{0} bölümü açıldı.", [d.name]));
    return reply.code(201).send({ ...d, id: departmentId });
  });
  app.put<{ Params: { id: string } }>("/api/departments/:id", async (req) => {
    const d = departmentSchema.parse(req.body);
    const did = id.parse(req.params.id);
    if (d.responsible_agent_id && office.agent(d.responsible_agent_id).department_id !== did) throw new Problem(400, office.t("Sorumlu ajan bu bölümde olmalı."));

    if (!store.departments().some((x) => x.id === did))
      throw new Problem(404, office.t("Bölüm bulunamadı."));
    store.db
      .prepare(
        "UPDATE departments SET name=?,description=?,color=?,sort_order=? WHERE id=?",
      )
      .run(d.name, d.description, d.color, d.sort_order, did);
    store.db.prepare("INSERT INTO department_greeters VALUES (?,?) ON CONFLICT(department_id) DO UPDATE SET agent_id=excluded.agent_id").run(did, d.responsible_agent_id || null);
    office.event(null, "department_updated", office.t("{0} bölümü güncellendi.", [d.name]));
    return { ...d, id: did };
  });
  app.put("/api/departments/order", async (req) => {
    const { ids } = z
      .object({ ids: z.array(id).max(1000) })
      .strict()
      .parse(req.body);
    const actual = store.departments().map((d) => d.id);
    if (
      ids.length !== actual.length ||
      new Set(ids).size !== ids.length ||
      ids.some((value) => !actual.includes(value))
    )
      throw new Problem(400, office.t("Bölüm listesi değişmiş. Sayfayı yenileyin."));
    store.db.exec("BEGIN");
    try {
      ids.forEach((did, index) =>
        store.db
          .prepare("UPDATE departments SET sort_order=? WHERE id=?")
          .run(index, did),
      );
      store.db.exec("COMMIT");
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
    office.event(null, "departments_sorted", office.t("Bölümlerin sırası değiştirildi."));
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>(
    "/api/departments/:id",
    async (req) => {
      const did = id.parse(req.params.id);
      if (!store.departments().some((d) => d.id === did))
        throw new Problem(404, office.t("Bölüm bulunamadı."));
      if (store.agents().some((a) => a.department_id === did))
        throw new Problem(
          409,
          office.t("Bu bölümde ajan var. Önce ajanları taşıyın ya da silin."),
        );
      if(z.object({trash:z.enum(['1']).optional()}).parse(req.query).trash) return runtime.director.trash('department',did,{});
      store.db
        .prepare(
          "DELETE FROM messages WHERE recipient_type='department' AND recipient_id=?",
        )
        .run(did);
      store.db.prepare("DELETE FROM departments WHERE id=?").run(did);
      office.event(null, "department_deleted", office.t("Bölüm silindi."));
      return { ok: true };
    },
  );
  app.post("/api/agents", async (req, reply) =>
    reply.code(201).send(await office.createAgent(agentSchema.parse(req.body))),
  );
  app.put<{ Params: { id: string } }>("/api/agents/:id", async (req) => {
    const a = agentSchema.parse(req.body);
    if(a.runner==='claude' && a.policy?.commands)throw new Problem(400,office.t("Claude için komut çalıştırma açılamaz. Codex seçin."));
    const aid = id.parse(req.params.id);
    const previousAgent = office.agent(aid);

    if(previousAgent.builtin==='director' && (!a.active || a.session_mode!=='persistent' || a.watch_tasks || a.watch_due))throw new Problem(400,office.t("Genel Müdür etkin ve kalıcı konuşmada kalmalı."));
    if (
      JSON.stringify(previousAgent.policy) !== JSON.stringify(a.policy) ||
      previousAgent.runner !== a.runner || previousAgent.session_mode !== a.session_mode
    )
      runtime.stop(aid);
    if (!store.departments().some((d) => d.id === a.department_id))
      throw new Problem(400, office.t("Bölüm bulunamadı."));
    store.db
      .prepare(
        "UPDATE agents SET name=?,title=?,department_id=?,prompt=?,runner=?,model=?,effort=?,appearance=?,desk_x=?,desk_y=?,status=?,current_job=?,active=? WHERE id=?",
      )
      .run(
        a.name,
        a.title,
        a.department_id,
        a.prompt,
        a.runner,
        a.model,
        a.effort,
        JSON.stringify(a.appearance),
        a.desk_x,
        a.desk_y,
        a.active ? a.status : "kapali",
        a.current_job,
        Number(a.active),
        aid,
      );
    store.db
      .prepare("UPDATE agents SET policy=? WHERE id=?")
      .run(JSON.stringify(a.policy || {}), aid);
    if (previousAgent.department_id !== a.department_id)
      store.db.prepare("UPDATE department_greeters SET agent_id=NULL WHERE agent_id=? AND department_id<>?").run(aid, a.department_id);
    if (!a.active) runtime.stop(aid);
    store.db.prepare("UPDATE agents SET session_mode=?,watch_tasks=?,watch_due=? WHERE id=?").run(a.session_mode,Number(a.watch_tasks),Number(a.watch_due),aid);
    store.db.prepare("UPDATE agents SET tool_groups=? WHERE id=?").run(a.tool_groups ? JSON.stringify(a.tool_groups) : null,aid);
    await office.migrateEmail(aid,a.username);
    if(previousAgent.builtin==='director'){
      if(previousAgent.runner!==a.runner)runtime.terminal?.providerChanged();
      const s=runtime.director.state();s.provider_selected=true;runtime.director.save(s);
    }
    office.event(aid, "agent_updated", office.t("{0} bilgileri güncellendi.", [a.name]));
    office.changed("agent", office.agent(aid));
    return office.agent(aid);
  });
  app.post<{ Params: { id: string } }>("/api/agents/:id/retry", async (req) =>
    office.provision(id.parse(req.params.id)),
  );
  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (req) => {
    const query = z
      .object({ account: z.enum(["delete", "keep"]), profile: z.enum(["delete", "keep"]).default("keep"), trash:z.enum(["1"]).optional() })
      .parse(req.query);
    const aid=id.parse(req.params.id);
    if(office.agent(aid).builtin==='director')throw new Problem(403,office.t("Genel Müdür silinemez."));
    runtime.stop(aid);
    if(query.trash)return runtime.director.trash('agent',aid,{account:query.account,profile:query.profile});
    return office.removeAgent(
      id.parse(req.params.id),
      query.account === "delete",
      query.profile === "delete",
    );
  });
  app.post("/api/tududi-deletions/retry", async () => {
    await office.retryDeletions();
    return { pending: office.pendingDeletions() };
  });
  app.post<{ Params: { id: string } }>("/api/agents/:id/key", async (req) => {
    const aid = id.parse(req.params.id);
    office.agent(aid);
    if (config.runnerKey)
      throw new Problem(410, office.t("Çalıştırıcı kısa ömürlü anahtarı kendisi alır."));
    const key = newKey();
    store.db
      .prepare("UPDATE agents SET agent_key_hash=? WHERE id=?")
      .run(hash(key), aid);
    office.event(aid, "key_rotated", office.t("Ajan anahtarı yenilendi."));
    return { agent_id: aid, key };
  });
  app.get<{ Params: { id: string } }>(
    "/api/agents/:id/prompt",
    async (req) => ({ prompt: store.fullPrompt(id.parse(req.params.id)) }),
  );
  app.put("/api/rules", async (req) => {
    const { text: rules } = z
      .object({ text: z.string().max(60000) })
      .strict()
      .parse(req.body);
    store.db.prepare("UPDATE company_rules SET text=? WHERE id=1").run(rules);
    office.event(null, "rules_updated", office.t("Şirket kuralları güncellendi."));
    return { ok: true };
  });
  app.post("/api/messages", async (req, reply) => {
    const m = messageSchema.parse(req.body);
    return reply
      .code(201)
      .send(office.message(null, m.recipient_type, m.recipient_id, m.text));
  });
  app.post<{ Params: { id: string } }>(
    "/api/messages/:id/read",
    async (req) => {
      const mid = id.parse(req.params.id);
      if (!store.messages().some((m) => m.id === mid))
        throw new Problem(404, office.t("Mesaj bulunamadı."));
      office.readMessage(mid, "owner");
      return { ok: true };
    },
  );
  app.post("/api/handoffs", async (req, reply) => {
    const h = handoffSchema.parse(req.body);
    if(h.secenekler)runtime.validateWorkOptions(h.to_agent_id,h.secenekler);
    const result = await office.handoff(
      null,
      h.to_agent_id,
      h.title,
      h.description,
    );
    const run = runtime.enqueue(
      h.to_agent_id,
      office.t("Kullanıcıdan görev devri"),
      `${h.title}\n${h.description}`,
    );
    if (run) {runtime.bindRun(run.id, null, result.id, 1);if(h.secenekler)runtime.setWorkOptions(run.id,h.secenekler);}
    else runtime.failHandoff(result.id, office.t("Çalışma başlatılamadı."));
    return reply.code(201).send(result);
  });
  app.post<{ Params: { id: string } }>("/api/handoffs/:id/retry", async (req) =>
    runtime.retryHandoff(id.parse(req.params.id)),
  );
  app.get<{ Params: { id: string } }>("/api/agents/:id/tududi", async (req) => {
    const aid=id.parse(req.params.id), data=await office.tududi.read(office.token(aid));
    return {...data,notes:data.notes.map(n=>runtime.notebook.mark(aid,n))};
  });
  app.post<{ Params: { id: string } }>(
    "/api/agents/:id/tasks",
    async (req, reply) => {
      const aid = id.parse(req.params.id);
      const body = taskSchema.parse(req.body);
      const task = await office.tududi.task(office.token(aid), { ...body, project_uid: body.project_uid || await office.ensureWorkbook(aid) });
      const run = runtime.enqueue(
        aid,
        office.t("Kullanıcının verdiği görev"),
        `${body.name}\n${body.description || ""}`,
      );
      if (run) { const wid = `${aid}:tududi:${task.uid}`; store.db.prepare("INSERT OR IGNORE INTO work_items(id,agent_id,task_uid,updated_at) VALUES (?,?,?,?)").run(wid,aid,task.uid,new Date().toISOString()); store.db.prepare("UPDATE runs SET work_item_id=? WHERE id=?").run(wid,run.id); }
      office.event(aid, "task_created", office.t("{0} görevi eklendi.", [body.name]));
      return reply.code(201).send(task);
    },
  );
  app.patch<{ Params: { id: string; uid: string } }>(
    "/api/agents/:id/tasks/:uid",
    async (req) => {
      const aid = id.parse(req.params.id);
      const body=z.object({status:z.number().int().min(0).max(4).optional(),name:text(200).optional(),description:z.string().max(20000).optional(),project_uid:text(120).optional()}).strict().refine(v=>Object.keys(v).length>0).parse(req.body);
      const data=await runtime.notebook.data(aid);if(!data.tasks.some(t=>t.uid===req.params.uid))throw new Problem(404,office.t("Görev bulunamadı."));
      if(body.project_uid && !data.projects.some(p=>p.uid===body.project_uid))throw new Problem(400,office.t("Proje bu hesabın içinde olmalı."));
      const task=await office.tududi.updateTaskFields(office.token(aid),req.params.uid,body);
      if(body.status!==undefined){if([2,3].includes(body.status))runtime.notebook.closeTask(aid,req.params.uid);store.db.prepare('UPDATE handoffs SET status=? WHERE to_agent_id=? AND tududi_task_uid=?').run(body.status===2?'completed':'created',aid,req.params.uid);}
      office.event(aid, "task_updated", office.t("Görevin durumu değiştirildi."));
      return task;
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/agents/:id/notes",
    async (req, reply) => {
      const aid = id.parse(req.params.id);
      const body = noteSchema.parse(req.body);
      const note = await office.tududi.note(office.token(aid), body);
      office.event(aid, "note_created", `${body.title} notu eklendi.`);
      return reply.code(201).send(note);
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/agents/:id/projects",
    async (req, reply) => {
      const aid = id.parse(req.params.id);
      const { name } = z
        .object({ name: text(200) })
        .strict()
        .parse(req.body);
      const p = await office.tududi.project(office.token(aid), name);
      office.event(aid, "project_created", `${name} projesi eklendi.`);
      return reply.code(201).send(p);
    },
  );
  app.put<{Params:{id:string;uid:string}}>('/api/agents/:id/notes/:uid',async req=>{
    const aid=id.parse(req.params.id),body=noteSchema.parse(req.body),data=await runtime.notebook.data(aid);
    if(!data.notes.some(n=>n.uid===req.params.uid))throw new Problem(404,office.t("Not bulunamadı."));
    const result=await office.tududi.updateNote(office.token(aid),req.params.uid,body);runtime.notebook.record(aid,'note',result);await runtime.notebook.refresh(aid);return result;
  });
  app.put<{Params:{id:string;uid:string}}>('/api/agents/:id/projects/:uid',async req=>{
    const aid=id.parse(req.params.id),body=z.object({name:text(200),description:z.string().max(20000).optional()}).strict().parse(req.body),data=await runtime.notebook.data(aid);
    if(!data.projects.some(p=>p.uid===req.params.uid))throw new Problem(404,office.t("Proje bulunamadı."));
    const result=await office.tududi.updateProject(office.token(aid),req.params.uid,body);office.event(aid,'project_updated',office.t("Proje güncellendi."));return result;
  });
  app.get("/api/internal/me", async (req) => ({
    agent: req.internalAgent,
    prompt: store.fullPrompt(req.internalAgent!.id),
  }));
  app.patch("/api/internal/status", async (req) => {
    const s = z
      .object({
        status: z.enum(statuses),
        current_job: z.string().max(2000).default(""),
      })
      .strict()
      .parse(req.body);
    store.db
      .prepare("UPDATE agents SET status=?,current_job=? WHERE id=?")
      .run(s.status, s.current_job, req.internalAgent!.id);
    office.changed("agent", office.agent(req.internalAgent!.id));
    office.event(
      req.internalAgent!.id,
      "status",
      `${req.internalAgent!.name}: ${s.current_job || statusLabels[s.status]}`,
    );
    return { ok: true };
  });
  app.post("/api/internal/messages", async (req, reply) => {
    const m = messageSchema.parse(req.body);
    return reply
      .code(201)
      .send(
        office.message(
          req.internalAgent!.id,
          m.recipient_type,
          m.recipient_id,
          m.text,
        ),
      );
  });
  app.get("/api/internal/inbox", async (req) =>
    office.inbox(req.internalAgent!.id),
  );
  app.post<{ Params: { id: string } }>(
    "/api/internal/inbox/:id/read",
    async (req) => {
      const mid = id.parse(req.params.id);
      if (!office.inbox(req.internalAgent!.id).some((m) => m.id === mid))
        throw new Problem(404, office.t("Mesaj gelen kutunuzda bulunamadı."));
      office.readMessage(mid, req.internalAgent!.id);
      return { ok: true };
    },
  );
  app.post("/api/internal/handoffs", async (req, reply) => {
    const h = handoffSchema.parse(req.body);
    if(h.secenekler)runtime.validateWorkOptions(h.to_agent_id,h.secenekler);
    return reply
      .code(201)
      .send(
        await office.handoff(
          req.internalAgent!.id,
          h.to_agent_id,
          h.title,
          h.description,
        ),
      );
  });
  app.post("/api/internal/events", async (req, reply) => {
    const { text: eventText } = z
      .object({ text: text(2000) })
      .strict()
      .parse(req.body);
    office.event(req.internalAgent!.id, "agent_event", eventText);
    return reply.code(201).send({ ok: true });
  });
  const staticDir = options.staticDir || resolve("dist/client");
  if (existsSync(staticDir)) {
    await app.register(staticPlugin, { root: staticDir });
    app.setNotFoundHandler((req, reply) =>
      canonicalRequestPath(req.url)?.startsWith("/api/")
        ? reply.code(404).send({ error: office.t("Adres bulunamadı.") })
        : req.method === "GET"
          ? reply.sendFile("index.html")
          : reply.code(404).send({ error: office.t("Adres bulunamadı.") }),
    );
  }
  app.addHook("onClose", async () => {
    clearInterval(reaper);
    await runtime.director.close();
    await runtime.scheduler.close();
    await runtime.notebook.close();
    await office.close();
    for (const s of streams) s.close();
    store.close();
  });
  await app.ready();
  return { app, store, office, runtime };
}
