import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION } from "../shared/runtime.js";
import type { FolderLink } from "../shared/runtime.js";
import { a3Routes } from "./a3-api.js";
import { officeDay, dayStart, previousDay } from '../shared/time.js';
import { Runtime } from "./runtime.js";
import { Problem } from "./service.js";
import { TududiError } from "./tududi.js";
import {
  settingsSchema,
  toolSchemas,
  type ToolName,
  workOptionsSchema,
} from "./runtime-schemas.js";
const uuid = z.string().uuid();
const sid = z.string().min(1).max(120);
export function runtimeRoutes(app: FastifyInstance, rt: Runtime) {
  a3Routes(app, rt);
  app.get("/api/runtime", async () => rt.snapshot());
  app.put("/api/runtime/settings", async (req) => {
    const oldZone=rt.settings().timeZone;
    const oldLanguage=rt.office.language;
    const oldRules=rt.settings().approvalRules;
    const settings = settingsSchema.parse(req.body);
    if (settings.greeterAgentId) rt.office.agent(settings.greeterAgentId);
    settings.language ||= oldLanguage;
    rt.office.setLanguage(settings.language);
    if (JSON.stringify(settings.approvalRules)===JSON.stringify(oldRules)) settings.approvalRules=rt.settings().approvalRules;
    rt.db
      .prepare("UPDATE runtime_settings SET json=? WHERE id=1")
      .run(JSON.stringify(settings));
    if(oldZone!==settings.timeZone)rt.scheduler.rezone();
    rt.office.changed();
    rt.director.kick();
    for (const a of rt.office.store.agents()) { await rt.office.migrateEmail(a.id); try { await rt.office.localizeProfile(a.id); } catch { rt.office.event(a.id,"tududi_profile_pending",rt.office.t("Türkçe hesap ayarı bağlantı hazır olduğunda uygulanacak.")); } }
    return settings;
  });
  app.post("/api/runtime/stop", async () => {
    rt.stop();
    return { ok: true };
  });
  app.post("/api/conversations/stop", async (req) => {
    const target = z.object({
      recipient_type: z.enum(["agent", "department", "everyone"]),
      recipient_id: uuid.nullable(),
    }).strict().parse(req.body);
    if (target.recipient_type === "everyone" ? target.recipient_id !== null : !target.recipient_id)
      throw new Problem(400, rt.office.t("Sohbetin alıcısı geçersiz."));
    for (const row of rt.db.prepare("SELECT id FROM runs WHERE state IN ('queued','running') AND conversation_type=? AND conversation_id IS ?")
      .all(target.recipient_type, target.recipient_id))
      rt.finish(row.id as string, "stopped", "", rt.office.t("Kullanıcı çalışmayı durdurdu."));
    return { ok: true };
  });
  app.post("/api/runtime/resume", async () => {
    rt.db.prepare("UPDATE runtime_settings SET paused=0 WHERE id=1").run();
    rt.office.changed();
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/agents/:id/run", async (req) => {
    const a = uuid.parse(req.params.id);
    const { text, limits, smokeTimeoutSeconds, secenekler } = z
      .object({
        smokeTimeoutSeconds: z.unknown().optional(),
        secenekler: workOptionsSchema.optional(),
        limits: z.object({ maxDepth: z.number().int().min(1).max(20), maxRuns: z.number().int().min(1).max(100) }).strict().optional(),
        text: z
          .string()
          .trim()
          .min(1)
          .max(20000)
          .default(rt.office.t("Şu anki açık işlerini incele ve durumunu bildir.")),
      })
      .strict()
      .parse(req.body || {});
    const smoke = rt.snapshot().smoke && req.headers["x-ofis-duman"] === "1" && /^DUMAN .*"scenario":"sure"/m.test(text);
    if(secenekler)rt.validateWorkOptions(a,secenekler);
    const run = rt.enqueue(a, rt.office.t("Elle başlatma"), text, undefined, undefined, true, limits,
      smoke && smokeTimeoutSeconds !== undefined ? z.number().min(0.01).max(60).parse(smokeTimeoutSeconds) : undefined);
    if (run) {rt.bindRun(run.id, null, null, 1);if(secenekler)rt.setWorkOptions(run.id,secenekler);}
    return run;
  });
  app.post<{ Params: { id: string } }>("/api/agents/:id/stop", async (req) => {
    rt.stop(uuid.parse(req.params.id));
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>(
    "/api/agents/:id/memory",
    async (req) => ({ text: rt.memory(uuid.parse(req.params.id)) }),
  );
  app.put<{ Params: { id: string } }>("/api/agents/:id/memory", async (req) => {
    const { text } = z
      .object({ text: z.string().max(8000) })
      .strict()
      .parse(req.body);
    rt.writeMemory(uuid.parse(req.params.id), text);
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req) => {
    const r = rt.run(uuid.parse(req.params.id));
    return {
      run: { ...r, output: rt.publicText(r.output) },
      chain: rt.chains().find((c) => c.id === r.chain_id),
      logs: rt.db
        .prepare("SELECT * FROM run_logs WHERE run_id=? ORDER BY id")
        .all(r.id),
    };
  });
  app.post<{ Params: { id: string } }>("/api/runs/:id/save-continue", async req => {
    const prior=rt.run(uuid.parse(req.params.id));
    if(prior.state!=='failed' || !rt.db.prepare("SELECT 1 FROM run_logs WHERE run_id=? AND kind='workspace_dirty'").get(prior.id))throw new Problem(409,rt.office.t("Bu çalışma için kaydedilecek değişiklik yok."));
    const existing=rt.db.prepare("SELECT id FROM runs WHERE parent_run_id=? AND state IN ('queued','running') AND id IN (SELECT run_id FROM run_logs WHERE kind='workspace_save_authorized')").get(prior.id);
    if(existing)return {ok:true,id:existing.id};
    const next=rt.enqueue(prior.agent_id,rt.office.t("Sahibin isteğiyle değişiklikleri kaydet ve devam et"),prior.summary,prior,{conversation_type:prior.conversation_type,conversation_id:prior.conversation_id},false);
    if(!next)throw new Problem(409,rt.office.t("Çalışma sıraya alınamadı. Kullanım sınırlarını kontrol edin."));
    rt.bindRun(next.id,prior.message_id,prior.handoff_id,prior.priority);
    rt.log(next.id,'workspace_save_authorized',rt.office.t("Sahip önceki değişikliklerin ajan adına kaydedilmesini istedi."));
    return {ok:true,id:next.id};
  });
  app.get<{ Params: { id: string; index: string } }>("/api/approvals/:id/files/:index", async (req, reply) => {
    const a = rt.approvals().find((a) => a.id === uuid.parse(req.params.id));
    const index = z.coerce.number().int().min(0).max(19).parse(req.params.index);
    const f = a?.files[index];
    if (!f) throw new Problem(404, rt.office.t("Onay eki bulunamadı."));
    const extension = f.path.split(".").at(-1)?.toLowerCase();
    const mime = extension === "png" ? "image/png" : ["jpg", "jpeg"].includes(extension || "")
      ? "image/jpeg" : extension === "webp" ? "image/webp" : "text/plain; charset=utf-8";
    // HTML/SVG and other active content always remain plain text.
    return reply.type(mime).header("X-Content-Type-Options", "nosniff").send(Buffer.from(f.content, "base64"));
  });
  app.get("/api/usage", async (req) => {
    const { days } = z
      .object({
        days: z.coerce
          .number()
          .refine((n) => n === 1 || n === 7)
          .default(1),
      })
      .parse(req.query);
    return rt.office.store.agents().map(a => {
      const totals = rt.totals(a.id,days);
      const since=dayStart(previousDay(officeDay(rt.clock(),rt.settings().timeZone),days-1),rt.settings().timeZone);
      const notes = rt.db.prepare("SELECT text FROM run_logs JOIN runs ON runs.id=run_logs.run_id WHERE runs.agent_id=? AND kind='tool_success' AND run_logs.created_at>=?").all(a.id,since.toISOString());
      return { id:a.id,name:a.name,terminal_usage:a.builtin==='director' && rt.terminal?.enabled ? rt.terminal.snapshot().usageKnown ? 'measured' : 'unknown' : undefined,...totals,average_tokens:totals.runs ? Math.round(totals.input_tokens/totals.runs) : 0,average_cached_tokens:totals.runs ? Math.round(totals.cached_input_tokens/totals.runs) : 0,average_uncached_tokens:totals.runs ? Math.round(totals.uncached_input_tokens/totals.runs) : 0,notes_read:notes.filter(n => /^(tududi_not_oku|ortak_not_oku):/.test(n.text as string)).length,notes_written:notes.filter(n => /^(tududi_not_yaz|is_notu_yaz|ortak_not_yaz):/.test(n.text as string)).length };
    });
  });
  app.post("/api/links", async (req) => {
    const b = z
      .object({
        name: z.string().trim().min(1).max(100),
        path: z.string().min(1).max(1000),
        access: z.enum(["read", "write"]),
        approved_write: z.boolean().default(true),
        agent_ids: z.array(uuid).max(100),
      })
      .strict()
      .parse(req.body);
    for (const aid of b.agent_ids) rt.office.agent(aid);
    const l: FolderLink = {
      ...b,
      id: randomUUID(),
      validation: "pending",
      detail: rt.office.t("Çalıştırıcı yolu kontrol edecek."),
    };
    rt.db
      .prepare("INSERT INTO folder_links VALUES (?,?)")
      .run(l.id, JSON.stringify(l));
    rt.office.changed();
    return l;
  });
  app.put<{ Params: { id: string } }>("/api/links/:id", async (req) => {
    const id = uuid.parse(req.params.id),
      previous = rt.links().find((l) => l.id === id);
    if (!previous) throw new Problem(404, rt.office.t("Bağlantı bulunamadı."));
    const b = z
      .object({
        name: z.string().trim().min(1).max(100),
        path: z.string().min(1).max(1000),
        access: z.enum(["read", "write"]),
        approved_write: z.boolean(),
        agent_ids: z.array(uuid).max(100),
      })
      .strict()
      .parse(req.body);
    for (const aid of b.agent_ids) rt.office.agent(aid);
    for (const aid of previous.agent_ids) rt.stop(aid);
    const l: FolderLink = {
      ...b,
      id,
      validation: "pending",
      detail: rt.office.t("Çalıştırıcı yolu tekrar kontrol edecek."),
    };
    rt.db
      .prepare("UPDATE folder_links SET json=? WHERE id=?")
      .run(JSON.stringify(l), id);
    rt.office.changed();
    return l;
  });
  app.delete<{ Params: { id: string } }>("/api/links/:id", async (req) => {
    const id = uuid.parse(req.params.id);
    for (const aid of rt.links().find((l) => l.id === id)?.agent_ids || [])
      rt.stop(aid);
    rt.db.prepare("DELETE FROM folder_links WHERE id=?").run(id);
    rt.office.changed();
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>(
    "/api/approvals/:id/decision",
    async (req) => {
      const b = z
        .object({
          approved: z.boolean(),
          note: z.string().max(2000).default(""),
        })
        .strict()
        .parse(req.body);
      const id=uuid.parse(req.params.id);
      return await rt.office.locked(`decision:${id}`,async()=> await rt.director.decideAction(id,b.approved,b.note,'owner',req.ownerSession) || rt.decide(id,b.approved,b.note));
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/artifacts/:id/download",
    async (req, reply) => {
      const id = uuid.parse(req.params.id),
        a = rt.artifacts().find((a) => a.id === id);
      if (!a) throw new Problem(404, rt.office.t("Çıktı bulunamadı."));
      const bytes = rt.db
        .prepare("SELECT content FROM artifacts WHERE id=?")
        .get(id)!.content as Uint8Array;
      reply
        .header(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(a.name.split("/").at(-1)!)}`,
        )
        .type(a.mime);
      return Buffer.from(bytes);
    },
  );
  app.post("/api/runner/heartbeat", async (req) => {
    const b = z
      .object({
        id: sid,
        protocol: z.number().int().optional(),
        workspaceRoot: z.string().max(1000).default(""),
        claudeLoginCommand: z.string().max(4000).default(""),
        models: z
          .object({ claude: z.array(sid).max(50), codex: z.array(sid).max(50) })
          .optional(),
        machine: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        availability: z.object({ claude: z.boolean(), codex: z.boolean() }).strict().optional(),
        capacity: z.number().int().min(1).max(16).default(2),
        smoke: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    return rt.heartbeat(b.id, b.models, b.capacity, b.machine, b.availability, b.smoke, b.protocol ?? 0, b.workspaceRoot, b.claudeLoginCommand);
  });
  app.post("/api/runner/incoming/ready", async (req) => {
    const b = z.object({ runner: sid, run: uuid, transfer: uuid }).strict().parse(req.body);
    rt.owns(b.run, b.runner); const r = rt.run(b.run);
    if (r.state !== "running") throw new Problem(409, rt.office.t("Çalışma durduruldu."));
    rt.db.prepare("UPDATE transfers SET installed=1 WHERE id=? AND to_agent_id=?").run(b.transfer, r.agent_id);
    return { ok: true };
  });
  app.post("/api/runner/incoming", async (req) => {
    const b = z.object({ runner: sid, run: uuid, transfer: uuid, index: z.number().int().min(0).max(19) }).strict().parse(req.body);
    rt.owns(b.run, b.runner);
    const r = rt.run(b.run);
    if (r.state !== "running") throw new Problem(409, rt.office.t("Çalışma durduruldu."));
    const row = rt.db.prepare("SELECT * FROM transfers WHERE id=? AND to_agent_id=?").get(b.transfer, r.agent_id);
    const f = row && JSON.parse(row.files as string)[b.index];
    if (!f) throw new Problem(404, rt.office.t("Gelen dosya bulunamadı."));
    return { content: f.content };
  });
  app.post<{ Params: { id: string } }>("/api/messages/:id/retry", async (req) => {
    const m = rt.office.store.messages().find((m) => m.id === uuid.parse(req.params.id) && m.sender_type === "user");
    if (!m) throw new Problem(404, rt.office.t("Kullanıcı mesajı bulunamadı."));
    const b = z.object({ agent_id: uuid.optional() }).strict().parse(req.body || {});
    const prior = rt.messageRuns().filter((r) => r.message_id === m.id);
    const failed = prior.filter((r) => ["failed", "stopped", "interrupted", "budget_exceeded"].includes(r.state) && (!b.agent_id || b.agent_id === r.agent_id));
    if (prior.length && !failed.length) return { ok: true };
    rt.db.prepare("UPDATE messages SET response_note='' WHERE id=?").run(m.id);
    rt.triggerMessage(m, failed.length ? failed.map((r) => r.agent_id) : undefined); return { ok: true };
  });
  app.post("/api/runner/disconnect", async (req) => {
    const { id } = z.object({ id: sid }).strict().parse(req.body);
    return rt.disconnect(id);
  });
  app.post("/api/runner/claim", async (req) => {
    const b = z.object({ id: sid, activeAgents: z.array(uuid).max(16).default([]) }).strict().parse(req.body);
    rt.scheduler.tick();
    if(rt.runs().some(r=>r.state==='queued')) await rt.notebook.poll(true);
    const pendingGM=rt.runs().some(r=>r.agent_id===rt.director.agent().id && r.state==='queued');
    if(pendingGM && rt.director.agent().tududi_state!=='ready')await rt.office.provision(rt.director.agent().id);
    const lease = rt.claim(b.id,b.activeAgents);
    if (lease) {
      try { const item = await rt.notebook.prepareWork(lease.run); lease.task_uid = item.task_uid as string; lease.prompt += rt.office.t("\nTududi iş kimliği: {0}", [item.task_uid]); if(item.note && !lease.prompt.includes(String(item.note)))lease.prompt += rt.office.t("\nİş notu (veri): {0}", [item.note]); }
      catch { rt.log(lease.run.id,"diagnostic",rt.office.t("Tududi iş kaydı bağlantı hazır olduğunda tamamlanacak.")); }
      rt.db.prepare("UPDATE run_logs SET text=? WHERE run_id=? AND kind='input'").run(rt.publicText(lease.prompt),lease.run.id);
    }
    return lease;
  });
  app.post("/api/runner/ready", async (req) => {
    const b = z.object({ runner: sid, id: uuid }).strict().parse(req.body);
    rt.owns(b.id, b.runner);
    const r = rt.run(b.id);
    const row = rt.db.prepare("SELECT lease_expires FROM runs WHERE id=?").get(b.id);
    if (r.state !== "running" || !rt.office.agent(r.agent_id).active || Number(row?.lease_expires) <= rt.clock())
      throw new Problem(409, rt.office.t("Çalışma durduruldu veya süresi doldu; modeli başlatmayın."));
    rt.log(r.id, "diagnostic", rt.office.t("Çalışma kimliği başlatmadan önce yeniden doğrulandı."));
    return { ok: true };
  });
  app.post("/api/runner/update", async (req) => {
    const b = z
      .object({
        runner: sid,
        id: uuid,
        kind: z.enum(["text", "tool", "turn", "error", "diagnostic", "usage", "git_change", "workspace_dirty"]),
        text: z.string().max(20000),
        usage: z.record(z.string(), z.number().nonnegative()).optional(),
      })
      .strict()
      .parse(req.body);
    rt.owns(b.id, b.runner);
    rt.update(b.id, b.kind, b.text, b.usage);
    return { ok: true, stop: rt.run(b.id).state !== "running", reason: rt.run(b.id).reason };
  });
  app.post("/api/runner/secrets", async (req) => {
    const b = z
      .object({
        runner: sid,
        id: uuid,
        secrets: z.array(z.string().min(8).max(10000)).max(100),
      })
      .strict()
      .parse(req.body);
    rt.owns(b.id, b.runner);
    rt.registerSecrets(b.secrets);
    return { ok: true };
  });
  app.post("/api/runner/finish", async (req) => {
    const b = z
      .object({
        runner: sid,
        id: uuid,
        state: z.enum(["completed", "failed", "stopped", "interrupted", "budget_exceeded"]),
        retryable: z.boolean().default(false),
        startupFailure: z.boolean().default(false),
        transientStartup: z.boolean().default(false),
        output: z.string().max(60000).default(""),
        reason: z.string().max(2000).default(""),
        usage: z.record(z.string(), z.number().nonnegative()).optional(),
      })
      .strict()
      .parse(req.body);
    rt.owns(b.id, b.runner);
    const before = rt.run(b.id);
    const result = rt.finish(b.id, b.state, b.output, b.reason, b.usage);
    const quotaPaused = rt.a3.pauses().some(p => p.provider === rt.office.agent(before.agent_id).runner);
    if (result.state!=='budget_exceeded' && quotaPaused && !before.scheduled_task_id && before.state === "running" && b.state === "failed") rt.db.prepare("UPDATE runs SET state='queued',started_at=NULL,finished_at=NULL,reason=? WHERE id=?").run(rt.office.t("Sağlayıcı kotasının açılması bekleniyor."), before.id);
    if (result.state!=='budget_exceeded' && !quotaPaused && !before.director_followup && before.state === "running" && b.state === "failed" && b.transientStartup && (before.startup_retry || 0) < 2 && !rt.paused()) {
      let child: ReturnType<typeof rt.enqueue> = null;
      try {
        child = rt.enqueue(before.agent_id, rt.office.t("Geçici başlatma hatasının yeniden denemesi") + (before.trigger.includes("Karşılayana") ? rt.office.t(" · Karşılayana kullanıcı mesajı") : ""), before.summary, before, { conversation_type: before.conversation_type, conversation_id: before.conversation_id }, false);
      } catch (error) {
        const reason = error instanceof Error ? error.message : rt.office.t("Çalışma yeniden başlatılamadı.");
        rt.log(before.id, "diagnostic", reason);
        if (before.handoff_id) rt.failHandoff(before.handoff_id, reason);
      }
      if (child) {
        rt.bindRun(child.id, before.message_id, before.handoff_id, before.priority);
        rt.db.prepare("UPDATE runs SET startup_retry=?,not_before=?,budget_retry=? WHERE id=?").run((before.startup_retry || 0) + 1, rt.clock() + 500 * 2 ** (before.startup_retry || 0),Number(rt.db.prepare('SELECT budget_retry FROM runs WHERE id=?').get(before.id)?.budget_retry || 0),child.id);
      } else if (before.handoff_id) rt.failHandoff(before.handoff_id, b.reason);
    } else if (b.startupFailure && before.handoff_id) rt.failHandoff(before.handoff_id, b.reason);
    if (!quotaPaused && before.state === "running" && b.state === "failed" && b.retryable && !b.transientStartup && rt.office.agent(before.agent_id).runner === "codex")
      rt.retryRun(before, rt.office.t("Komut satırı çöktüğü için yeniden deneme"));
    return result;
  });
  app.post("/api/runner/links/validate", async (req) => {
    const b = z
      .object({ id: uuid, valid: z.boolean(), detail: z.string().max(2000),documents:z.array(z.string().min(1).max(500)).max(1000).optional(),documents_truncated:z.boolean().optional() })
      .strict()
      .parse(req.body);
    const l = rt.links().find((l) => l.id === b.id);
    if (!l) throw new Problem(404, rt.office.t("Bağlantı bulunamadı."));
    l.validation = b.valid ? "valid" : "invalid";
    l.detail = rt.scrub(b.detail);
    l.documents=b.valid ? (b.documents || []) : [];l.documents_truncated=!!b.documents_truncated;
    rt.db
      .prepare("UPDATE folder_links SET json=? WHERE id=?")
      .run(JSON.stringify(l), l.id);
    rt.office.changed();
    return { ok: true };
  });
  app.post("/api/runner/approvals/take", async (req) => {
    const { id } = z.object({ id: uuid }).strict().parse(req.body);
    const a = rt.approvals().find((a) => a.id === id);
    if (!a || a.state !== "approved" || !a.link_id || a.type === "kopyalandi")
      return null;
    if (rt.paused()) return null;
    a.state = "applying";
    rt.saveApproval(a);
    return { approval: a, link: rt.links().find((l) => l.id === a.link_id) };
  });
  app.post("/api/runner/approvals/result", async (req) => {
    const b = z
      .object({ id: uuid, ok: z.boolean(), detail: z.string().max(2000) })
      .strict()
      .parse(req.body);
    rt.applyResult(b.id, b.ok, b.detail);
    return { ok: true };
  });
  app.get('/api/agent-tools/catalog',async req=>{const r=rt.authenticate(req.headers.authorization?.replace(/^Bearer /,'') || '',true);return {names:rt.director.allowedTools(r.agent_id,r)};});
  app.post('/api/runner/acceptance/result',async req=>{
    const b=z.object({runner:sid,id:uuid,command:uuid,exit_code:z.number().int().nullable(),output:z.string().max(20000)}).strict().parse(req.body);rt.owns(b.id,b.runner);const r=rt.run(b.id);
    if(r.state!=='running' || !rt.workOptions(r.id).acceptance.includes(b.command))throw new Problem(403,rt.office.t("Kabul ölçütü bu çalışmaya atanmadı."));
    if(rt.db.prepare("SELECT 1 FROM run_logs WHERE run_id=? AND kind='acceptance_result' AND json_extract(text,'$.command')=?").get(r.id,b.command))throw new Problem(409,rt.office.t("Kabul ölçütü sonucu zaten kaydedildi."));
    const command=rt.a3.commands().find(c=>c.id===b.command);rt.log(r.id,'acceptance_result',JSON.stringify({command:b.command,ad:command?.name,cikis:b.exit_code,cikti:rt.publicText(b.output)}));rt.office.changed();return {ok:true};
  });
  app.post("/api/agent-tools/:name", { bodyLimit: 56000000 }, async (req) => {
    const key = req.headers.authorization?.replace(/^Bearer /, "") || "",
      r = rt.authenticate(key);
    const { name } = z
      .object({
        name: z.enum(Object.keys(toolSchemas) as [ToolName, ...ToolName[]]),
      })
      .parse(req.params);
    const b = z
      .object({ arguments: z.unknown(), files: z.unknown().optional() })
      .strict()
      .parse(req.body);
    const result=rt.scrubValue(await rt.office.locked(`tools:${r.id}`,async()=>rt.tool(rt.authenticate(key),name,b.arguments,b.files).catch(error=>{const reason=error instanceof Problem || error instanceof TududiError ? error.message : error instanceof z.ZodError ? rt.office.t("Alanlar eksik veya geçersiz. Araç kılavuzundaki alanları kontrol edin.") : rt.office.t("Bağlantı veya kayıt okunamadı. Hesap ve kaynak bağlantılarını kontrol edin.");const text=rt.publicText(`${name.replaceAll('_',' ')}: ${reason}`).slice(0,1000);if(!rt.db.prepare("SELECT 1 FROM run_logs WHERE run_id=? AND kind='error' AND text=?").get(r.id,text)){rt.log(r.id,'error',text);rt.office.event(r.agent_id,name.startsWith('yonetim_')?'director_action_failed':'tool_failed',text,{run_id:r.id});}throw error;})));
    const notice=rt.run(r.id).state==='running' && !rt.db.prepare("SELECT 1 FROM run_logs WHERE run_id=? AND kind='budget_wrap_delivered'").get(r.id) ? rt.wrapUpNotice(r.id) : '';
    if(notice)rt.log(r.id,'budget_wrap_delivered',notice);
    return {result,...(notice?{notice}:{})};

  });
}
