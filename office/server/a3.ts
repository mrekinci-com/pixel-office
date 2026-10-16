import { localeFor } from "../shared/i18n/index.js";
import { randomUUID } from 'node:crypto';
import type { Runtime } from './runtime.js';
import { Problem } from './service.js';
import { hash } from './security.js';
import { officeDay, dayStart, previousDay } from '../shared/time.js';
import { usageTotals, type AgentSession, type ProviderPause, type CommandLink, type CommandJob, type Run, type Approval } from '../shared/runtime.js';
export class A3 {
  constructor(private rt: Runtime) {}
  get db() { return this.rt.db; }
  sessions(): AgentSession[] { return this.db.prepare('SELECT agent_sessions.json FROM agent_sessions JOIN agents ON agents.id=agent_sessions.agent_id WHERE agents.deleted_at IS NULL ORDER BY agent_sessions.rowid').all().map(r => JSON.parse(r.json as string)); }
  saveSession(s: AgentSession) {
    s.session_key ||= `${s.agent_id}:persistent`;
    this.db.prepare('INSERT INTO agent_sessions VALUES (?,?,?) ON CONFLICT(session_key) DO UPDATE SET json=excluded.json').run(s.session_key,s.agent_id,JSON.stringify(s));
  }
  workId(run: Run): string | null {
    return this.db.prepare('SELECT work_item_id FROM runs WHERE id=?').get(run.id)?.work_item_id as string | null;
  }
  session(id: string, run?: Run): AgentSession {
    const a = this.rt.office.agent(id), all = this.sessions().filter(s => s.agent_id === id);
    const selectable=all.filter(s=>a.session_mode==='persistent' || !s.session_key?.endsWith(':persistent'));
    const work = run ? this.workId(run) : undefined;
    const key = a.session_mode === 'persistent' ? `${id}:persistent` : work ? `${id}:work:${work}` : undefined;
    let s = key ? all.find(s => s.session_key === key) : selectable.sort((a,b) => String(a.last_input_at || a.created_at).localeCompare(String(b.last_input_at || b.created_at)) || a.generation-b.generation).at(-1);
    if (!s) {
      s = { session_key:key || `${id}:work:${id}:chat:agent:${id}:${officeDay(this.rt.clock(),this.rt.settings().timeZone)}`,work_item_id:work || (a.session_mode==='work' ? `${id}:chat:agent:${id}:${officeDay(this.rt.clock(),this.rt.settings().timeZone)}` : null),agent_id:id,runner:a.runner,generation:Math.max(0,...all.map(s=>s.generation))+1,provider_id:null,created_at:this.rt.isoNow(),last_input_at:this.rt.isoNow(),last_input_tokens:0,last_input_tokens_known:false,turns:0,input_tokens:0,cached_input_tokens:0,counted_cached_tokens:{},renewals:0,bytes:0,rules_hash:'',renewing:false };
      this.saveSession(s);
    }
    if (s.runner !== a.runner || (run && s.closed)) return this.rotate(id,s);
    return s;
  }
  rotate(id: string, old = this.session(id)) {
    const s: AgentSession = {...old,runner:this.rt.office.agent(id).runner,generation:Math.max(...this.sessions().filter(s=>s.agent_id===id).map(s=>s.generation))+1,provider_id:null,created_at:this.rt.isoNow(),last_input_at:this.rt.isoNow(),last_input_tokens:0,last_input_tokens_known:false,turns:0,input_tokens:0,cached_input_tokens:0,counted_cached_tokens:{},renewals:old.renewals+1,bytes:0,rules_hash:'',renewing:false,renew_error:false,closed:false};
    if(old.closed && old.work_item_id)this.db.prepare('UPDATE work_items SET close_requested=0 WHERE id=?').run(old.work_item_id);
    this.saveSession(s);
    this.rt.office.event(id,'session_reset',this.rt.office.t("Konuşma yenilendi; hafıza ve çalışma defteri korundu."));
    return s;
  }
  renew(id: string, selected = this.session(id), closing = false) {
    if(this.rt.office.agent(id).session_mode==='single')throw new Problem(409,this.rt.office.t("Tek seferlik ajan için oturum yenilemesi kullanılmaz."));
    if (selected.renewing || selected.closed) return;
    const active=this.db.prepare("SELECT 1 FROM runs WHERE agent_id=? AND session_generation=? AND state IN ('running','waiting')").get(id,selected.generation);
    if(this.rt.office.agent(id).builtin==='director') {
      if(this.db.prepare("SELECT 1 FROM runs WHERE agent_id=? AND session_generation=? AND state='running'").get(id,selected.generation))throw new Problem(409,this.rt.office.t("Önce çalışan Genel Müdür turunu durdurun veya bitmesini bekleyin."));
      this.rotate(id,selected);this.rt.office.changed();return;
    }
    // Skip a model summary only when the last executed turn ended with a verified
    // work note, and no later tool changed/read state after that note.
    const last=this.db.prepare('SELECT id,state FROM runs WHERE agent_id=? AND session_generation=? AND started_at IS NOT NULL ORDER BY rowid DESC LIMIT 1').get(id,selected.generation);
    const item=selected.work_item_id ? this.db.prepare('SELECT note FROM work_items WHERE id=?').get(selected.work_item_id) : undefined;
    const note=last ? Number(this.db.prepare("SELECT MAX(id) AS n FROM run_logs WHERE run_id=? AND kind='tool_success' AND text LIKE 'is_notu_yaz:%'").get(last.id)?.n || 0) : 0;
    const later=last ? Number(this.db.prepare("SELECT MAX(id) AS n FROM run_logs WHERE run_id=? AND ((kind='tool_success' AND text NOT LIKE 'hafiza_yaz:%') OR kind='work_close_requested')").get(last.id)?.n || 0) : 0;
    if(!active && last?.state==='completed' && item?.note && note && note>=later) {
      if(closing){selected.closed=true;this.saveSession(selected);}else this.rotate(id,selected);
      this.rt.office.event(id,'session_summary_skipped',this.rt.office.t("Güncel iş notu bulundu; özet için ek model çalışması açılmadı."));this.rt.office.changed();return;
    }
    const r = this.rt.enqueue(id,closing ? this.rt.office.t("İş oturumu kapanış hazırlığı") : this.rt.office.t("Oturum yenileme hazırlığı"),closing ? this.rt.office.t("İş oturumu kapanacak. is_notu_yaz ile doğrulanmış son durumu, yapılanları ve kalanları kaydet. Ardından kısa cevap ver.") : this.rt.office.t("Konuşmayı yenilemeden önce hafiza_yaz ve is_notu_yaz ile doğrulanmış kısa özeti kaydet; Tududi bilgi notlarını yalnız gerekiyorsa güncelle. Ardından yenileme hazır olduğunu bildir."));
    if (!r) throw new Problem(409,this.rt.office.t("Oturum özeti başlatılamadı."));
    this.db.prepare('UPDATE runs SET session_action=?,priority=2,work_item_id=? WHERE id=?').run(closing?'close':'renew',selected.work_item_id || null,r.id);
    selected.renewing=true;selected.renew_error=false;this.saveSession(selected);this.rt.office.changed();
  }
  recordSession(run: Run, providerId: string, bytes: number) {
    const generation=this.db.prepare('SELECT session_generation FROM runs WHERE id=?').get(run.id)?.session_generation;
    const s=this.sessions().find(s=>s.agent_id===run.agent_id && s.generation===generation);
    if(!s || s.closed || s.runner!==this.rt.office.agent(run.agent_id).runner)throw new Problem(409,this.rt.office.t("Oturum değişti."));
    if(s.provider_id && s.provider_id!==providerId)throw new Problem(409,this.rt.office.t("Sağlayıcı farklı bir oturum döndürdü."));
    s.provider_id=providerId;s.bytes=Math.max(s.bytes,bytes);this.saveSession(s);
  }
  requestClose(run: Run) {
    const work=this.workId(run);
    if(work) {this.db.prepare('UPDATE work_items SET close_requested=1 WHERE id=?').run(work);this.rt.log(run.id,'work_close_requested',this.rt.office.t("İşin son notu kaydedildikten sonra oturum kapanacak."));}
  }
  expire() {
    for(const s of this.sessions()) {
      if(this.rt.office.agent(s.agent_id).session_mode!=='work' || s.closed || s.renewing || s.renew_error || !s.provider_id)continue;
      const active=this.db.prepare("SELECT 1 FROM runs WHERE agent_id=? AND state IN ('running','queued','waiting') AND work_item_id=?").get(s.agent_id,s.work_item_id || '');
      if(!active && this.rt.clock()-Date.parse(s.last_input_at || s.created_at)>=86400000) {
        try { this.renew(s.agent_id,s,true); } catch { /* Retry when the daily limit permits. */ }
      }
    }
  }
  finished(run: Run, state: string) {
    if(state==='failed' && this.pauses().some(p=>p.provider===this.rt.office.agent(run.agent_id).runner))return;
    const row=this.db.prepare('SELECT session_generation,session_action,prompt_rules_hash,session_counted_tokens FROM runs WHERE id=?').get(run.id)!;
    const s=this.sessions().find(s=>s.agent_id===run.agent_id && s.generation===row.session_generation);
    if(!s)return;
    if(!row.session_counted_tokens)s.turns++;
    const usage=usageTotals(this.rt.run(run.id).usage);
    s.input_tokens+=Math.max(0,usage.input_tokens-Number(row.session_counted_tokens));
    this.countCache(s,run.id,usage.cached_input_tokens);
    s.last_input_tokens=this.rt.run(run.id).usage.context_input_tokens || 0;
    s.last_input_tokens_known=typeof this.rt.run(run.id).usage.context_input_tokens==='number';
    this.db.prepare('UPDATE runs SET session_counted_tokens=? WHERE id=?').run(usage.input_tokens,run.id);
    if(state==='completed')s.rules_hash=String(row.prompt_rules_hash || '');
    const writes=this.db.prepare("SELECT text FROM run_logs WHERE run_id=? AND kind='tool_success'").all(run.id).map(r=>r.text as string);
    const work=s.work_item_id ? this.db.prepare('SELECT close_requested FROM work_items WHERE id=?').get(s.work_item_id) : undefined;
    if(row.session_action) {
      s.renewing=false;
      const ok=state==='completed' && writes.some(t=>t.startsWith('is_notu_yaz:')) && (row.session_action==='close' || writes.some(t=>t.startsWith('hafiza_yaz:')));
      if(ok) {
        if(row.session_action==='close') {s.closed=true;this.saveSession(s);}
        else this.rotate(run.agent_id,s);
      } else {s.renew_error=true;this.saveSession(s);this.rt.office.event(run.agent_id,'session_renew_failed',this.rt.office.t("Oturum özeti doğrulanamadı. Sahibi yeniden deneyebilir."));}
    } else {
      this.saveSession(s);
      if(!this.rt.terminal?.enabled && this.rt.office.agent(run.agent_id).builtin==='director' && Number(this.db.prepare('SELECT context_peak FROM runs WHERE id=?').get(run.id)?.context_peak || 0)>this.rt.director.settings().contextTokenLimit*2){this.rotate(run.agent_id,s);return;}
      if(work?.close_requested && this.rt.office.agent(run.agent_id).session_mode==='work') {
        const lastClose=Number(this.db.prepare("SELECT MAX(id) AS n FROM run_logs WHERE run_id=? AND kind='work_close_requested'").get(run.id)?.n || 0);
        const lastNote=Number(this.db.prepare("SELECT MAX(id) AS n FROM run_logs WHERE run_id=? AND kind='tool_success' AND text LIKE 'is_notu_yaz:%'").get(run.id)?.n || 0);
        if(lastNote>lastClose) {s.closed=true;this.saveSession(s);}
        else if(state==='completed')this.renew(run.agent_id,s,true);
      }
    }
  }
  private countCache(s:AgentSession,id:string,observed:number,previous=0){
    const counted=s.counted_cached_tokens?.[id] ?? previous;
    s.cached_input_tokens=(s.cached_input_tokens || 0)+Math.max(0,observed-counted);
    s.counted_cached_tokens ||= {};s.counted_cached_tokens[id]=Math.max(counted,observed);
  }
  lateUsage(run:Run,previous:Record<string,number>){
    const row=this.db.prepare('SELECT session_generation,session_counted_tokens FROM runs WHERE id=?').get(run.id)!;
    const s=this.sessions().find(s=>s.agent_id===run.agent_id && s.generation===row.session_generation);
    if(!s)return;
    const usage=usageTotals(this.rt.run(run.id).usage),before=usageTotals(previous);
    s.input_tokens+=Math.max(0,usage.input_tokens-Number(row.session_counted_tokens));
    this.countCache(s,run.id,usage.cached_input_tokens,before.cached_input_tokens);
    this.db.prepare('UPDATE runs SET session_counted_tokens=? WHERE id=?').run(usage.input_tokens,run.id);
    const last=this.db.prepare('SELECT id FROM runs WHERE agent_id=? AND session_generation=? AND started_at IS NOT NULL ORDER BY started_at DESC,rowid DESC LIMIT 1').get(run.agent_id,s.generation);
    if(last?.id===run.id && typeof run.usage.context_input_tokens==='number'){s.last_input_tokens=run.usage.context_input_tokens;s.last_input_tokens_known=true;}
    this.saveSession(s);
    if(last?.id===run.id && !this.rt.terminal?.enabled && this.rt.office.agent(run.agent_id).builtin==='director' && Number(this.db.prepare('SELECT context_peak FROM runs WHERE id=?').get(run.id)?.context_peak || 0)>this.rt.director.settings().contextTokenLimit*2)this.rotate(run.agent_id,s);
  }
  prompt(run: Run, parts: Record<string, string>): { prompt: string; session?: AgentSession } {
    const a = this.rt.office.agent(run.agent_id);
    const cached = this.db.prepare('SELECT json FROM notebook_cache WHERE agent_id=?').get(a.id);
    const data = cached ? JSON.parse(cached.json as string) : { tasks: [], notes: [] };
    const headings = data.notes.filter((n: any) => !n.invalid).map((n: any) => ({ kimlik: n.uid, baslik: n.title, tarih: n.updated_at || null, eski_olabilir: n.stale, kilitli:n.locked, son_dogrulama:n.verified_at }));
    const invalid = data.notes.filter((n:any)=>n.invalid).map((n:any)=>n.title);
    const shared = this.db.prepare('SELECT id,title,updated_at,verified_at,locked,invalid FROM shared_notes').all();
    if (run.scheduled_task_id) {
      const task=this.rt.scheduler.task(run.scheduled_task_id),note=this.rt.scheduler.note(run.scheduled_task_id);
      const continuation=run.parent_run_id ? this.rt.office.t("Zamanlanmış görevin asıl talimatı: {0}\n{1}", [task.instruction, task.attention_only ? this.rt.office.t("Önemli bir şey yoksa yalnız SESSIZ yaz.") : '']) : '';
      return {prompt:Object.entries(parts).filter(([key])=>key!=='İş ve sohbet bağlamı').map(([,text])=>text).join('\n\n')+this.rt.office.t("\n{0}\nİş notu / son durum (veri): {1}\nBilgi notu başlıkları (veri): {2}\nYanlış işaretlenmiş notları kullanma: {3}\nOrtak defter başlıkları (veri): {4}\nNot içeriğini yalnız gerektiğinde tududi_not_oku ile getir. Her çalıştırma taze oturumdur; sonunda is_notu_yaz ile kısa son durum notunu güncelle.", [continuation, note, JSON.stringify(headings), JSON.stringify(invalid), JSON.stringify(shared)])};
    }
    if(a.builtin==='director'){
      const s=this.session(a.id,run);s.last_input_at=this.rt.isoNow();this.saveSession(s);
      const rules=hash(this.rt.office.store.fullPrompt(a.id));this.db.prepare('UPDATE runs SET session_generation=?,prompt_rules_hash=? WHERE id=?').run(s.generation,rules,run.id);
      return {prompt:parts['Şu anki istek']+'\n'+(!s.provider_id || s.rules_hash!==rules ? this.rt.office.store.fullPrompt(a.id)+'\n'+parts['Yetki ve onay sınırları'] : ''),session:s};
    }
    if (a.session_mode === 'single') return { prompt: Object.values(parts).join('\n\n') + this.rt.office.t("\nBilgi notu başlıkları (veri): {0}\nYanlış işaretlenmiş notları kullanma: {1}\nOrtak defter başlıkları (veri): {2}\nNot içeriğini yalnız gerektiğinde tududi_not_oku ile getir.", [JSON.stringify(headings), JSON.stringify(invalid), JSON.stringify(shared)]) };
    const s = this.session(a.id,run);
    s.last_input_at=this.rt.isoNow();s.work_item_id=this.workId(run);this.saveSession(s);
    const ruleHash = hash(this.rt.office.store.fullPrompt(a.id) + JSON.stringify(a.policy) + JSON.stringify(this.commands().filter(c => c.agent_ids.includes(a.id))) + JSON.stringify(this.rt.links().filter(l=>l.agent_ids.includes(a.id))) + JSON.stringify(this.rt.settings().approvalRules));
    this.db.prepare('UPDATE runs SET session_generation=?,prompt_rules_hash=? WHERE id=?').run(s.generation,ruleHash, run.id);
    const workbook = this.db.prepare('SELECT note,task_uid FROM work_items WHERE id=(SELECT work_item_id FROM runs WHERE id=?)').get(run.id);
    const initial = s.provider_id || a.session_mode === 'work' ? '' : this.rt.office.t("İlk oturum için hafıza: {0}\nSon sohbet özeti: {1}", [this.rt.memory(a.id), this.rt.office.store.messages().filter(m => (m.sender_agent_id === a.id || m.recipient_id === a.id) && m.id !== run.message_id && m.text !== run.summary).slice(-3).map(m => m.text.slice(0, 400)).join('\n')]);
    const rules = !s.provider_id || s.rules_hash !== ruleHash ? this.rt.office.t("Kurallar güncellendi\n{0}\n{1}\n{2}\n{3} Notlar kısa, tarihli ve doğrulanabilir olsun; eskimiş bilgiyi tarihiyle işaretle. Kanıtsız özet yazma; yalnız tekrar kullanılacak bilgiyi sakla. Önce dizin haritasını ve ilgili dosyayı oku; aynı dosyayı tekrar okuma. Büyük devirlerde dosya eki veya not referansı kullan. Eksik araç gerekiyorsa engel_bildir ve dur; aynı isteği tekrar etme.\nKomut bağlantıları: {4}", [this.rt.office.store.fullPrompt(a.id), parts['Yetki ve onay sınırları'], parts['Araç kullanım notları'], a.builtin==='director' ? this.rt.office.t("Açık işler veya kararlar değişirse yonetim_defteri yaz. Selam ve bilgi sorusunda yazma; otomatik takipte zorunludur.") : this.rt.office.t("Her işin sonunda is_notu_yaz ile en çok 1500 karakterlik amaç, yapılan, sıradaki adım ve dosya adlarını kaydet."), JSON.stringify(this.commands().filter(c => c.agent_ids.includes(a.id)).map(c => c.name))]) : '';
    const evidence = this.db.prepare("SELECT kind,text FROM run_logs WHERE run_id IN (SELECT id FROM runs WHERE chain_id=?) AND kind IN ('git_change','command_result','acceptance_result') ORDER BY id DESC LIMIT 6").all(run.chain_id);
    const prompt = this.rt.office.t("{0}\n{1}\n{2}\n{3}\nİş notu (veri): {4}\nİş kimliği: {5}\nBilgi notu başlıkları (veri): {6}\nYanlış işaretlenmiş notları kullanma: {7}\nOrtak defter başlıkları (veri): {8}\nSon durum (veri): {9}\nKayıtlı dosya ve komut kanıtı (veri): {10}\nTur sınırı: {11}; zincir: {12}. İçeriği yalnız gerektiğinde tududi_not_oku ile getir; geçmiş gerekiyorsa sohbet_gecmisi kullan.", [parts['Şu anki istek'], parts['Önceki çalışma'] || '', rules, initial, String(workbook?.note || ''), String(workbook?.task_uid || this.rt.office.t("hazırlanıyor")), JSON.stringify(headings), JSON.stringify(invalid), JSON.stringify(shared), JSON.stringify(data.tasks.slice(0,12).map((t:any)=>t.uid===workbook?.task_uid ? t : {uid:t.uid,durum:t.status,vade:t.due_date,proje:t.project_uid})), JSON.stringify(evidence).slice(0,5000), a.policy?.maxCalls, run.chain_id]);
    return { prompt:prompt+this.rt.office.t("\nGörev listesindeki açıklamalar kısaltılmıştır. Bir Tududi görevi üzerinde çalışırken uzun isteği tududi_gorev_oku ile seçerek oku."), session: s };
  }
  pauses(): ProviderPause[] {
    for (const r of this.db.prepare('SELECT provider,json FROM provider_pauses').all()) {
      const p = JSON.parse(r.json as string) as ProviderPause;
      if (p.until !== null && p.until <= this.rt.clock()) this.resume(p.provider);
    }
    return this.db.prepare('SELECT json FROM provider_pauses').all().map(r => JSON.parse(r.json as string));
  }
  pause(provider: ProviderPause['provider'], reason: string, until: number | null) {
    const p = { provider, reason: this.rt.publicText(reason), until };
    this.db.prepare('INSERT INTO provider_pauses VALUES (?,?) ON CONFLICT(provider) DO UPDATE SET json=excluded.json').run(provider, JSON.stringify(p));
    this.rt.notice(null, this.rt.office.t("{0} kotası doldu. {1}", [provider === 'codex' ? 'Codex' : 'Claude', until ? new Date(until).toISOString() + this.rt.office.t(" sonrasında sürdürülecek.") : this.rt.office.t("Açılma saati bilinmiyor; sahibi sürdürebilir.")]));
    this.rt.office.event(null,'provider_pause',`${provider}: ${p.reason}`);
    this.rt.office.changed();
  }
  resume(provider: string) { const exists=!!this.db.prepare('SELECT 1 FROM provider_pauses WHERE provider=?').get(provider);this.db.prepare('DELETE FROM provider_pauses WHERE provider=?').run(provider);if(exists)this.rt.office.event(null,'provider_resume',this.rt.office.t("{0} sağlayıcısı sürdürüldü.", [provider])); this.rt.office.changed(); }
  blocker(run: Run, reason: string) {
    this.rt.office.event(run.agent_id,'agent_blocker',reason,{run_id:run.id});
    const normalized = reason.normalize('NFKC').toLocaleLowerCase('tr-TR').trim().replace(/\s+/g, ' ').slice(0, 400);
    this.db.prepare('INSERT INTO blockers VALUES (?,?,1) ON CONFLICT(chain_id,reason) DO UPDATE SET count=count+1').run(run.chain_id, normalized);
    if (Number(this.db.prepare('SELECT count FROM blockers WHERE chain_id=? AND reason=?').get(run.chain_id, normalized)!.count) >= 2) this.rt.stopChain(run.chain_id, this.rt.office.t("Ajanların yapamadığı bir şey gerekiyor: {0}", [this.rt.publicText(reason)]));
  }
  commands(): CommandLink[] { return this.db.prepare('SELECT json FROM command_links').all().map(r => JSON.parse(r.json as string)); }
  jobs(): CommandJob[] { return this.db.prepare('SELECT json FROM command_jobs').all().map(r => JSON.parse(r.json as string)); }
  saveJob(j: CommandJob) { this.db.prepare('INSERT INTO command_jobs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(j.id, j.run_id, JSON.stringify(j)); this.rt.office.changed(); }
  cancelJobs(runId?:string) {
    for(const j of this.jobs())if(j.state!=='completed' && (runId ? j.run_id===runId : this.rt.run(j.run_id).state!=='running')) {
      j.state='completed';j.exit_code=null;j.output=this.rt.office.t("Çalışma durdu; komut işi iptal edildi.");this.saveJob(j);this.rt.log(j.run_id,'command_result',JSON.stringify({ad:j.command.name,cikis:null,cikti:j.output}));
    }
  }
  requestCommand(run: Run, name: string) {
    const command = this.commands().find(c => c.name === name && c.agent_ids.includes(run.agent_id));
    if (!command) throw new Problem(403, this.rt.office.t("Bu komutu çalıştırma yetkiniz yok."));
    const folder = this.rt.links().find(l => l.id === command.folder_id && l.validation === 'valid');
    if (!folder || !folder.agent_ids.includes(run.agent_id) || (command.write && (folder.access !== 'write' || folder.approved_write))) throw new Problem(403, this.rt.office.t("Komut klasörü veya yazma yetkisi geçersiz."));
    if (command.approval) {
      const approved = this.rt.approvals().find(a => a.agent_id === run.agent_id && a.type === `command:${command.id}:${hash(JSON.stringify(command))}` && a.state === 'approved');
      if (!approved) {
        const a: Approval = { id: randomUUID(), agent_id: run.agent_id, run_id: run.id, title: this.rt.office.t("{0} komutunu çalıştır", [command.name]), detail: command.command, type: `command:${command.id}:${hash(JSON.stringify(command))}`, state: 'pending', note: '', created_at: this.rt.isoNow(), decided_at: null, link_id: null, files: [] };
        this.rt.saveApproval(a); this.rt.finish(run.id, 'waiting', '', this.rt.office.t("Komut için sahibin onayı bekleniyor.")); return { onay: a.id };
      }
      approved.state = 'applied'; this.rt.saveApproval(approved);
    }
    const j: CommandJob = { id: randomUUID(), run_id: run.id, agent_id: run.agent_id, command, folder, state: 'pending', exit_code: null, output: '' };
    this.saveJob(j); return { komut_is: j.id };
  }
  readyCard(run: Run, decision: string) {
    if (!/^[\s*_#>`-]*KABUL\b/i.test(decision)) throw new Problem(400,this.rt.office.t("Yayına hazır kartı için inceleme kararı KABUL ile başlamalı."));
    const existing=this.rt.approvals().find(a=>a.run_id===run.id && a.type==='release_ready');
    if(existing)return existing;
    const logs = this.db.prepare("SELECT kind,text FROM run_logs WHERE run_id IN (SELECT id FROM runs WHERE chain_id=?) AND kind IN ('command_result','git_change','acceptance_result') ORDER BY id").all(run.chain_id);
    if (!logs.length) throw new Problem(409, this.rt.office.t("Yayına hazır kararı için kayıtlı komut veya fark kanıtı gerekiyor."));
    const a: Approval = { id: randomUUID(), agent_id: run.agent_id, run_id: run.id, title: this.rt.office.t("Yayına hazır"), detail: `${decision}\n${JSON.stringify(logs)}`, type: 'release_ready', state: 'pending', note: '', created_at: this.rt.isoNow(), decided_at: null, link_id: null, files: [] };
    this.rt.saveApproval(a); this.rt.office.changed(); return a;
  }
  summary(day: string) {
    const start=dayStart(day,this.rt.settings().timeZone).toISOString(), end=dayStart(previousDay(day,-1),this.rt.settings().timeZone).toISOString();
    const runs = this.db.prepare('SELECT id FROM runs WHERE COALESCE(started_at,created_at)>=? AND COALESCE(started_at,created_at)<?').all(start,end).map(r => this.rt.run(r.id as string));
    const text = [this.rt.office.t("{0} günlük özet", [day]), ...this.rt.office.store.agents().map(a => { const rr = runs.filter(r => r.agent_id === a.id); return this.rt.office.t("{0}: {1} bitti, {2} başarısız, {3} bütçede kesildi, {4} bekleyen; {5} girdi token (önbellekli {6}, önbelleksiz {7}); {8} saniye.", [a.name, rr.filter(r => r.state === 'completed').length, rr.filter(r => ['failed','stopped','interrupted'].includes(r.state)).length, rr.filter(r=>r.state==='budget_exceeded').length, rr.filter(r => ['queued','waiting','running'].includes(r.state)).length, rr.reduce((n,r) => n + usageTotals(r.usage).input_tokens,0), rr.reduce((n,r)=>n+usageTotals(r.usage).cached_input_tokens,0), rr.reduce((n,r)=>n+usageTotals(r.usage).uncached_input_tokens,0), Math.round(rr.reduce((n,r) => n + r.duration_ms,0)/1000)]); }), this.rt.office.t("Zamanlanmış çalışmalar:"), ...this.rt.scheduler.tasks().map(t=>{const hh=this.rt.scheduler.history(t.id,10000).filter(h=>h.created_at>=start && h.created_at<end);return this.rt.office.t("{0}: {1} tamamlandı, {2} sessiz, {3} başarısız, {4} atlandı/kaçırıldı.", [t.name, hh.filter(h=>h.state==='completed').length, hh.filter(h=>h.state==='silent').length, hh.filter(h=>h.state==='failed').length, hh.filter(h=>['skipped','missed'].includes(h.state)).length]);}), this.rt.office.t("Bekleyen onaylar: {0}", [this.rt.approvals().filter(a => a.state === 'pending').length]), this.rt.office.t("Durdurulan zincirler: {0}", [this.db.prepare('SELECT COUNT(*) AS n FROM chains WHERE stopped_at>=? AND stopped_at<?').get(start,end)!.n]), this.rt.office.t("En pahalı üç iş:"), ...runs.sort((a,b) => usageTotals(b.usage).input_tokens - usageTotals(a.usage).input_tokens).slice(0,3).map(r => `${r.summary.slice(0,120)}: ${usageTotals(r.usage).input_tokens} girdi token`) ].join('\n');
    const result = { day, text, created_at: this.rt.isoNow() };
    this.db.prepare('INSERT INTO daily_summaries(day,json) VALUES (?,?) ON CONFLICT(day) DO UPDATE SET json=excluded.json,published=0').run(day, JSON.stringify(result)); this.rt.office.changed(); return result;
  }
}
