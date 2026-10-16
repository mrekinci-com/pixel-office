import { StringDecoder } from "node:string_decoder";
import { claudeLoginCommand } from "./auth.js";
import { t as tx, withLanguage, setRunnerLanguage } from "./i18n.js";
import { RunnerTerminal } from "./terminal.js";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { rmSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { PROTOCOL_VERSION } from "../../office/shared/runtime.js";
import type { Lease, FolderLink, Approval } from "../../office/shared/runtime.js";
import type { RunnerConfig } from "./config.js";
import { prepare, isolate, verifyShell, type Command } from "./command.js";
import { assertLaunchSize } from "./launch-size.js";
import { retainAuth, hasAuth } from "./auth.js";
import { profileSecrets } from "./secrets.js";
import { verifyClaude } from "./claude-policy.js";
import { codexContextInput } from "./context.js";
import { parseEvent, UsageObserver } from "./events.js";
import { applyApproval, receiveFile, documentPaths } from "./files.js";
import { quota } from "./quota.js";
import { runCommand } from "./command-box.js";
import { directoryMaps, gitCopies, DirtyWorkspaceError } from "./workspace.js";
import { DiagnosticTail, redact, diagnose, transientStartup } from "./diagnostics.js";
export class Worker {
  id = randomUUID();
  active = new Map<string, { stop: (reason: string) => void }>();
  closing = false;
  private terminal?:RunnerTerminal;
  private commandActive = new Map<string,{run:string;controller:AbortController}>();
  private agentActive = new Map<string, string>();
  private ticking = false;
  constructor(
    public config: RunnerConfig,
    private fetcher: typeof fetch = fetch,
    private testLaunch?: (
      command: Command,
      lease: Lease,
      profile: string,
    ) => Command,
    private workspace?: typeof gitCopies,
    private acceptanceRunner: typeof runCommand = runCommand,
  ) {}
  async api(path: string, body: unknown) {
    const response = await this.fetcher(
      this.config.url + "/api/runner" + path,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.key}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      },
    );
    if (!response.ok) {
      if (response.status === 426) throw new Error(tx("Çalıştırıcı sürümü uyumsuz — güncelleyin"));
      throw new Error(tx("Ofis iç bağlantısı tamamlanamadı."));
    }
    return response.json() as Promise<any>;
  }
  machine() {
    let machine = "local";
    try { machine = readFileSync("/etc/machine-id", "utf8"); } catch {}
    return createHash("sha256").update(machine + this.config.workDir).digest("hex");
  }
  async tick() {
    if (this.closing || this.ticking) return;
    this.ticking = true;
    try { await withLanguage(this.config.language || "tr", () => this.tickOnce()); } finally { this.ticking = false; }
  }
  private async tickOnce() {
    if (this.closing) return;
    const heartbeat = await this.api("/heartbeat", {
      id: this.id,
      protocol: PROTOCOL_VERSION,
      workspaceRoot: this.config.workDir,
      claudeLoginCommand: claudeLoginCommand(this.config.workDir),
      machine: this.machine(),
      availability: {
        claude: this.testLaunch ? true : hasAuth(this.config.workDir, "claude", this.config.claudeAuth),
        codex: this.testLaunch ? true : hasAuth(this.config.workDir, "codex", this.config.codexAuth),
      },
      models: {
        claude: this.config.claudeModels || ["sonnet", "opus", "haiku"],
        codex: this.config.codexModels || [this.config.codexModel],
      },
      capacity: this.config.concurrency,
      smoke: this.config.smoke === true,
    });
    if (this.closing) return;
    this.config.language = heartbeat.language === "en" ? "en" : "tr";
    setRunnerLanguage(this.config.language);
    // Construct before the reset branch so a restarted worker also checks old tmux supervisors.
    if(!this.testLaunch)this.terminal ||= new RunnerTerminal(this.config,this.id);
    if (heartbeat.reset) {
      const targets=new Set<string>(heartbeat.reset.runs);
      for(const [id,a] of this.active)if(targets.has(id))a.stop(tx('Sahibin sıfırlama işlemi.'));
      for(const j of this.commandActive.values())if(targets.has(j.run))j.controller.abort();
      const terminalIdle=this.terminal?.resetIdle(heartbeat.reset.agents) ?? true;
      if(heartbeat.reset.nonce && terminalIdle && ![...this.active.keys()].some(id=>targets.has(id)) && ![...this.commandActive.values()].some(j=>targets.has(j.run)))await this.api('/reset-idle',{runner:this.id,reset:heartbeat.reset.id,nonce:heartbeat.reset.nonce});
      return;
    }
    this.terminal?.resumeAfterReset();
    if(!this.testLaunch)this.terminal!.heartbeat();
    for (const deletion of heartbeat.profileDeletions || []) {
      if (!this.agentActive.has(deletion) && /^[a-f0-9-]{36}$/.test(deletion)) {
        if(this.terminal?.agentId===deletion)continue;
        rmSync(join(this.config.workDir, ".oturum", deletion), { recursive: true, force: true });
        rmSync(join(this.config.workDir, ".terminal", deletion), { recursive: true, force: true });
        const control=join(this.config.workDir,'.terminal-control');
        if(existsSync(control))for(const entry of readdirSync(control))if(entry.startsWith(`gm-${deletion}-`))rmSync(join(control,entry),{force:true});
        await this.api("/profiles/deleted", { agent: deletion });
      }
    }
    // Remove the old conversation on reset without waiting for another model turn.
    // Wait until a closing process releases its profile before touching it.
    for(const session of heartbeat.sessionProfiles || []) {
      if(this.agentActive.has(session.agent_id) || !/^[a-f0-9-]{36}$/.test(session.agent_id) || !Number.isSafeInteger(session.generation) || session.generation<0)continue;
      const parent=join(this.config.workDir,'.oturum',session.agent_id);
      if(existsSync(parent))for(const entry of readdirSync(parent))if(/^\d+$/.test(entry) && !(heartbeat.sessionProfiles || []).some((s: {agent_id:string;generation:number})=>s.agent_id===session.agent_id && String(s.generation)===entry))rmSync(join(parent,entry),{recursive:true,force:true});
    }
    for (const job of heartbeat.commandJobs || []) {
      if (this.commandActive.has(job.id)) continue;
      const taken = await this.api("/commands/take", { id: job.id });
      if (!taken) continue;
      const controller=new AbortController(); this.commandActive.set(job.id,{run:job.run_id,controller});
      void (async () => {
        try { const result = await runCommand(taken, this.config, [this.config.key],controller.signal); await this.api("/commands/result", { id: taken.id, ...result }); }
        catch { await this.api("/commands/result", { id: taken.id, exit_code: null, output: tx("Komut kutusu başlatılamadı; yolları ve çalışma zamanını kontrol edin.") }).catch(() => {}); }
        finally { this.commandActive.delete(job.id); }
      })();
    }
    for (const job of this.commandActive.values()) if(heartbeat.stop.includes(job.run)) job.controller.abort();
    for (const id of heartbeat.stop)
      this.active.get(id)?.stop(tx("Ofis çalışmayı durdurdu."));
    for (const link of heartbeat.links as FolderLink[]) {
      try {
        const documents=documentPaths(link.path,this.config);
        await this.api("/links/validate", {
          id: link.id,
          valid: true,
          detail: tx("Klasör yolu ve belge adları doğrulandı."),
          ...documents,
        });
      } catch {
        await this.api("/links/validate", {
          id: link.id,
          valid: false,
          detail: tx("Klasör yok, korunan alanda veya izinli köklerin dışında."),
        });
      }
    }
    // Avoid copy racing with an agent holding any direct write mount.
    if (!this.active.size && !heartbeat.paused)
      for (const approval of heartbeat.approvals as Approval[]) {
        const taken = await this.api("/approvals/take", { id: approval.id });
        if (!taken) continue;
        try {
          const detail = applyApproval(taken.approval, taken.link, this.config);
          await this.api("/approvals/result", {
            id: approval.id,
            ok: true,
            detail,
          });
        } catch {
          await this.api("/approvals/result", {
            id: approval.id,
            ok: false,
            detail:
              tx("Dosyalar kopyalanamadı. Yol veya hedef içerik değişmiş olabilir. Hedefi kontrol edip yeni onay isteyin."),
          });
        }
      }
    while (
      !this.closing &&
      this.active.size < this.config.concurrency &&
      !heartbeat.paused
    ) {
      const lease: Lease | null = await this.api("/claim", { id: this.id, activeAgents: [...this.agentActive.keys(),...(this.terminal?.agentId?[this.terminal.agentId]:[])] });
      if (!lease) break;
      if (this.closing) {
        await this.api("/finish", { runner: this.id, id: lease.run.id, state: "interrupted", reason: tx("Çalıştırıcı kapatıldı; iş yarıda kaldı.") });
        break;
      }
      void this.execute(lease);
    }
  }
  async execute(lease: Lease): Promise<void> {
    return withLanguage(lease.language || this.config.language || "tr", () => this.executeOnce(lease));
  }
  private async executeOnce(lease: Lease): Promise<void> {
    const id = lease.run.id;
    if (this.agentActive.has(lease.agent.id)) throw new Error(tx("Ajanın önceki süreci henüz kapanmadı."));
    this.agentActive.set(lease.agent.id, id);
    let initialAuth = "";
    let profile = join(this.config.workDir, ".runtime", id),
      reason = "",
      final = "",
      usage: Record<string, number> | undefined;
    let completed = false;
    let streamingText=false;
    let startupDiagnostic = "";
    let quotaResult: ReturnType<typeof quota>;
    let sessionId = lease.session?.provider_id;
    const observer = new UsageObserver();
    const observeUsage=(value:any)=>{
      const observed=observer.observe(lease.agent.runner,value);if(!observed)return;
      return Object.fromEntries(Object.keys({...lease.run.usage,...observed}).map(k=>[k,k==='context_input_tokens' ? observed[k] ?? lease.run.usage[k] : (lease.run.usage[k] || 0)+(observed[k] || 0)]));
    };
    let child: ReturnType<typeof spawn> | undefined;
    const tail = new DiagnosticTail();
    let secrets = [this.config.key, lease.key];
    const safe = (text: string) => redact(text, secrets);
    const diagnostic = async (text: string) => {
      if (text.trim()) await this.api("/update", { runner: this.id, id, kind: "diagnostic", text: safe(text).slice(0, 20000) });
    };
    const kill = () => {
      if (child?.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* exited */
        }
      }
    };
    const acceptanceAbort=new AbortController();
    this.active.set(id, {
      stop: (r) => {
        reason ||= r;
        acceptanceAbort.abort();
        kill();
      },
    });
    let gitPrepared = false, gitFinished = false;
    const copies = this.workspace || (this.testLaunch ? undefined : gitCopies);
    const saveChanges = async () => {
      if (!copies || !gitPrepared || gitFinished) return;
      gitFinished = true;
      for (const change of await copies(lease, this.config, true, secrets, reason))
        await this.api('/update', {runner:this.id,id,kind:'git_change',text:safe(change).slice(0,20000)});
    };
    let timed: ReturnType<typeof setTimeout> | undefined;
    try {
      const prepared = prepare(lease, this.config);
      for (const warning of prepared.command.launchWarnings || []) await diagnostic(warning);
      profile = prepared.profile;
      initialAuth = prepared.initialAuth;
      directoryMaps(lease, prepared.work);
      if (copies) {
        if (lease.saveWorkspaceBeforeStart) {
          for (const change of await copies(lease, this.config, true, secrets, tx("Sahibin isteğiyle önceki değişiklikler kaydedildi.")))
            await this.api('/update', {runner:this.id,id,kind:'git_change',text:safe(change).slice(0,20000)});
        }
        await copies(lease, this.config, false, secrets);
        gitPrepared = true;
      }
      for (const file of lease.incoming || []) {
        const result = await this.api("/incoming", { runner: this.id, run: id, transfer: file.transfer_id, index: file.index });
        receiveFile(prepared.work, file, result.content);
      }
      for (const transfer of new Set((lease.incoming || []).map((f) => f.transfer_id))) await this.api("/incoming/ready", { runner: this.id, run: id, transfer });
      secrets.push(...profileSecrets(profile));
      await this.api("/secrets", { runner: this.id, id, secrets: profileSecrets(profile) });
      if (!this.testLaunch) { if(lease.agent.runner === "claude") verifyClaude(prepared.command,this.config,lease,profile); else verifyShell(prepared.command, this.config, lease, profile); }
      const command = this.testLaunch
        ? this.testLaunch(prepared.command, lease, profile)
        : isolate(prepared.command, this.config, lease, profile);
      const launchBytes = assertLaunchSize(command);
      await diagnostic(JSON.stringify({ olay: "launch_size", ...launchBytes, stdinBytes: Buffer.byteLength(command.stdin || "") }));
      // Namespace probes may take seconds: a takeover/stop during preparation must
      // revoke launch permission before the model can perform filesystem writes.
      await this.api("/ready", { runner: this.id, id });
      if (this.closing || reason) throw new Error(tx("Çalışma başlatılmadan durduruldu."));
      const modelStartedAt=Date.now();
      child = spawn(command.bin, command.args, {
        cwd: command.cwd,
        env: command.env,
        stdio: [command.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        detached: true,
      });
      if (child.stdin) {
        // The process error handler handles EPIPE after early CLI exit.
        child.stdin.on("error", () => {});
        child.stdin.end(command.stdin);
      }
      void diagnostic(JSON.stringify({ olay: "process_start", pid: child.pid })).catch(() => {
        reason = tx("Ofis bağlantısı kesildi; süreç durduruldu.");
        kill();
      });
      const smokeSeconds = this.config.smoke && typeof lease.smokeTimeoutSeconds === "number" && Number.isFinite(lease.smokeTimeoutSeconds)
        && lease.smokeTimeoutSeconds >= 0.01 && lease.smokeTimeoutSeconds <= 60 ? lease.smokeTimeoutSeconds : undefined;
      const timeoutMs = Math.min(lease.policy.timeoutMinutes * 60000, smokeSeconds === undefined ? Infinity : smokeSeconds * 1000);
      if (smokeSeconds !== undefined) await diagnostic(JSON.stringify({ olay: "smoke_timeout", saniye: timeoutMs / 1000 }));
      timed = setTimeout(() => {
        reason = tx("Çalışma süresi aşıldı.");
        kill();
      }, timeoutMs);
      const outputDecoder=new StringDecoder("utf8");
      let buffer = "",
        pending = Promise.resolve(),
        bytes = 0;
      child.stderr!.on("data", (chunk: Buffer) => tail.add(chunk));
      child.stdout!.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2000000) {
          reason = tx("Çıktı sınırı aşıldı.");
          kill();
          return;
        }
        buffer += outputDecoder.write(chunk);
        let pos;
        while ((pos = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, pos);
          buffer = buffer.slice(pos + 1);
          pending = pending.then(async () => {
            if (reason || !line.trim()) return;
            try {
              const value = JSON.parse(line);
              if ((value.type === "thread.started" && value.thread_id) || (value.type === "system" && value.subtype === "init" && value.session_id)) {
                sessionId = value.thread_id || value.session_id;
                if (lease.session) await this.api("/sessions/update", { runner: this.id, id, provider_id: value.thread_id || value.session_id, bytes: profileSize(profile) });
              }
              if (["error", "turn.failed", "result"].includes(value.type)) quotaResult = quota(JSON.stringify(value.error || value.message || (value.is_error ? value : {}))) || quotaResult;
              // A budget event must not discard the final answer on the same line.
              for (const event of parseEvent(lease.agent.runner, value)) if (event.final) final = safe(event.text);
              const observed = observeUsage(value);
              if (observed) {
                usage = observed;
                const result = await this.api("/update", { runner: this.id, id, kind: "usage", text: tx("Gözlenen kullanım"), usage });
                if (result?.stop) { reason = result.reason || tx("Token bütçesi aşıldı."); kill(); return; }
              }
              const events = parseEvent(lease.agent.runner, value);
              for (const event of events) {
                const currentSecrets = profileSecrets(profile);
                secrets.push(...currentSecrets);
                if (currentSecrets.length)
                  await this.api("/secrets", { runner: this.id, id, secrets: currentSecrets });
                if (event.final) final = safe(event.text);
                if (event.final || event.completed) completed = true;
                if(lease.agent.runner==='claude' && event.kind==='text') { if(event.final && streamingText)continue; if(!event.final)streamingText=true; }
                if (event.usage && !usage) usage = event.usage;
                await this.api("/update", {
                  runner: this.id,
                  id,
                  kind: event.kind,
                  text: safe(event.text).slice(0, 20000),
                  usage: event.usage ? usage : undefined,
                });
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : tx("Çıktı okunamadı.");
              await diagnostic(message).catch(() => {});
              startupDiagnostic = message;
              reason = diagnose(message);
              kill();
            }
          });
        }
      });
      const exit = await new Promise<number | null>((resolve, reject) => {
        child!.once("error", reject);
        child!.once("close", (code, signal) => {
          void diagnostic(JSON.stringify({ olay: "process_exit", pid: child!.pid, code, signal })).then(() => resolve(code), () => resolve(code));
        });
      });
      if (timed) clearTimeout(timed);
      await pending;
      buffer+=outputDecoder.end();
      if (buffer.trim() && !reason) {
        try {
          const value = JSON.parse(buffer);
          if ((value.type === "thread.started" && value.thread_id) || (value.type === "system" && value.subtype === "init" && value.session_id)) {
            sessionId=value.thread_id || value.session_id;
            if(lease.session)await this.api('/sessions/update',{runner:this.id,id,provider_id:sessionId,bytes:profileSize(profile)});
          }
          if (["error", "turn.failed", "result"].includes(value.type)) quotaResult=quota(JSON.stringify(value.error || value.message || (value.is_error ? value : {}))) || quotaResult;
          usage = observeUsage(value) || usage;
          for (const event of parseEvent(lease.agent.runner, value)) {
            if (event.final) final = safe(event.text);
            if (event.final || event.completed) completed = true;
            if (event.usage && !usage) usage = event.usage;
            await this.api("/update", { runner: this.id, id, kind: event.kind, text: safe(event.text).slice(0, 20000), usage: event.usage ? usage : undefined });
          }
        } catch (error) {
          await diagnostic(error instanceof Error ? error.message : tx("Eksik çıktı."));
          reason = diagnose(error instanceof Error ? error.message : "");
        }
      }
      if(lease.agent.runner==='codex') {
        const context=codexContextInput(profile,sessionId,modelStartedAt);
        if(context!==undefined){usage={...usage,context_input_tokens:context};await this.api('/update',{runner:this.id,id,kind:'usage',text:tx("Son isteğin bağlam büyüklüğü"),usage});}
      }
      secrets.push(...profileSecrets(profile));
      const stderr = safe(tail.end());
      quotaResult = quota(stderr) || quotaResult;
      if (quotaResult) { reason = quotaResult.reason; await this.api("/quota", { runner: this.id, id, ...quotaResult }); }

      if (sessionId && !reason) await this.api("/sessions/update", { runner: this.id, id, provider_id: sessionId, bytes: profileSize(profile) }).catch(()=>{});
      await diagnostic(stderr);
      const retryable = !reason && exit !== 0 && lease.agent.runner === "codex" && !completed;
      if (!reason && exit !== 0) {
        if (lease.agent.runner === "codex" && completed)
          await diagnostic(tx("Komut satırı kapanırken çöktü; son ajan mesajı veya tamamlanan tur alındığı için iş tamamlandı sayıldı."));
        else reason = diagnose(stderr);
      }
      if(!reason)for(const command of lease.acceptanceCommands || []) {
        const folder=lease.links.find(l=>l.id===command.folder_id);
        if(!folder){reason=tx("Kabul ölçütünün klasör bağlantısı bulunamadı.");break;}
        const remaining=Math.max(0,timeoutMs-(Date.now()-Date.parse(lease.run.started_at || new Date().toISOString())));
        if(remaining<=0){reason=tx("Kabul ölçütü için çalışma süresi kalmadı.");break;}
        const result=await this.acceptanceRunner({id:randomUUID(),run_id:id,agent_id:lease.agent.id,command:{...command,timeout_seconds:Math.min(command.timeout_seconds,Math.max(1,Math.floor(remaining/1000)))},folder,state:'running',exit_code:null,output:''},this.config,secrets,acceptanceAbort.signal);
        await this.api('/acceptance/result',{runner:this.id,id,command:command.id,exit_code:result.exit_code,output:safe(result.output)});
        if(result.exit_code!==0){reason=tx("Kabul ölçütü geçmedi: {0}", [command.name]);break;}
      }
      await saveChanges();
      await this.api("/finish", {
        runner: this.id,
        id,
        state: /token.*(?:bütçe|budget)/i.test(reason) ? "budget_exceeded" : /kapatıl|shut down/i.test(reason) ? "interrupted" : reason ? "failed" : "completed",
        output: final,
        reason: safe(reason),
        usage,
        retryable: !quotaResult && retryable && !transientStartup(stderr + startupDiagnostic),
        startupFailure: !completed && transientStartup(stderr + startupDiagnostic),
        transientStartup: !quotaResult && !completed && !/süresi|time limit/i.test(reason) && transientStartup(stderr + startupDiagnostic),
      });
    } catch (error) {
      try {
        const message = error instanceof Error ? error.message : tx("Çalıştırma başlatılamadı.");
        reason ||= message;
        await saveChanges().catch(async () => { reason += tx(" Dosyalar kaydedilemedi; klasörü kontrol edin."); });
        await diagnostic(message);
        if (error instanceof DirtyWorkspaceError) await this.api('/update', {runner:this.id,id,kind:'workspace_dirty',text:safe(message)});
        if (!child?.pid) await diagnostic(JSON.stringify({ olay: "process_not_started" }));
        await this.api("/finish", {
          runner: this.id,
          id,
          state: "failed",
          startupFailure: !child?.pid || transientStartup(message),
          transientStartup: !completed && transientStartup(message),
          output: final,
          reason: safe(reason || diagnose(error instanceof Error ? error.message : "")),
        });
      } catch {
        /* server recovery handles disconnected runner */
      }
    } finally {
      if (timed) clearTimeout(timed);
      kill();
      if (profile) {
        try {
          retainAuth(
            this.config.workDir,
            lease.agent.runner,
            profile,
            initialAuth,
          );
        } catch {
          /* Keep existing authentication; never log credentials. */
        }
        try {
          if (!lease.session) rmSync(profile, { recursive: true, force: true });
          else for (const file of ["mcp.json", "claude-settings.json"]) rmSync(join(profile, file), { force: true });
        } catch {
          console.error(
            "Could not clean up the temporary work profile. Administrator review is required.",
          );
        }
      }
      if(child?.pid) {
        let alive=true;
        for(let attempt=0;attempt<100 && alive;attempt++) {
          try { process.kill(-child.pid,0); await new Promise(resolve=>setTimeout(resolve,50)); }
          catch(error) { if((error as NodeJS.ErrnoException).code==='ESRCH')alive=false; else break; }
        }
        if(alive)return; // Keep the active marker: reset must fail closed if descendants remain.
      }
      this.active.delete(id);
      this.agentActive.delete(lease.agent.id);
    }
  }
  async shutdown() {
    return withLanguage(this.config.language || "tr", () => this.shutdownOnce());
  }
  private async shutdownOnce() {
    this.closing = true;
    this.terminal?.shutdown();
    for(const job of this.commandActive.values())job.controller.abort();
    for (const a of this.active.values()) a.stop(tx("Çalıştırıcı kapatıldı; iş yarıda kaldı."));
    while (this.active.size || this.commandActive.size || this.ticking)
      await new Promise((resolve) => setTimeout(resolve, 20));
    await this.api("/disconnect", { id: this.id }).catch(() => {});
  }
}

function profileSize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) { if (e.isSymbolicLink()) continue; const p = join(dir, e.name); total += e.isDirectory() ? profileSize(p) : statSync(p).size; }
  return total;
}
