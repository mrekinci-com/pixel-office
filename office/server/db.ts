import { translate } from "../shared/i18n/index.js";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultPolicy } from "../shared/runtime.js";
import type {
  Agent,
  Department,
  Handoff,
  Message,
  OfficeEvent,
  Snapshot,
} from "../shared/types.js";
const migrations = [
  `CREATE TABLE departments (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', color TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, title TEXT NOT NULL, department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE RESTRICT, prompt TEXT NOT NULL, runner TEXT NOT NULL CHECK(runner IN ('claude','codex')), model TEXT NOT NULL, effort TEXT NOT NULL, appearance TEXT NOT NULL, desk_x INTEGER NOT NULL DEFAULT 0, desk_y INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'bosta' CHECK(status IN ('bosta','calisiyor','bekliyor','kapali')), current_job TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, tududi_user_id TEXT, tududi_email TEXT NOT NULL UNIQUE, tududi_state TEXT NOT NULL DEFAULT 'pending', tududi_token_encrypted TEXT, tududi_password_encrypted TEXT, agent_key_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
   CREATE TABLE company_rules (id INTEGER PRIMARY KEY CHECK(id=1), text TEXT NOT NULL DEFAULT '');
   INSERT INTO company_rules(id) VALUES (1);
   CREATE TABLE messages (id TEXT PRIMARY KEY, sender_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL, recipient_type TEXT NOT NULL CHECK(recipient_type IN ('agent','department','everyone')), recipient_id TEXT, text TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT);
   CREATE TABLE message_reads (message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, reader_id TEXT NOT NULL, read_at TEXT NOT NULL, PRIMARY KEY(message_id,reader_id));
   CREATE TABLE handoffs (id TEXT PRIMARY KEY, from_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL, to_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', tududi_task_uid TEXT, created_at TEXT NOT NULL);
   CREATE TABLE events (id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL, department_id TEXT REFERENCES departments(id) ON DELETE SET NULL, kind TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);`,
  `CREATE INDEX messages_time ON messages(created_at); CREATE INDEX events_time ON events(created_at);
   CREATE INDEX agents_department ON agents(department_id); CREATE INDEX handoffs_recipient ON handoffs(to_agent_id);
   CREATE INDEX sessions_expiry ON sessions(expires_at);`,
  `ALTER TABLE messages ADD COLUMN sender_type TEXT NOT NULL DEFAULT 'user';
   ALTER TABLE messages ADD COLUMN sender_name TEXT NOT NULL DEFAULT 'Siz';
   UPDATE messages SET sender_type='agent',sender_name=COALESCE((SELECT name FROM agents WHERE agents.id=messages.sender_agent_id),'Eski ajan') WHERE sender_agent_id IS NOT NULL;`,
  `ALTER TABLE agents ADD COLUMN policy TEXT NOT NULL DEFAULT '{}';
   ALTER TABLE messages ADD COLUMN owner_only INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE handoffs ADD COLUMN note TEXT NOT NULL DEFAULT '';
   CREATE TABLE runtime_settings (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0);
   INSERT INTO runtime_settings VALUES (1,'{}',0);
   CREATE TABLE runs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, chain_id TEXT NOT NULL, depth INTEGER NOT NULL, trigger TEXT NOT NULL, summary TEXT NOT NULL, conversation_type TEXT NOT NULL, conversation_id TEXT, state TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, output TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', calls INTEGER NOT NULL DEFAULT 0, retry INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, usage TEXT NOT NULL DEFAULT '{}', lease_hash TEXT, lease_expires INTEGER, runner_id TEXT);
   CREATE INDEX runs_queue ON runs(state,created_at);
   CREATE TABLE chains (id TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, stopped INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE run_logs (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, kind TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE memories (agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE, text TEXT NOT NULL DEFAULT '');
   CREATE TABLE folder_links (id TEXT PRIMARY KEY, json TEXT NOT NULL);
   CREATE TABLE approvals (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, json TEXT NOT NULL);
   CREATE TABLE artifacts (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, json TEXT NOT NULL, content BLOB NOT NULL);`,
  `ALTER TABLE chains ADD COLUMN max_depth INTEGER;
   ALTER TABLE chains ADD COLUMN max_runs INTEGER;`,
  `ALTER TABLE chains ADD COLUMN stop_reason TEXT NOT NULL DEFAULT '';
   ALTER TABLE chains ADD COLUMN stopped_at TEXT;
   ALTER TABLE chains ADD COLUMN message_id TEXT;
   ALTER TABLE chains ADD COLUMN event_id TEXT;
   ALTER TABLE runs ADD COLUMN smoke_timeout_seconds REAL;
   CREATE TABLE tududi_deletions (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, user_id TEXT,
     state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
     detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);`,
  `ALTER TABLE runs ADD COLUMN message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;
   ALTER TABLE runs ADD COLUMN handoff_id TEXT REFERENCES handoffs(id) ON DELETE SET NULL;
   ALTER TABLE runs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE runs ADD COLUMN not_before INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE runs ADD COLUMN startup_retry INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE messages ADD COLUMN response_note TEXT NOT NULL DEFAULT '';
   ALTER TABLE messages ADD COLUMN artifact_ids TEXT NOT NULL DEFAULT '[]';
   CREATE TABLE department_greeters (department_id TEXT PRIMARY KEY REFERENCES departments(id) ON DELETE CASCADE, agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL);
   CREATE TABLE transfers (id TEXT PRIMARY KEY, from_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
     to_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
     handoff_id TEXT REFERENCES handoffs(id) ON DELETE CASCADE, directory TEXT NOT NULL, files TEXT NOT NULL, installed INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE handoff_topics (chain_id TEXT NOT NULL REFERENCES chains(id), pair TEXT NOT NULL, topic TEXT NOT NULL,
     count INTEGER NOT NULL DEFAULT 0, last_from TEXT NOT NULL, last_text TEXT NOT NULL, previous_text TEXT NOT NULL DEFAULT '',
     PRIMARY KEY(chain_id,pair,topic));`,
  `ALTER TABLE events ADD COLUMN conversation_type TEXT;
   ALTER TABLE events ADD COLUMN conversation_id TEXT;
   ALTER TABLE events ADD COLUMN run_id TEXT;
   ALTER TABLE events ADD COLUMN message_id TEXT;
   ALTER TABLE events ADD COLUMN sender_name TEXT NOT NULL DEFAULT '';
   UPDATE runs SET conversation_id=NULL WHERE conversation_type='everyone';`,
  `ALTER TABLE agents ADD COLUMN username TEXT;
   ALTER TABLE agents ADD COLUMN session_mode TEXT NOT NULL DEFAULT 'persistent';
   ALTER TABLE agents ADD COLUMN watch_tasks INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE agents ADD COLUMN watch_due INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE agents ADD COLUMN workbook_uid TEXT;
   CREATE UNIQUE INDEX agents_username ON agents(username);
   CREATE TABLE agent_sessions(agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,json TEXT NOT NULL);
   CREATE TABLE provider_pauses(provider TEXT PRIMARY KEY,json TEXT NOT NULL);
   CREATE TABLE command_links(id TEXT PRIMARY KEY,json TEXT NOT NULL);
   CREATE TABLE command_jobs(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,json TEXT NOT NULL);
   CREATE TABLE profile_deletions(agent_id TEXT PRIMARY KEY);
   CREATE TABLE login_tickets(ticket_hash TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,owner_hash TEXT NOT NULL,expires_at INTEGER NOT NULL);
   CREATE TABLE work_items(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,task_uid TEXT,note TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL);
   ALTER TABLE runs ADD COLUMN work_item_id TEXT;
   ALTER TABLE runs ADD COLUMN session_generation INTEGER;
   ALTER TABLE runs ADD COLUMN session_action TEXT;
   ALTER TABLE runs ADD COLUMN prompt_rules_hash TEXT;
   ALTER TABLE runs ADD COLUMN session_counted_tokens INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE notebook_cache(agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,json TEXT NOT NULL);
   CREATE TABLE notebook_marks(agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,uid TEXT NOT NULL,locked INTEGER NOT NULL DEFAULT 0,invalid INTEGER NOT NULL DEFAULT 0,verified_at TEXT,PRIMARY KEY(agent_id,uid));
   CREATE TABLE notebook_writes(agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,kind TEXT NOT NULL,uid TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(agent_id,kind,uid));
   CREATE TABLE shared_notes(id TEXT PRIMARY KEY,title TEXT NOT NULL,content TEXT NOT NULL,updated_at TEXT NOT NULL,verified_at TEXT NOT NULL,locked INTEGER NOT NULL DEFAULT 0,invalid INTEGER NOT NULL DEFAULT 0,writer TEXT NOT NULL);
   CREATE TABLE blockers(chain_id TEXT NOT NULL REFERENCES chains(id),reason TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(chain_id,reason));
   CREATE TABLE daily_summaries(day TEXT PRIMARY KEY,json TEXT NOT NULL,published INTEGER NOT NULL DEFAULT 0);`,
  `ALTER TABLE agent_sessions RENAME TO agent_sessions_a3;
   CREATE TABLE agent_sessions(session_key TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,json TEXT NOT NULL);
   INSERT INTO agent_sessions SELECT agent_id || ':persistent',agent_id,json_set(json,'$.session_key',agent_id || ':persistent','$.closed',json('true')) FROM agent_sessions_a3;
   DROP TABLE agent_sessions_a3;
   UPDATE agents SET session_mode='work';
   UPDATE runtime_settings SET json=json_set(json,'$.sessionTurnLimit',CASE WHEN COALESCE(json_extract(json,'$.sessionTurnLimit'),100)=100 THEN 12 ELSE json_extract(json,'$.sessionTurnLimit') END,'$.sessionTokenLimit',CASE WHEN COALESCE(json_extract(json,'$.sessionTokenLimit'),3000000)=3000000 THEN 150000 ELSE json_extract(json,'$.sessionTokenLimit') END);
   ALTER TABLE runs ADD COLUMN budget_retry INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE runs ADD COLUMN parent_run_id TEXT;
   ALTER TABLE work_items ADD COLUMN close_requested INTEGER NOT NULL DEFAULT 0;`,

  `CREATE TABLE tududi_profiles(agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,time_zone TEXT NOT NULL);`,
  `CREATE TABLE scheduled_tasks(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,json TEXT NOT NULL);
   CREATE TABLE schedule_history(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,due_at TEXT NOT NULL,run_id TEXT,chain_id TEXT,json TEXT NOT NULL);
   CREATE INDEX schedule_history_task ON schedule_history(task_id);
   CREATE TABLE schedule_retirements(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,task_uid TEXT NOT NULL);
   ALTER TABLE runs ADD COLUMN scheduled_task_id TEXT;
   ALTER TABLE chains ADD COLUMN scheduled_token_budget INTEGER;`,

  `ALTER TABLE agents ADD COLUMN builtin TEXT;
   CREATE UNIQUE INDEX agents_builtin ON agents(builtin) WHERE builtin IS NOT NULL;
   ALTER TABLE agents ADD COLUMN tool_groups TEXT;
   ALTER TABLE agents ADD COLUMN deleted_at TEXT;
   ALTER TABLE departments ADD COLUMN deleted_at TEXT;
   CREATE TABLE office_trash(id TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,expires_at INTEGER NOT NULL,json TEXT NOT NULL);
   CREATE TABLE director_state(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);
   INSERT INTO director_state VALUES(1,'{"auto":false,"ledger":"","ledger_pending":false,"last_batch":0}');
   CREATE TABLE director_events(id TEXT PRIMARY KEY,kind TEXT NOT NULL,subject TEXT NOT NULL,text TEXT NOT NULL,created_at INTEGER NOT NULL);
   CREATE TABLE director_watches(run_id TEXT PRIMARY KEY,work_key TEXT NOT NULL);
   CREATE TABLE director_redirects(work_key TEXT PRIMARY KEY,count INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE director_actions(approval_id TEXT PRIMARY KEY,json TEXT NOT NULL);
   ALTER TABLE runs ADD COLUMN work_options TEXT NOT NULL DEFAULT '{}';
   ALTER TABLE runs ADD COLUMN director_auto INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE dismissed_notices(id TEXT PRIMARY KEY);
   CREATE TABLE director_terminal(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT,kind TEXT NOT NULL,text TEXT NOT NULL,created_at TEXT NOT NULL);`,
  `UPDATE runtime_settings SET json=json_set(json,'$.cachedInputWeight',0.1,
    '$.dailyTokenBudget',CASE WHEN COALESCE(json_extract(json,'$.dailyTokenBudget'),3000000)=3000000 THEN 750000 ELSE json_extract(json,'$.dailyTokenBudget') END,
    '$.chainTokenBudget',CASE WHEN COALESCE(json_extract(json,'$.chainTokenBudget'),1500000)=1500000 THEN 375000 ELSE json_extract(json,'$.chainTokenBudget') END,
    '$.director.dailyTokenBudget',CASE WHEN COALESCE(json_extract(json,'$.director.dailyTokenBudget'),600000)=600000 THEN 150000 ELSE json_extract(json,'$.director.dailyTokenBudget') END);
   UPDATE agents SET policy=json_set(policy,'$.inputTokenBudget',100000) WHERE json_extract(policy,'$.inputTokenBudget')=400000;
   UPDATE agent_sessions SET json=json_set(json,'$.last_input_tokens',0,'$.last_input_tokens_known',json('false'));
   UPDATE agent_sessions SET json=json_set(json,'$.provider_id',NULL,'$.generation',COALESCE(json_extract(json,'$.generation'),0)+1,'$.renewals',COALESCE(json_extract(json,'$.renewals'),0)+1,'$.renewing',json('false'),'$.renew_error',json('false'),'$.turns',0,'$.input_tokens',0,'$.cached_input_tokens',0,'$.counted_cached_tokens',json('{}'),'$.bytes',0,'$.rules_hash','') WHERE agent_id IN (SELECT id FROM agents WHERE builtin='director') AND (json_extract(json,'$.renewing')=1 OR json_extract(json,'$.renew_error')=1);
   UPDATE runs SET state='stopped',reason='Eski Genel Müdür yenileme hazırlığı modelsiz kapatıldı.',finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),lease_hash=NULL,lease_expires=NULL WHERE agent_id IN (SELECT id FROM agents WHERE builtin='director') AND session_action IS NOT NULL AND state IN ('queued','running','waiting');`,

  `ALTER TABLE runtime_settings ADD COLUMN email_domain_seeded INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE runs ADD COLUMN director_followup INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE runs ADD COLUMN context_peak INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE director_watches ADD COLUMN owned INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE director_followups(work_key TEXT PRIMARY KEY,followup_id TEXT NOT NULL);`,
  `ALTER TABLE runtime_settings ADD COLUMN language_initialized INTEGER NOT NULL DEFAULT 1;
   UPDATE runtime_settings SET json=json_set(json,'$.language','tr');`,
  `CREATE TABLE factory_resets(id TEXT PRIMARY KEY,json TEXT NOT NULL,backup TEXT);
   CREATE TABLE reset_gate(id INTEGER PRIMARY KEY CHECK(id=1),reset_id TEXT NOT NULL);`,
];
export class Store {
  db: DatabaseSync;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "ofis.sqlite");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const version =
      (this.db.prepare("SELECT MAX(version) AS v FROM migrations").get()
        ?.v as number) || 0;
    migrations.forEach((sql, i) => {
      if (i + 1 <= version) return;
      this.db.exec("BEGIN");
      try {
        this.db.exec(sql);
        this.db
          .prepare("INSERT INTO migrations VALUES (?,?)")
          .run(i + 1, new Date().toISOString());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
    // Only an empty database gets the new default. Migrations retain the
    // language of existing offices, including pre-language Turkish installs.
    if (version === 0) this.db.prepare("UPDATE runtime_settings SET language_initialized=0,json=json_set(json,'$.language','en') WHERE id=1").run();
  }
  t(key: string, values?: readonly unknown[]) { return translate(this.language(), key, values); }
  language(): import("../shared/i18n/index.js").Language {
    const saved = JSON.parse(String(this.db.prepare("SELECT json FROM runtime_settings WHERE id=1").get()!.json));
    return saved.language === "en" ? "en" : "tr";
  }
  languageInitialized(): boolean { return !!this.db.prepare("SELECT language_initialized FROM runtime_settings WHERE id=1").get()!.language_initialized; }
  setLanguage(language: import("../shared/i18n/index.js").Language) {
    this.db.prepare("UPDATE runtime_settings SET json=json_set(json,'$.language',?),language_initialized=1 WHERE id=1").run(language);
  }
  departments(): Department[] {
    return this.db
      .prepare("SELECT departments.*,department_greeters.agent_id AS responsible_agent_id FROM departments LEFT JOIN department_greeters ON department_greeters.department_id=departments.id WHERE departments.deleted_at IS NULL ORDER BY sort_order,name")
      .all() as unknown as Department[];
  }
  agent(id: string): Agent | undefined {
    const row = this.db
      .prepare(
        "SELECT id,name,title,department_id,prompt,runner,model,effort,appearance,desk_x,desk_y,status,current_job,active,tududi_user_id,tududi_email,tududi_state,created_at,policy FROM agents WHERE id=?",
      )
      .get(id);
    if (!row) return;
    const extra = this.db.prepare("SELECT username,session_mode,watch_tasks,watch_due,workbook_uid,builtin,tool_groups FROM agents WHERE id=?").get(id)!;
    return {
      ...row,
      ...extra,
      builtin: extra.builtin || undefined,
      tool_groups: extra.tool_groups ? JSON.parse(String(extra.tool_groups)) : undefined,
      watch_tasks: !!extra.watch_tasks,
      watch_due: !!extra.watch_due,
      appearance: JSON.parse(row.appearance as string),
      policy: { ...defaultPolicy, ...JSON.parse(row.policy as string) },
      active: !!row.active,
    } as unknown as Agent;
  }
  agents(): Agent[] {
    return this.db
      .prepare("SELECT id FROM agents WHERE deleted_at IS NULL ORDER BY created_at")
      .all()
      .map((r) => this.agent(r.id as string)!);
  }
  messages(): Message[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM messages ORDER BY created_at DESC,rowid DESC LIMIT 500",
        )
        .all()
        .reverse() as unknown as Message[]
    ).map((m) => ({
      ...m,
      owner_only: !!m.owner_only,
      artifact_ids: JSON.parse(m.artifact_ids as unknown as string),
      read_by: this.db
        .prepare("SELECT reader_id FROM message_reads WHERE message_id=?")
        .all(m.id)
        .map((r) => r.reader_id as string),
    }));
  }
  events(): OfficeEvent[] {
    return this.db
      .prepare(
        "SELECT * FROM events ORDER BY created_at DESC,rowid DESC LIMIT 500",
      )
      .all() as unknown as OfficeEvent[];
  }
  rules(): string {
    return this.db.prepare("SELECT text FROM company_rules WHERE id=1").get()!
      .text as string;
  }
  snapshot(): Snapshot {
    return {
      departments: this.departments(),
      agents: this.agents(),
      messages: this.messages(),
      events: this.events(),
      handoffs: this.db
        .prepare("SELECT * FROM handoffs ORDER BY created_at DESC")
        .all() as unknown as Handoff[],
      rules: this.rules(),
    };
  }
  event(agentId: string | null, kind: string, text: string,
    context: Pick<OfficeEvent, "conversation_type" | "conversation_id" | "run_id" | "message_id"> = {}): OfficeEvent {
    const event: OfficeEvent = {
      id: randomUUID(),
      agent_id: agentId,
      department_id: agentId
        ? this.agent(agentId)?.department_id || null
        : null,
      kind,
      text,
      created_at: new Date().toISOString(),
      sender_name: agentId ? this.agent(agentId)?.name || "" : this.t("Sistem"),
      ...context,
    };
    this.db
      .prepare("INSERT INTO events(id,agent_id,department_id,kind,text,created_at,conversation_type,conversation_id,run_id,message_id,sender_name) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        event.id,
        event.agent_id,
        event.department_id,
        event.kind,
        event.text,
        event.created_at,
        event.conversation_type || null,
        event.conversation_id || null,
        event.run_id || null,
        event.message_id || null,
        event.sender_name || "",
      );
    return event;
  }
  fullPrompt(id: string): string {
    return Object.values(this.promptParts(id)).join("\n\n");
  }
  promptParts(id: string): Record<string, string> {
    const agent = this.agent(id);
    if (!agent) throw new Error(this.t("Ajan bulunamadı."));
    const departments = this.departments();
    const directory = this.agents()
      .filter((a) => a.active && a.id !== id)
      .map(
        (a) =>
          agent.builtin==='director' ? `- ${a.name.slice(0,80)} (${a.id}): ${a.title.slice(0,100)}` : this.t("- {0} ({1}): {2}; görevi: {3}; {4}", [a.name, a.id, a.title, a.prompt.slice(0, 240), departments.find((d) => d.id === a.department_id)?.name || ""]),
      )
      .join("\n");
    return { "Şirket kuralları": this.t("Şirket kuralları\n{0}", [this.rules()]), "Ajan talimatı": this.t("Ajan talimatı\n{0}", [agent.prompt]), "Şirket rehberi": this.t("Şirket rehberi\n{0}", [directory]) };
  }
  close(): void {
    this.db.close();
  }
}
