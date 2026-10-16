import { localeFor } from "../shared/i18n/index.js";
import type { Runtime } from './runtime.js';
import type { Run } from '../shared/runtime.js';
import type { Note, TududiData } from '../shared/types.js';
import { Problem } from './service.js';
import { hash } from './security.js';
import { officeDay, previousDay } from '../shared/time.js';
const fingerprint = (v:any) => hash(JSON.stringify({uid:v.uid,name:v.name || '',title:v.title || '',content:v.content || v.description || v.note || '',status:v.status ?? null,due_date:v.due_date || null,tags:(v.tags || []).map((t:any)=>typeof t==='string' ? t : t.name || '').sort()}));
const shortTask = (t: any) => ({ uid:t.uid, name:t.name, status:t.status, project_uid:t.project_uid, due_date:t.due_date, description:String(t.description || t.note || '').slice(0,160) });
export class Notebook {
  private polling = false;
  private lastPoll = 0;
  private emailAttempts = new Map<string,number>();
  constructor(private rt: Runtime) {}
  get db() { return this.rt.db; }
  mark(aid: string, n: Note) {
    const m = this.db.prepare('SELECT * FROM notebook_marks WHERE agent_id=? AND uid=?').get(aid,n.uid);
    const tags = (n.tags || []).map(t => (typeof t === 'string' ? t : t.name || '').toLocaleLowerCase('tr-TR'));
    const verified = String(m?.verified_at || '');
    return { ...n, locked:!!m?.locked || tags.includes('kilitli'), invalid:!!m?.invalid || tags.includes('yanlış'), verified_at:verified || null, stale:!verified || this.rt.clock() - Date.parse(verified) > 30 * 86400000 };
  }
  async data(aid: string) { return await this.rt.office.tududi.read(this.rt.office.token(aid)); }
  async refresh(aid:string) {
    const data=await this.data(aid);
    this.db.prepare('INSERT INTO notebook_cache VALUES (?,?) ON CONFLICT(agent_id) DO UPDATE SET json=excluded.json').run(aid,JSON.stringify({tasks:data.tasks.map(shortTask),notes:data.notes.map(n=>this.meta(aid,n)),fingerprints:Object.fromEntries([...data.tasks,...data.notes].map(v=>[v.uid,fingerprint(v)]))}));
    return data;
  }
  meta(aid: string, n: Note) { const m = this.mark(aid,n); return { uid:n.uid, title:n.title, updated_at:n.updated_at || null, size:Buffer.byteLength(n.content || ''), project_uid:n.project_uid, locked:m.locked, invalid:m.invalid, verified_at:m.verified_at, stale:m.stale }; }
  record(aid: string, kind: string, value: any) {
    this.db.prepare('INSERT INTO notebook_writes VALUES (?,?,?,?) ON CONFLICT(agent_id,kind,uid) DO UPDATE SET fingerprint=excluded.fingerprint').run(aid,kind,value.uid,fingerprint(value));
    this.rt.office.event(aid,'notebook_agent_write',this.rt.office.t("Ajan {0} değiştirdi: {1}", [kind === 'task' ? this.rt.office.t("görevi") : this.rt.office.t("notu"), value.name || value.title || value.uid]));
  }
  async cleanLegacyTasks(aid: string, data: TududiData) {
    for (const task of data.tasks) {
      const note = task.note || task.description || '';
      if (!/\[Ofis işi:[^\]]+\]/.test(note)) continue;
      const cleaned = note.replace(/\[Ofis işi:\s*([^\]]+)\]/g, (_marker, id:string) => {
        if (id.startsWith(aid + ':')) {
          this.db.prepare('INSERT INTO work_items(id,agent_id,task_uid,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET task_uid=COALESCE(work_items.task_uid,excluded.task_uid)').run(id,aid,task.uid,this.rt.isoNow());
        }
        const date = id.match(/\d{4}-\d{2}-\d{2}$/)?.[0];
        return this.rt.office.t("Ofis {0}{1}", [id.includes(':chat:') ? this.rt.office.t("sohbetinden") : this.rt.office.t("işinden"), date ? ' · ' + new Date(date+'T12:00:00Z').toLocaleDateString(localeFor(this.rt.office.language),{timeZone:this.rt.settings().timeZone,day:'numeric',month:'short'}) : '']);
      });
      const updated = await this.rt.office.tududi.updateTaskNote(this.rt.office.token(aid),task.uid,cleaned);
      task.note=cleaned;task.description=cleaned;this.record(aid,'task',updated);
    }
  }
  bindWork(run: Run) {
    const existing=this.rt.a3.workId(run);
    if(existing)return existing;
    const id=/kullanıcı mesajı/i.test(run.trigger) ? `${run.agent_id}:chat:${run.conversation_type}:${run.conversation_id || 'genel'}:${officeDay(this.rt.clock(),this.rt.settings().timeZone)}` : `${run.agent_id}:${run.chain_id}`;
    this.db.prepare('INSERT OR IGNORE INTO work_items(id,agent_id,updated_at) VALUES (?,?,?)').run(id,run.agent_id,this.rt.isoNow());
    this.db.prepare('UPDATE runs SET work_item_id=? WHERE id=?').run(id,run.id);
    return id;
  }
  async prepareWork(run: Run) {
    const existing = this.db.prepare('SELECT work_item_id FROM runs WHERE id=?').get(run.id)?.work_item_id as string | null;
    const id = existing || this.bindWork(run);
    this.db.prepare("INSERT OR IGNORE INTO work_items(id,agent_id,updated_at) VALUES (?,?,?)").run(id,run.agent_id,this.rt.isoNow());
    this.db.prepare('UPDATE runs SET work_item_id=? WHERE id=?').run(id,run.id);
    if(run.scheduled_task_id)await this.rt.scheduler.ensureTask(this.rt.scheduler.task(run.scheduled_task_id));
    const item = this.db.prepare('SELECT * FROM work_items WHERE id=?').get(id)!;
    if (!item.task_uid) {
      const h = run.handoff_id ? this.rt.office.store.snapshot().handoffs.find(h => h.id === run.handoff_id) : undefined;
      const token = this.rt.office.token(run.agent_id), marker = `[Ofis işi: ${id}]`;
      const data = await this.data(run.agent_id);
      const task = h?.tududi_task_uid ? data.tasks.find(t => t.uid === h.tududi_task_uid) : data.tasks.find(t => (t.note || t.description || '').includes(marker));
      const label = this.rt.office.t("Ofis {0} · {1}", [id.includes(':chat:') ? this.rt.office.t("sohbetinden") : this.rt.office.t("işinden"), new Date(run.created_at).toLocaleDateString(localeFor(this.rt.office.language),{timeZone:this.rt.settings().timeZone,day:'numeric',month:'short'})]);
      const created = task || await this.rt.office.tududi.task(token,{name:run.scheduled_task_id ? this.rt.office.t("Zamanlanmış: {0}", [this.rt.scheduler.task(run.scheduled_task_id).name]) : run.summary.slice(0,180),description:run.scheduled_task_id ? String(item.note || '') : `${run.summary}\n\n${label}`,project_uid:await this.rt.office.ensureWorkbook(run.agent_id)});
      if (task && /\[Ofis işi:[^\]]+\]/.test(task.note || task.description || '')) await this.rt.office.tududi.updateTaskNote(token,task.uid,(task.note || task.description || '').replace(/\[Ofis işi:[^\]]+\]/g,label));
      this.db.prepare('UPDATE work_items SET task_uid=? WHERE id=?').run(created.uid,id); this.record(run.agent_id,'task',created);
    }
    if(!run.scheduled_task_id && !item.note && item.task_uid) {
      const task=(await this.data(run.agent_id)).tasks.find(t=>t.uid===item.task_uid);
      const note=String(task?.note || task?.description || '').replace(/\[Ofis işi:[^\]]+\]/g,'').trim().slice(0,1500);
      if(note)this.db.prepare('UPDATE work_items SET note=? WHERE id=?').run(note,id);
    }
    return this.db.prepare('SELECT * FROM work_items WHERE id=?').get(id)!;
  }
  async writeWork(run: Run, text: string) {
    const item = await this.prepareWork(run), token = this.rt.office.token(run.agent_id);
    const note = `${officeDay(this.rt.clock(),this.rt.settings().timeZone)}\n${this.rt.scrub(text)}`;
    const task = await this.rt.office.tududi.updateTaskNote(token,item.task_uid as string,note);
    this.db.prepare('UPDATE work_items SET note=?,updated_at=? WHERE id=?').run(note,this.rt.isoNow(),item.id); this.record(run.agent_id,'task',task); return { ok:true };
  }
  closeTask(aid:string,uid:string) {
    const items=this.db.prepare('SELECT id,close_requested FROM work_items WHERE agent_id=? AND task_uid=?').all(aid,uid);
    this.db.prepare('UPDATE work_items SET close_requested=1 WHERE agent_id=? AND task_uid=?').run(aid,uid);
    if(this.rt.office.agent(aid).session_mode!=='work')return;
    for(const session of this.rt.a3.sessions().filter(s=>s.agent_id===aid && !s.closed && !s.renewing)) {
      const item=items.find(i=>i.id===session.work_item_id);if(!item)continue;
      const active=this.rt.runs().filter(r=>r.agent_id===aid && r.work_item_id===item.id && r.state==='running');
      if(active.length) {
        if(!item.close_requested)for(const run of active)this.rt.log(run.id,'work_close_requested',this.rt.office.t("İşin son notu kaydedildikten sonra oturum kapanacak."));
      } else if(session.provider_id)this.rt.a3.renew(aid,session,true);
    }
  }
  async upsert(aid: string, title: string, content: string, project?: string) {
    const token = this.rt.office.token(aid), data = await this.data(aid), project_uid = project || await this.rt.office.ensureWorkbook(aid);
    const old = data.notes.find(n => n.title === title && n.project_uid === project_uid);
    if (old && this.mark(aid,old).locked) throw new Problem(403,this.rt.office.t("Bu not kilitli; yalnız sahibi değiştirebilir."));
    const body = { title:this.rt.scrub(title),content:this.rt.scrub(content),project_uid };
    const n = old ? await this.rt.office.tududi.updateNote(token,old.uid,body) : await this.rt.office.tududi.note(token,body);
    this.db.prepare('INSERT INTO notebook_marks(agent_id,uid,verified_at) VALUES (?,?,?) ON CONFLICT(agent_id,uid) DO UPDATE SET verified_at=excluded.verified_at').run(aid,n.uid,this.rt.isoNow()); this.record(aid,'note',n); return this.meta(aid,n);
  }
  async readNote(aid: string, id?: string, title?: string) {
    const data = await this.data(aid), matching = data.notes.filter(n => id ? n.uid === id : n.title === title);
    if (matching.length !== 1) throw new Problem(404,this.rt.office.t("Tek bir not seçin; kimlik veya başlık bulunamadı."));
    const n = this.mark(aid,matching[0]); if (n.invalid) throw new Problem(409,this.rt.office.t("Sahibi bu notu yanlış işaretledi; kullanılmaz."));
    return { ...this.meta(aid,n), content:n.content.slice(0,12000) };
  }
  async tool(run: Run, name: string, b: any): Promise<unknown> {
    const aid = run.agent_id;
    switch (name) {
      case 'komut_calistir': return this.rt.a3.requestCommand(run,b.ad);
      case 'engel_bildir': this.rt.a3.blocker(run,b.engel); return {ok:true};
      case 'yayina_hazir': return this.rt.a3.readyCard(run,b.karar);
      case 'is_notu_yaz': return this.writeWork(run,b.metin);
      case 'sohbet_gecmisi': return this.rt.office.inbox(aid).slice(-b.adet).map(m => ({kaynak:m.sender_name,metin:m.text.slice(0,1000),tarih:m.created_at}));
      case 'tududi_notlar': return (await this.refresh(aid)).notes.filter(n => !b.proje || n.project_uid === b.proje).map(n => this.meta(aid,n));
      case 'tududi_not_oku': return this.readNote(aid,b.kimlik,b.baslik);
      case 'tududi_not_yaz': return this.upsert(aid,b.baslik,b.icerik,b.proje);
      case 'tududi_gorevler': return (await this.data(aid)).tasks.filter(t => (b.durum === undefined || String(t.status) === String(b.durum)) && (!b.proje || t.project_uid === b.proje)).slice(0,30).map(shortTask);
      case 'tududi_gorev_oku': { const task=(await this.data(aid)).tasks.find(t=>t.uid===b.kimlik);if(!task)throw new Problem(404,this.rt.office.t("Görev sizin hesabınızda bulunamadı."));return {...shortTask(task),description:String(task.description || task.note || '').slice(0,12000)}; }
      case 'tududi_gorev_ekle': { const t = await this.rt.office.tududi.task(this.rt.office.token(aid),{name:b.name,description:b.description,project_uid:await this.rt.office.ensureWorkbook(aid)}); this.record(aid,'task',t); return shortTask(t); }
      case 'tududi_gorev_guncelle': { const data = await this.data(aid); if (!data.tasks.some(t => t.uid === b.gorev)) throw new Problem(403,this.rt.office.t("Görev sizin hesabınızda değil.")); const t = await this.rt.office.tududi.updateTask(this.rt.office.token(aid),b.gorev,b.durum); this.record(aid,'task',t); if([2,3].includes(b.durum))this.closeTask(aid,b.gorev); return shortTask(t); }
      case 'tududi_ara': {
        const raw = await this.rt.office.tududi.search(this.rt.office.token(aid),b.sorgu,b.proje);
        const own = await this.data(aid), ids = new Set(own.notes.filter(n => !this.mark(aid,n).invalid && (!b.proje || n.project_uid === b.proje)).map(n => n.uid));
        const flat=Array.isArray(raw.results) ? raw.results : Array.isArray(raw) ? raw : [];
        const notes = raw.notes || raw.results?.notes || flat.filter((n:any)=>String(n.type).toLowerCase()==='note'), tasks = raw.tasks || raw.results?.tasks || flat.filter((n:any)=>String(n.type).toLowerCase()==='task');
        return { notlar:notes.filter((n:any) => ids.has(n.uid)).slice(0,5).map((n:any) => ({uid:n.uid,title:n.title || n.name,alinti:String(n.content || n.description || '').slice(0,200)})), gorevler:tasks.filter((t:any) => own.tasks.some(o => o.uid === t.uid && (!b.proje || o.project_uid === b.proje))).slice(0,5).map(shortTask) };
      }
      case 'ortak_notlar': return this.db.prepare('SELECT id,title,updated_at,verified_at,locked FROM shared_notes WHERE invalid=0').all();
      case 'ortak_not_oku': { const n = this.db.prepare('SELECT * FROM shared_notes WHERE id=? AND invalid=0').get(b.kimlik); if (!n) throw new Problem(404,this.rt.office.t("Ortak not bulunamadı.")); return {...n,content:String(n.content).slice(0,12000)}; }
      case 'ortak_not_yaz': {
        if (!this.rt.settings().sharedWriters.includes(aid)) throw new Problem(403,this.rt.office.t("Ortak deftere yazma yetkiniz yok."));
        return this.sharedWrite(b.baslik,b.icerik,aid,false);
      }
    }
    throw new Problem(404,this.rt.office.t("Araç bulunamadı."));
  }
  sharedWrite(title: string, content: string, writer: string, owner: boolean) {
    const old = this.db.prepare('SELECT * FROM shared_notes WHERE title=?').get(title);
    if (old?.locked && !owner) throw new Problem(403,this.rt.office.t("Ortak not kilitli."));
    const id = String(old?.id || hash(title));
    this.db.prepare('INSERT INTO shared_notes(id,title,content,updated_at,verified_at,writer) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at,verified_at=excluded.verified_at,writer=excluded.writer').run(id,title,this.rt.scrub(content),this.rt.isoNow(),this.rt.isoNow(),writer); this.rt.office.changed(); return {id};
  }
  async poll(force = false) {
    if (this.rt.office.resetBlocked()) return;
    if (this.polling || (!force && this.rt.clock()-this.lastPoll < 30000)) return;
    this.polling = true; this.lastPoll = this.rt.clock();
    try {
      for (const a of this.rt.office.store.agents().filter(a => a.tududi_state === 'ready')) {
        try {
          if (a.tududi_email !== `${a.username}@${this.rt.office.emailDomain()}` && this.rt.clock() - (this.emailAttempts.get(a.id) || 0) > 3600000) { this.emailAttempts.set(a.id,this.rt.clock()); await this.rt.office.migrateEmail(a.id); }
          await this.rt.office.ensureWorkbook(a.id);
          try { await this.rt.office.localizeProfile(a.id); } catch { /* Keep reading tasks and notes while profile setup is pending. */ }
          const previous = this.db.prepare('SELECT json FROM notebook_cache WHERE agent_id=?').get(a.id), before = previous ? JSON.parse(previous.json as string) : null;
          const data = await this.data(a.id);
          await this.cleanLegacyTasks(a.id,data);
          for (const [kind, entries] of [['task',data.tasks],['note',data.notes]] as const) for (const value of entries) {
            const currentFingerprint = fingerprint(value), old = before?.fingerprints?.[value.uid];
            const agentWrite = this.db.prepare('SELECT fingerprint FROM notebook_writes WHERE agent_id=? AND kind=? AND uid=?').get(a.id,kind,value.uid)?.fingerprint === currentFingerprint;
            if (before && old !== currentFingerprint && !agentWrite) {
              if(kind==='task' && [2,3].includes((value as any).status)) {
                this.closeTask(a.id,value.uid);
              }

              this.rt.office.event(a.id,'notebook_owner_write',this.rt.office.t("Sahibi {0} değiştirdi: {1}", [kind === 'task' ? this.rt.office.t("görevi") : this.rt.office.t("notu"), (value as any).name || (value as any).title]));
              if (kind === 'task' && a.watch_tasks && ![2,3].includes((value as any).status) && !this.rt.runs().some(r => r.agent_id === a.id && ['queued','running'].includes(r.state))) {
                const r = this.rt.enqueue(a.id,this.rt.office.t("Tududi görevi değişti"),JSON.stringify(shortTask(value)));
                if (r) { const id = `${a.id}:tududi:${value.uid}`; this.db.prepare('INSERT OR IGNORE INTO work_items(id,agent_id,task_uid,updated_at) VALUES (?,?,?,?)').run(id,a.id,value.uid,this.rt.isoNow()); this.db.prepare('UPDATE runs SET work_item_id=? WHERE id=?').run(id,r.id); }
              }
            }
            if (kind === 'task' && a.watch_due && (value as any).due_date && Date.parse((value as any).due_date) <= this.rt.clock() && ![2,3,'done','archived'].includes((value as any).status)) {
              const key = `due:${value.uid}:${(value as any).due_date}`, exists = this.db.prepare('SELECT 1 FROM work_items WHERE id=?').get(key + ':' + a.id);
              if (!exists) { const r = this.rt.enqueue(a.id,this.rt.office.t("Vadesi gelen Tududi görevi"),JSON.stringify(shortTask(value))); if (r) { const marker=key+':'+a.id,id=`${a.id}:tududi:${value.uid}`; this.db.prepare('INSERT INTO work_items(id,agent_id,task_uid,updated_at) VALUES (?,?,?,?)').run(marker,a.id,value.uid,this.rt.isoNow()); this.db.prepare('INSERT OR IGNORE INTO work_items(id,agent_id,task_uid,updated_at) VALUES (?,?,?,?)').run(id,a.id,value.uid,this.rt.isoNow()); this.db.prepare('UPDATE runs SET work_item_id=? WHERE id=?').run(id,r.id); } }
            }
          }
          this.db.prepare('INSERT INTO notebook_cache VALUES (?,?) ON CONFLICT(agent_id) DO UPDATE SET json=excluded.json').run(a.id,JSON.stringify({ tasks:data.tasks.map(shortTask),notes:data.notes.map(n => this.meta(a.id,n)),fingerprints:Object.fromEntries([...data.tasks,...data.notes].map(v => [v.uid,fingerprint(v)])) }));
        } catch { /* Keep the cache offline without making empty model calls. */ }
      }
      const yesterday = previousDay(officeDay(this.rt.clock(),this.rt.settings().timeZone));
      if (!this.db.prepare('SELECT 1 FROM daily_summaries WHERE day=?').get(yesterday)) this.rt.a3.summary(yesterday);
      for (const r of this.db.prepare('SELECT day,json FROM daily_summaries WHERE published=0').all()) {
        try { await this.rt.office.tududi.publishSummary(r.day as string,JSON.parse(r.json as string).text,this.rt.office.config.port===9401 ? this.rt.office.t("Deneme — Günlük özet") : this.rt.office.t("Günlük özet")); this.db.prepare('UPDATE daily_summaries SET published=1 WHERE day=?').run(r.day); } catch { /* Publish the durable summary on the next poll. */ }
      }
    } finally { this.polling = false; }
  }
  async close() { while (this.polling) await new Promise(resolve => setTimeout(resolve,10)); }
}
