import { translate, type Language } from "../shared/i18n/index.js";
import { directorPromptEn } from "../shared/i18n/prompts.js";
import { directorPrompt } from "../shared/director.js";
import { defaultSettings, defaultPolicy } from "../shared/runtime.js";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Agent, Handoff, Message } from "../shared/types.js";
import type { Config } from "./config.js";
import { Store } from "./db.js";
import { decrypt, encrypt, hash, newKey } from "./security.js";
import { TududiClient, TududiError } from "./tududi.js";
export class Problem extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export class Office {
  redact: (text: string) => string = text => text;
  redactValue: (value: unknown) => unknown = value => value;
  bus = new EventEmitter();
  inFlight = 0;
  background = new Set<Promise<unknown>>();
  resetBlocked() { return !!this.store.db.prepare('SELECT 1 FROM reset_gate').get(); }
  track(p: Promise<unknown>) { this.background.add(p); void p.finally(()=>this.background.delete(p)).catch(()=>{}); return p; }
  private locks = new Map<string, Promise<unknown>>();
  constructor(
    public store: Store,
    public config: Config,
    public tududi: TududiClient,
  ) {
    this.bus.setMaxListeners(0);
    if(config.tududiEmailDomain && !this.store.db.prepare('SELECT email_domain_seeded FROM runtime_settings WHERE id=1').get()!.email_domain_seeded){
      const row=this.store.db.prepare('SELECT json FROM runtime_settings WHERE id=1').get()!,settings=JSON.parse(String(row.json));
      if(!settings.emailDomain || settings.emailDomain==='piksel-ofis.local')settings.emailDomain=config.tududiEmailDomain;
      this.store.db.prepare('UPDATE runtime_settings SET json=?,email_domain_seeded=1 WHERE id=1').run(JSON.stringify(settings));
      for(const a of this.store.agents().filter(a=>!a.tududi_user_id))this.store.db.prepare('UPDATE agents SET tududi_email=? WHERE id=?').run(`${a.username || this.availableUsername(a.name)}@${settings.emailDomain}`,a.id);
    }
    for (const a of this.store.agents()) if (!a.username) this.store.db.prepare("UPDATE agents SET username=? WHERE id=?").run(this.availableUsername(a.name), a.id);
  }
  get language(): Language { return this.store.language(); }
  t(key: string, values?: readonly unknown[]) { return translate(this.language, key, values); }
  setLanguage(language: Language, initialize = false) {
    const previous = this.language;
    this.store.setLanguage(language);
    const director = this.store.agents().find(a=>a.builtin === "director");
    if (director && previous !== language) {
      if ([directorPrompt,directorPromptEn].includes(director.prompt)) this.store.db.prepare("UPDATE agents SET prompt=? WHERE id=?").run(language === "en" ? directorPromptEn : directorPrompt,director.id);
      if (["Genel Müdür","Director"].includes(director.name)) this.store.db.prepare("UPDATE agents SET name=? WHERE id=?").run(this.t("Genel Müdür"),director.id);
      if (["Genel Müdür","Director"].includes(director.title)) this.store.db.prepare("UPDATE agents SET title=? WHERE id=?").run(this.t("Genel Müdür"),director.id);
      const department = this.store.departments().find(d=>d.id === director.department_id);
      if (department && ["Yönetim","Management"].includes(department.name)) this.store.db.prepare("UPDATE departments SET name=?,description=? WHERE id=?").run(this.t("Yönetim"),["Ofisin yerleşik yöneticisi","Built-in office manager"].includes(department.description) ? this.t("Ofisin yerleşik yöneticisi") : department.description,department.id);
    }
    const row=this.store.db.prepare("SELECT json FROM runtime_settings WHERE id=1").get()!,saved=JSON.parse(String(row.json));
    const englishRules=["Request approval for external actions (email, publishing, writing to external systems, spending money). Replies and deliveries to the owner and agent handoffs do not require this approval."];
    if (!saved.approvalRules || JSON.stringify(saved.approvalRules)===JSON.stringify(defaultSettings.approvalRules) || JSON.stringify(saved.approvalRules)===JSON.stringify(englishRules)) {
      saved.approvalRules=language === "en" ? englishRules : defaultSettings.approvalRules;
      this.store.db.prepare("UPDATE runtime_settings SET json=? WHERE id=1").run(JSON.stringify(saved));
    }
    if (initialize && director) this.event(director.id,"director_created",this.t("Genel Müdür ofise yerleşti."));
    this.changed();
  }
  ensureDirector() {
    const existing=this.store.agents().find(a=>a.builtin==='director');
    if(existing){
      const old='Her turda yonetim_defteri ile açık işler, kimde, sıradaki adım ve bekleyen soruları güncelle; bu not kalıcı konuşma yenilendiğinde de devam kaynağıdır. Onay veya sonuç beklerken boş çalışma başlatma.';
      if(existing.prompt.includes(old))this.store.db.prepare('UPDATE agents SET prompt=? WHERE id=?').run(existing.prompt.replace(old,'Açık işler veya kararlar değişirse yonetim_defteri yaz; selam ve bilgi sorusunda yazma. Otomatik takipte defter zorunludur.'),existing.id);
      return this.agent(existing.id);
    }
    const settings={...defaultSettings,...JSON.parse(String(this.store.db.prepare('SELECT json FROM runtime_settings WHERE id=1').get()!.json))};
    const department=randomUUID(),aid=randomUUID(),username=this.availableUsername('genel-mudur');
    this.store.db.exec('BEGIN');
    try {
      this.store.db.prepare('INSERT INTO departments(id,name,description,color,sort_order) VALUES (?,?,?,?,?)').run(department,this.t("Yönetim"),this.t("Ofisin yerleşik yöneticisi"),'#475569',0);
      this.store.db.prepare(`INSERT INTO agents(id,name,title,department_id,prompt,runner,model,effort,appearance,desk_x,desk_y,status,current_job,active,tududi_email,tududi_password_encrypted,agent_key_hash,created_at,username,session_mode,builtin,policy) VALUES (?,?,?,?,?,?,?,?,?,0,0,'bosta','',1,?,?,?,?,?,'persistent','director',?)`).run(aid,this.t("Genel Müdür"),this.t("Genel Müdür"),department,(this.language === "en" ? directorPromptEn : directorPrompt),settings.defaultRunner || 'codex',settings.defaultModel,settings.defaultEffort,JSON.stringify({style:'kisa',skin:'#d6a27c',hair:'#343038',shirt:'#27334b',pants:'#202b40',tie:true}),`${username}@${settings.emailDomain}`,encrypt(newKey(),this.config.secretKey,aid),hash(newKey()),new Date().toISOString(),username,JSON.stringify({permission:'workspace',commands:false,network:false}));
      this.store.db.exec('COMMIT');
    } catch(error) {this.store.db.exec('ROLLBACK');throw error;}
    if (this.store.languageInitialized()) this.event(aid,'director_created',this.t("Genel Müdür ofise yerleşti."));
    return this.agent(aid);
  }
  async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.locks.set(id, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }
  changed(type = "changed", data: unknown = {}): void {
    this.bus.emit("update", { type, data: this.redactValue(data) });
  }
  event(agentId: string | null, kind: string, text: string,
    context: Parameters<Store["event"]>[3] = {}) {
    const event = this.store.event(agentId, kind, this.redact(text), context);
    this.changed("event", event);
    return event;
  }
  agent(id: string): Agent {
    const a = this.store.agent(id);
    if (!a || this.store.db.prepare("SELECT deleted_at FROM agents WHERE id=?").get(id)?.deleted_at) throw new Problem(404, this.t("Ajan bulunamadı."));
    return a;
  }
  token(id: string): string {
    this.agent(id);
    const row = this.store.db
      .prepare("SELECT tududi_token_encrypted FROM agents WHERE id=?")
      .get(id);
    if (!row?.tududi_token_encrypted)
      throw new Problem(
        409,
        this.t("Tududi hesabı bekliyor. Önce hesap kurulumunu tekrar deneyin."),
      );
    return decrypt(
      row.tududi_token_encrypted as string,
      this.config.secretKey,
      id,
    );
  }
  async createAgent(
    input: Omit<
      Agent,
      "id" | "created_at" | "tududi_user_id" | "tududi_email" | "tududi_state"
    >,
  ): Promise<Agent> {
    if (input.runner === 'claude' && input.policy?.commands)
      throw new Problem(400, this.t("Claude için komut çalıştırma açılamaz. Codex seçin."));
    if (!this.store.departments().some((d) => d.id === input.department_id))
      throw new Problem(400, this.t("Önce geçerli bir bölüm seçin."));
    const id = randomUUID();
    const username = input.username || this.availableUsername(input.name);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(username) || username.length > 40) throw new Problem(400, this.t("Kullanıcı adı küçük harf, rakam ve tire içermeli."));
    if (this.store.agents().some(a => a.username === username)) throw new Problem(409, this.t("Kullanıcı adı zaten kullanılıyor."));
    const email = `${username}@${this.emailDomain()}`;
    this.store.db
      .prepare(
        `INSERT INTO agents(id,name,title,department_id,prompt,runner,model,effort,appearance,desk_x,desk_y,status,current_job,active,tududi_email,tududi_password_encrypted,agent_key_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.name,
        input.title,
        input.department_id,
        input.prompt,
        input.runner,
        input.model,
        input.effort,
        JSON.stringify(input.appearance),
        input.desk_x,
        input.desk_y,
        input.active ? input.status : "kapali",
        input.current_job,
        Number(input.active),
        email,
        encrypt(newKey(), this.config.secretKey, id),
        hash(newKey()),
        new Date().toISOString(),
      );
    this.store.db
      .prepare("UPDATE agents SET policy=? WHERE id=?")
      .run(JSON.stringify(input.policy || {}), id);
    this.store.db.prepare("UPDATE agents SET username=?,session_mode=?,watch_tasks=?,watch_due=? WHERE id=?").run(username,input.session_mode || "work",Number(input.watch_tasks || false),Number(input.watch_due || false),id);
    this.store.db.prepare("UPDATE agents SET tool_groups=? WHERE id=?").run(input.tool_groups ? JSON.stringify(input.tool_groups) : null,id);
    this.event(id, "agent_created", this.t("{0} ofise katıldı.", [input.name]));
    return this.provision(id);
  }
  async provision(id: string): Promise<Agent> {
    return this.locked(id, async () => {
      const a = this.agent(id);
      if (a.tududi_state === "ready") return a;
      const row = this.store.db
        .prepare("SELECT tududi_password_encrypted FROM agents WHERE id=?")
        .get(id)!;
      const password = decrypt(
        row.tududi_password_encrypted as string,
        this.config.secretKey,
        id,
      );
      try {
        if (!a.tududi_user_id) {
          const userId = await this.tududi.createUser(
            a.tududi_email,
            password,
            a.name,
          );
          this.store.db
            .prepare("UPDATE agents SET tududi_user_id=? WHERE id=?")
            .run(userId, id);
        }
        const token = await this.tududi.createKey(a.tududi_email, password);
        this.store.db
          .prepare(
            "UPDATE agents SET tududi_token_encrypted=?,tududi_state='ready' WHERE id=?",
          )
          .run(encrypt(token, this.config.secretKey, id), id);
        this.event(id, "tududi_ready", this.t("{0} için Tududi hesabı hazır.", [a.name]));
      } catch (error) {
        if (!(error instanceof TududiError)) throw error;
        this.event(
          id,
          "tududi_pending",
          this.t("{0}: {1} Hesap kurulumu bekliyor.", [a.name, error.message]),
        );
      }
      if (this.agent(id).tududi_state === "ready") { try { await this.ensureWorkbook(id); } catch (error) { if (!(error instanceof TududiError)) throw error; this.event(id,"workbook_pending",this.t("Çalışma defteri bağlantı hazır olduğunda kurulacak.")); } }
      if (this.agent(id).tududi_state === "ready") { try { await this.localizeProfile(id); } catch { this.event(id,"tududi_profile_pending",this.t("Türkçe hesap ayarı bağlantı hazır olduğunda uygulanacak.")); } }
      this.changed("agent", this.agent(id));
      return this.agent(id);
    });
  }
  emailDomain() { return JSON.parse(this.store.db.prepare("SELECT json FROM runtime_settings WHERE id=1").get()!.json as string).emailDomain || "piksel-ofis.local"; }
  async localizeProfile(id: string) {
    const a = this.agent(id);
    if (a.tududi_state !== 'ready') return;
    const timeZone = JSON.parse(this.store.db.prepare('SELECT json FROM runtime_settings WHERE id=1').get()!.json as string).timeZone || 'Europe/Istanbul';
    if (this.store.db.prepare('SELECT time_zone FROM tududi_profiles WHERE agent_id=?').get(id)?.time_zone === timeZone + ":" + this.language) return;
    await this.locked(`profile:${id}`, async () => {
      if (this.store.db.prepare('SELECT time_zone FROM tududi_profiles WHERE agent_id=?').get(id)?.time_zone === timeZone + ":" + this.language) return;
      await this.tududi.localizeProfile(this.token(id),timeZone,this.language);
      this.store.db.prepare('INSERT INTO tududi_profiles VALUES (?,?) ON CONFLICT(agent_id) DO UPDATE SET time_zone=excluded.time_zone').run(id,timeZone + ":" + this.language);
    });
  }
  availableUsername(name: string) {
    const slug = name.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/ı/g,"i").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,30) || "ajan";
    let candidate = slug, n = 1;
    while (this.store.agents().some(a => a.username === candidate)) candidate = `${slug}-${++n}`;
    return candidate;
  }
  async migrateEmail(id: string, username?: string) {
    const a = this.agent(id), name = username || a.username!;
    if (this.store.agents().some(other => other.id !== id && other.username === name)) throw new Problem(409,this.t("Kullanıcı adı zaten kullanılıyor."));
    this.store.db.prepare("UPDATE agents SET username=? WHERE id=?").run(name,id);
    const email = `${name}@${this.emailDomain()}`;
    if (email === a.tududi_email) return;
    try {
      if (a.tududi_user_id) await this.tududi.updateUser(a.tududi_user_id,{email});
      this.store.db.prepare("UPDATE agents SET tududi_email=? WHERE id=?").run(email,id);
      this.event(id,"tududi_address",this.t("Ajan hesabının e-posta adresi güncellendi."));
    } catch (error) { if (!(error instanceof TududiError)) throw error; this.event(id,"tududi_address_pending",this.t("E-posta taşıması yapılamadı; veriler ve önceki adres korundu.")); }
  }
  async password(id: string) {
    return this.locked(`password:${id}`,async () => {
      const a = this.agent(id), row = this.store.db.prepare("SELECT tududi_password_encrypted FROM agents WHERE id=?").get(id)!;
      if (row.tududi_password_encrypted) return decrypt(row.tududi_password_encrypted as string,this.config.secretKey,id);
      if (!a.tududi_user_id) throw new Problem(409,this.t("Hesap kurulumu bekliyor."));
      const password = newKey();
      await this.tududi.updateUser(a.tududi_user_id,{password});
      // Some forks return 200 without saving the virtual password field.
      // Verify login before storing a password; do not recreate the account.
      try { await this.tududi.login(a.tududi_email,password); }
      catch (error) {
        if (error instanceof TududiError && error.status === 401)
          throw new Problem(409,this.t("Bu eski hesabın şifresi saklanmamış ve Tududi şifre yenilemeyi uygulamadı. Verileri korunuyor; Tududi yönetici hesabından yönetebilirsiniz."));
        throw error;
      }
      this.store.db.prepare("UPDATE agents SET tududi_password_encrypted=? WHERE id=?").run(encrypt(password,this.config.secretKey,id),id);
      return password;
    });
  }
  async ensureWorkbook(id: string): Promise<string> {
    const a = this.agent(id); if (a.workbook_uid) return a.workbook_uid;
    return this.locked(`workbook:${id}`, async () => {
      if (this.agent(id).workbook_uid) return this.agent(id).workbook_uid!;
      const token = this.token(id), data = await this.tududi.read(token);
      const project = data.projects.find(p => ["Çalışma defteri","Workbook"].includes(p.name)) || await this.tududi.project(token,this.t("Çalışma defteri"));
      for (const title of [this.t("Gelen işler"), this.t("Devam eden"), this.t("Notlar"), this.t("Harita"), this.t("Kararlar"), this.t("Bilinen kusurlar"), this.t("Nasıl yapılır"), this.t("Canlı oturum")]) {
        if (data.notes.some(n => n.title === title && (!n.project_uid || n.project_uid === project.uid))) continue;
        const content = ["Canlı oturum","Live session"].includes(title) ? this.t("Bu ajanın canlı oturumu: {0}/?oturum={1}\nOfis sahibi giriş yaparak izleyebilir ve yön verebilir.", [this.config.publicOrigin || "http://127.0.0.1:9400", id]) : this.t("{0} — Henüz doğrulanmış bilgi eklenmedi.", [new Date().toISOString().slice(0,10)]);
        await this.tududi.note(token,{title,content,project_uid:project.uid});
      }
      this.store.db.prepare("UPDATE agents SET workbook_uid=? WHERE id=?").run(project.uid,id); return project.uid;
    });
  }
  async removeAgent(id: string, deleteAccount: boolean, deleteProfile = false) {
    if(this.agent(id).builtin==='director')throw new Problem(403,this.t("Genel Müdür silinemez."));
    return this.locked(id, async () => {
      const a = this.agent(id);
      if (deleteAccount) {
        // Persist before the network operation; no password/token survives agent deletion.
        this.store.db.prepare("INSERT OR IGNORE INTO tududi_deletions(id,name,email,user_id,created_at) VALUES (?,?,?,?,?)")
          .run(id, a.name, a.tududi_email, a.tududi_user_id, new Date().toISOString());
        await this.deletePendingAccount(id);
      }
      this.store.db
        .prepare(
          "DELETE FROM messages WHERE recipient_type='agent' AND recipient_id=?",
        )
        .run(id);
      if (deleteProfile) this.store.db.prepare("INSERT OR IGNORE INTO profile_deletions VALUES (?)").run(id);
      this.store.db.prepare("DELETE FROM agents WHERE id=?").run(id);
      const pending = !!this.store.db.prepare("SELECT id FROM tududi_deletions WHERE id=?").get(id);
      const message = this.t("{0} silindi; Tududi hesabı {1}.", [a.name, pending ? this.t("silinmeyi bekliyor. Bağlantı hazır olduğunda yeniden denenecek") : deleteAccount ? "silindi" : this.t("bırakıldı")]);
      this.event(
        null,
        "agent_deleted",
        message,
      );
      return { ok: true, pending, message };
    });
  }
  pendingDeletions() {
    return this.store.db.prepare("SELECT id,name,state,detail,next_at,attempts FROM tududi_deletions ORDER BY created_at").all();
  }
  private async deletePendingAccount(id: string) {
    return this.locked(`deletion:${id}`, async () => {
      const row = this.store.db.prepare("SELECT * FROM tududi_deletions WHERE id=?").get(id);
      if (!row || Number(row.next_at) > Date.now()) return;
      try {
        // An e-mail match is not ownership proof: a pending conflict can belong to another office.
        const userId = row.user_id as string | null;
        if (userId) {
          this.store.db.prepare("UPDATE tududi_deletions SET user_id=? WHERE id=?").run(userId, id);
          try { await this.tududi.deleteUser(userId); }
          catch (error) { if (!(error instanceof TududiError && error.status === 404)) throw error; }
        }
        this.store.db.prepare("DELETE FROM tududi_deletions WHERE id=?").run(id);
        this.event(null, "tududi_deleted", this.t("{0}: Tududi hesabı silindi.", [row.name]));
      } catch (error) {
        if (!(error instanceof TududiError)) throw error;
        const delay = error.status === 429 ? error.retryAfterSeconds * 1000 : Math.min(600000, 5000 * 2 ** Math.min(7, Number(row.attempts)));
        this.store.db.prepare("UPDATE tududi_deletions SET attempts=attempts+1,next_at=?,detail=? WHERE id=?")
          .run(Date.now() + delay, error.message, id);
        this.event(null, "tududi_delete_pending", `${row.name}: hesap silinmeyi bekliyor. ${error.message}`);
      }
      this.changed();
    });
  }
  private deleting?: Promise<void>;
  retryDeletions() {
    if (!this.deleting) this.deleting = (async () => {
      const rows = this.store.db.prepare("SELECT id FROM tududi_deletions WHERE next_at<=?").all(Date.now());
      for (const row of rows) await this.deletePendingAccount(row.id as string);
    })().finally(() => { this.deleting = undefined; });
    return this.deleting;
  }
  async close() { await this.deleting; }
  message(
    senderId: string | null,
    recipientType: Message["recipient_type"],
    recipientId: string | null,
    text: string,
    ownerOnly = false,
    senderType?: Message["sender_type"],
  ): Message {
    text = this.redact(text);
    if (recipientType === "agent") this.agent(recipientId || "");
    if (
      recipientType === "department" &&
      !this.store.departments().some((d) => d.id === recipientId)
    )
      throw new Problem(404, this.t("Bölüm bulunamadı."));
    const m: Message = {
      id: randomUUID(),
      owner_only: ownerOnly,
      sender_agent_id: senderId,
      sender_type: senderType || (senderId ? "agent" : "user"),
      sender_name: senderType === "system" ? this.t("Sistem") : senderId ? this.agent(senderId).name : this.t("Siz"),
      recipient_type: recipientType,
      recipient_id: recipientType === "everyone" ? null : recipientId,
      text,
      created_at: new Date().toISOString(),
      read_at: null,
    };
    this.store.db
      .prepare(
        "INSERT INTO messages(id,sender_agent_id,recipient_type,recipient_id,text,created_at,read_at,sender_type,sender_name,owner_only) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        m.id,
        m.sender_agent_id,
        m.recipient_type,
        m.recipient_id,
        m.text,
        m.created_at,
        m.read_at,
        m.sender_type!,
        m.sender_name!,
        Number(ownerOnly),
      );
    this.changed("message", m);
    this.event(
      senderId,
      "message",
      `${m.sender_name}: ${text.slice(0, 180)}`,
    );
    return m;
  }
  inbox(id: string): Message[] {
    const a = this.agent(id);
    return this.store
      .messages()
      .filter(
        (m) =>
          !m.owner_only &&
          (m.recipient_type === "everyone" ||
            (m.recipient_type === "agent" && m.recipient_id === id) ||
            (m.recipient_type === "department" &&
              m.recipient_id === a.department_id)),
      );
  }
  readMessage(id: string, readerId: string): void {
    const now = new Date().toISOString();
    this.store.db
      .prepare("INSERT OR IGNORE INTO message_reads VALUES (?,?,?)")
      .run(id, readerId, now);
    this.store.db
      .prepare("UPDATE messages SET read_at=COALESCE(read_at,?) WHERE id=?")
      .run(now, id);
    this.changed();
  }
  async handoff(
    from: string | null,
    to: string,
    title: string,
    description: string,
  ): Promise<Handoff> {
    this.agent(to);
    const id = randomUUID();
    this.store.db
      .prepare(
        "INSERT INTO handoffs(id,from_agent_id,to_agent_id,title,description,status,tududi_task_uid,created_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        from,
        to,
        title,
        description,
        "pending",
        null,
        new Date().toISOString(),
      );
    this.event(
      from,
      "handoff",
      this.t("{0} için iş devri: {1}", [this.agent(to).name, title]),
    );
    return this.retryHandoff(id);
  }
  async retryHandoff(id: string): Promise<Handoff> {
    return this.locked(`handoff:${id}`, async () => {
      const row = this.store.db
        .prepare("SELECT * FROM handoffs WHERE id=?")
        .get(id) as unknown as Handoff;
      if (!row) throw new Problem(404, this.t("Görev devri bulunamadı."));
      if (row.status !== "pending") return row;
      try {
        const token = this.token(row.to_agent_id);
        const marker = `[Piksel Ofis devri: ${id}]`;
        const data = await this.tududi.read(token);
        const existing = data.tasks.find((t) =>
          t.description?.includes(marker),
        );
        const task =
          existing ||
          (await this.tududi.task(token, {
            name: row.title,
            description: `${row.description}\n\n${marker}`,
            project_uid: await this.ensureWorkbook(row.to_agent_id),
          }));
        if (!task.uid) throw new TududiError(502);
        this.store.db
          .prepare(
            "UPDATE handoffs SET status='created',tududi_task_uid=? WHERE id=?",
          )
          .run(task.uid, id);
        this.event(
          row.to_agent_id,
          "task_created",
          this.t("{0} Tududi görevlerine eklendi.", [row.title]),
        );
      } catch (error) {
        if (!(
          error instanceof TududiError ||
          (error instanceof Problem && error.status === 409)
        ))
          throw error;
        this.event(
          row.to_agent_id,
          "handoff_pending",
          this.t("{0}: Tududi'ye aktarılması bekleniyor.", [row.title]),
        );
      }
      this.changed();
      return this.store.db
        .prepare("SELECT * FROM handoffs WHERE id=?")
        .get(id) as unknown as Handoff;
    });
  }
}
