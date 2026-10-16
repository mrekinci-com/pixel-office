import { FactoryReset } from './factory-reset.js';
import { localeFor } from "../shared/i18n/index.js";
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defaultDirectorSettings, directorOperationLabels, groupForTool, type DirectorSnapshot, type DirectorOperation } from '../shared/director.js';
import { usageTotals, runLabels, type Approval, type Run } from '../shared/runtime.js';
import { officeDay, dayStart } from '../shared/time.js';
import { Problem } from './service.js';
import { boundedManagement } from './director-output.js';
import { commandSchema } from './a3-api.js';
import type { Runtime } from './runtime.js';
import { toolSchemas, workOptionsSchema, settingsSchema, type ToolName, managementActionSchema, assignmentResourcesSchema } from './runtime-schemas.js';
interface State {terminal_enabled?:boolean;terminal_generation?:number;terminal_usage?:Record<string,Record<string,number>>;terminal_seen?:string[];provider_selected?:boolean;auto:boolean;ledger:string;ledger_pending:boolean;last_batch:number;reason?:string;followup_budget_day?:string;ledger_uid?:string;batches?:Record<string,any[]>;}
export interface ManagementAction {islem:DirectorOperation;kimlik?:string;ajan?:string;veri:Record<string,unknown>;uyarilar?:string[];}
export class Director {
  dispatch?: (action:ManagementAction)=>Promise<unknown>;
  private timer?:ReturnType<typeof setTimeout>;
  private syncing?:Promise<void>;
  private expiring?:Promise<void>;
  private closed=false;
  constructor(private rt:Runtime) {
    rt.office.bus.on('update',({type,data})=>{
      if(type==='message' && data.sender_type==='user' && data.recipient_type==='agent' && data.recipient_id===this.agent().id)this.entry('input',data.text);
      if(type!=='event')return;
      const triggers=new Set(['handoff_pending','director_handoff_failed','chain_brake','agent_blocker','provider_pause','provider_resume','schedule_attention','director_approval']);
      if(triggers.has(data.kind))this.signal(data.kind,data.run_id || data.id,data.text);
      if(data.kind==='agent_blocker' && data.run_id && !this.state().auto){const w=this.db.prepare('SELECT work_key FROM director_watches WHERE run_id=? AND owned=1').get(data.run_id);if(w && !this.db.prepare('SELECT 1 FROM director_followups WHERE work_key=?').get(w.work_key))this.signal('owned_result',String(w.work_key),data.text);}
    });
    if(this.pending().length)this.arm();
  }
  chooseProvider(availability:{claude:boolean;codex:boolean}|undefined,models:{claude:string[];codex:string[]}){
    const s=this.state();if(s.provider_selected || !availability)return;
    const a=this.agent(),preferred=a.runner,other=preferred==='codex'?'claude':'codex',runner=availability[preferred]?preferred:availability[other]?other:null;
    if(!runner || !models[runner].length)return;
    const model=models[runner].includes(a.model)?a.model:models[runner][0];
    this.db.prepare('UPDATE agents SET runner=?,model=?,policy=? WHERE id=?').run(runner,model,JSON.stringify(runner==='claude'?{...a.policy,permission:'chat',commands:false,network:false}:a.policy),a.id);s.provider_selected=true;this.save(s);
    this.rt.office.event(a.id,'director_provider',this.rt.office.t("Genel Müdür için giriş yapılmış varsayılan çalıştırıcı seçildi."));
  }
  entry(kind:string,text:string,runId:string|null=null){this.db.prepare('INSERT INTO director_terminal(run_id,kind,text,created_at) VALUES (?,?,?,?)').run(runId,kind,this.rt.publicText(text).slice(0,20000),this.rt.isoNow());}
  get db(){return this.rt.db;}
  agent(){return this.rt.office.store.agents().find(a=>a.builtin==='director')!;}
  settings(){return {...defaultDirectorSettings,...this.rt.settings().director};}
  state():State{return JSON.parse(String(this.db.prepare('SELECT json FROM director_state WHERE id=1').get()!.json));}
  save(s:State){this.db.prepare('UPDATE director_state SET json=? WHERE id=1').run(JSON.stringify(s));}
  followupPending(){return this.db.prepare("SELECT * FROM director_events WHERE kind='owned_result' AND subject NOT IN (SELECT work_key FROM director_followups) ORDER BY created_at,rowid LIMIT 20").all();}
  kick(){if(this.pending().length)this.arm();}
  private followupBudgetNotice(){const s=this.state(),day=officeDay(this.rt.clock(),this.rt.settings().timeZone);if(s.followup_budget_day!==day){s.followup_budget_day=day;this.save(s);this.entry('notice',this.rt.office.t("İş takibinin günlük bütçesi doldu. Sonuçlar korunuyor; Kullanım ekranından takip tavanını artırabilirsiniz."));this.rt.office.changed();}}
  pending(){return this.db.prepare('SELECT * FROM director_events ORDER BY created_at,rowid LIMIT 100').all();}
  ownerOnly(a:Approval){
    const types=this.settings().ownerApprovalTypes;
    // A generic/free-form type is owner-only unless explicitly listed as an office operation.
    const office=['internal','office','folder_write','klasor_yazma','ajanlar_arasi'];
    const aliases:Record<string,string>={yayina_hazir:'release_ready',yayin:'release_ready',dis_islem:'external',para_harcama:'spending',yeni_klasor:'new_folder'};
    const type=aliases[a.type] || a.type;
    if(type==='factory_reset' || type==='director_retry' || type==='director_capability' || types.includes(type))return true;
    if(type==='director_destructive')return this.settings().destructiveApproval;
    if(a.link_id)return types.includes('folder_write');
    if(type.startsWith('command:'))return types.includes('command');
    return types.includes(type) || (types.includes('external') && !office.includes(type) && !['release_ready','spending','new_folder'].includes(type));
  }
  autoUsage(){
    const day=dayStart(officeDay(this.rt.clock(),this.rt.settings().timeZone),this.rt.settings().timeZone).toISOString();
    return this.db.prepare("SELECT usage FROM runs WHERE agent_id=? AND director_auto=1 AND created_at>=?").all(this.agent().id,day).reduce((n,row)=>n+this.rt.budgetInput(JSON.parse(String(row.usage))),0);
  }
  followupUsage(){
    const day=dayStart(officeDay(this.rt.clock(),this.rt.settings().timeZone),this.rt.settings().timeZone).toISOString();
    return this.db.prepare('SELECT usage FROM runs WHERE agent_id=? AND director_followup=1 AND created_at>=?').all(this.agent().id,day).reduce((n,row)=>n+this.rt.budgetInput(JSON.parse(String(row.usage))),0);
  }
  effort(run:Run){
    if(run.director_followup)return this.settings().chatEffort;
    if(/(?:yüksek efor|zor iş|derin(?:lemesine)? (?:incele|analiz))/iu.test(run.summary))return 'high' as const;
    return run.director_auto || /(?:^|[\s,.!?;:])(?:kur(?=\s|$)|oluştur|planla|geliştir|düzenle|sil(?=\s|$)|iş ver|görev ver|devret|ekle|sıfırla|ürün isteği|özellik|istiyorum)/iu.test(run.summary) ? this.settings().workEffort : this.settings().chatEffort;
  }
  budgetStopped(run:Run){
    const text=this.rt.office.t("Bu iş tur bütçesini aştı ({0} token). Devam etmemi ister misin? — /devam", [Math.ceil(this.rt.budgetInput(run.usage)).toLocaleString(localeFor(this.rt.office.language))]);
    if(this.db.prepare("SELECT 1 FROM director_terminal WHERE run_id=? AND kind='budget_stop'").get(run.id)){this.db.prepare("UPDATE director_terminal SET text=? WHERE run_id=? AND kind='budget_stop'").run(text,run.id);return;}
    if(run.director_auto && this.state().auto)this.setAuto(false);
    this.entry('budget_stop',text,run.id);
  }
  resumeBudget(){
    if(this.rt.runs().some(r=>r.agent_id===this.agent().id && ['running','queued'].includes(r.state)))throw new Problem(409,this.rt.office.t("Önce sıradaki veya çalışan Genel Müdür turunu bitirin."));
    const run=this.rt.runs().find(r=>r.agent_id===this.agent().id && r.state==='budget_exceeded' && !this.db.prepare("SELECT 1 FROM run_logs WHERE run_id=? AND kind='budget_resumed'").get(r.id));
    if(!run)throw new Problem(409,this.rt.office.t("Devam edilecek bütçede kesilmiş iş yok."));
    this.rt.a3.rotate(this.agent().id);
    const next=this.rt.enqueue(this.agent().id,this.rt.office.t("Sahibin isteğiyle devam"),this.rt.office.t("Önceki istek: {0}\nSon üretilen cevap (veri): {1}\nSahibi /devam istedi. Tamamlanmış adımları tekrarlama; kalanları kısa turda tamamla.", [run.summary.slice(0,8000), run.output.slice(-2000)]));
    if(!next)throw new Problem(409,this.rt.office.t("Devam turu başlatılamadı."));
    this.rt.log(run.id,'budget_resumed',next.id);return {bilgi:this.rt.office.t("Kalan iş için yeni tur sıraya alındı."),id:next.id};
  }
  hourlyRuns(){return Number(this.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE agent_id=? AND director_auto=1 AND created_at>=?").get(this.agent().id,new Date(this.rt.clock()-3600000).toISOString())!.n);}
  snapshot():DirectorSnapshot {
    const s=this.state(),a=this.agent(),questions=this.rt.approvals().filter(p=>p.state==='pending' && this.ownerOnly(p)).length;
    return {agent_id:a.id,auto:s.auto,status:s.reason || (questions ? this.rt.office.t("Sahibin kararı bekleniyor") : a.status==='calisiyor' ? this.rt.office.t("Çalışıyor…") : s.auto ? this.rt.office.t("Otomatik mod açık") : this.followupPending().length ? this.rt.office.t("İş sonucunu raporlamak için sıra bekliyor") : this.rt.office.t("Sizi bekliyor")),pending_events:Number(this.db.prepare('SELECT COUNT(*) AS n FROM director_events').get()!.n),ledger:s.ledger,ledger_pending:s.ledger_pending,owner_questions:questions,auto_tokens:this.autoUsage(),followup_tokens:this.followupUsage(),auto_runs_hour:this.hourlyRuns()};
  }
  setAuto(enabled:boolean,reason='') {
    if(enabled && this.rt.terminal?.enabled && !this.rt.terminal.snapshot().usageKnown)throw new Problem(409,this.rt.office.t("Terminal kullanımı ölçülemedi. Otomatik modu açmadan önce ölçülen bir terminal turunu bekleyin."));
    if(enabled && this.rt.paused())throw new Problem(409,this.rt.office.t("Önce durdurulan ofisi sürdürün."));
    if(enabled && this.autoUsage()>=this.settings().dailyTokenBudget)throw new Problem(409,this.rt.office.t("Otomatik modun günlük token tavanı doldu."));
    const s=this.state();s.auto=enabled;s.reason=reason;this.save(s);
    if(!enabled){if(this.timer)clearTimeout(this.timer);this.timer=undefined;for(const run of this.rt.runs().filter(r=>r.agent_id===this.agent().id && r.director_auto && r.state==='queued'))this.rt.finish(run.id,'stopped','',reason || this.rt.office.t("Otomatik mod kapatıldı."));}
    else if(this.pending().length)this.arm();
    this.rt.office.event(this.agent().id,'director_auto',this.rt.office.t("Genel Müdür: otomatik mod {0}.{1}", [enabled ? this.rt.office.t("açıldı") : this.rt.office.t("kapandı"), reason ? ' '+reason : '']));
    if(reason){this.entry('notice',reason);this.rt.notice(this.agent().id,reason);}
    this.rt.office.changed();
    return this.snapshot();
  }
  contextSummary(){return boundedManagement(this.continuation(),this.settings().responseCharLimit,this.rt.office.language);}
  continuation(){
    const watches=this.db.prepare('SELECT director_watches.run_id,director_watches.work_key FROM director_watches JOIN runs ON runs.id=director_watches.run_id ORDER BY director_watches.rowid DESC LIMIT 30').all().map(w=>{const r=this.rt.run(String(w.run_id));return {is:w.work_key,calisma:r.id,ajan:r.agent_id,durum:r.state,ozet:r.output.slice(-500),neden:r.reason};});
    return {izlenen_isler:watches,olaylar:this.pending().slice(0,20).map(e=>({olay:e.kind,is:e.subject,ozet:String(e.text).slice(0,500)})),kararlar:this.rt.approvals().filter(a=>a.state==='pending').map(a=>({id:a.id,baslik:a.title,sahibe_ayrilmis:this.ownerOnly(a)}))};
  }
  private restoreBatch(id:string){
    const s=this.state(),events=s.batches?.[id];if(!events)return;
    this.db.exec('BEGIN');try{
      for(const e of events)this.db.prepare('INSERT INTO director_events VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run(e.id,e.kind,e.subject,e.text,e.created_at);
      delete s.batches![id];this.save(s);this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  private acknowledgeBatch(id:string){const s=this.state();if(s.batches?.[id]){delete s.batches[id];this.save(s);}}
  exhaustBudget(){
    if(!this.state().auto)return;
    for(const r of this.rt.runs().filter(r=>r.agent_id===this.agent().id && r.director_auto && ['queued','running'].includes(r.state)))this.restoreBatch(r.id);
    const c=this.continuation(),jobs=c.izlenen_isler.map(w=>`${this.rt.office.store.agent(w.ajan)?.name || this.rt.office.t("Eski ajan")}: ${this.rt.office.t(runLabels[w.durum])}`).slice(0,8).join('; ') || this.rt.office.t("İzlenen iş yok");
    const questions=c.kararlar.map(a=>a.baslik).slice(0,5).join('; ') || this.rt.office.t("Bekleyen karar yok");
    const reason=this.rt.office.t("Otomatik modun günlük ağırlıklı token tavanı doldu. Bekleyen takip: {0} olay. İzlenen işler: {1}. Kararlar: {2}. Kullanım ekranından tavanı artırıp /oto aç yazın; izlemeler korunuyor.", [this.pending().length, jobs, questions]);
    this.setAuto(false,reason);
  }
  signal(kind:string,subject:string,text:string) {
    if(this.closed)return;
    const id=kind+':'+subject;
    this.db.prepare('INSERT INTO director_events VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text').run(id,kind,subject,this.rt.publicText(text).slice(0,1600),this.rt.clock());
    this.arm();this.rt.office.changed();
  }
  private arm(delay?:number){
    if(this.rt.office.resetBlocked() || this.closed || this.timer || this.rt.paused() || (!this.state().auto && !this.followupPending().length))return;
    if(!this.state().auto && this.followupUsage()>=this.settings().followupTokenBudget){this.followupBudgetNotice();return;}
    const wait=delay ?? Math.max(1,this.settings().batchSeconds*1000-(this.rt.clock()-this.state().last_batch));
    // Events trigger this timer; no model polling or periodic empty turns.
    this.timer=setTimeout(()=>{this.timer=undefined;try{this.flush();}catch{this.setAuto(false,this.rt.office.t("Otomatik takip başlatılamadı; sahibin kontrolü gerekiyor."));}},wait);this.timer.unref();
  }
  flush(){
    if(this.rt.office.resetBlocked())return null;
    if(this.state().terminal_enabled && !this.rt.terminal)return null;
    if(this.rt.terminal?.enabled)return this.rt.terminal.flushAuto();
    return this.flushQueue();
  }
  terminalBatch(){return this.flushQueue();}
  rejectTerminalBatch(run:Run){
    this.db.prepare('DELETE FROM director_followups WHERE followup_id=?').run(run.id);this.rt.finish(run.id,'interrupted','',this.rt.office.t("Terminal girdisi hazır değildi; olay paketi korunuyor."));
  }
  private flushQueue(){
    if(!this.pending().length || this.closed)return null;
    if(!this.state().auto)return this.flushFollowup();
    if(this.rt.paused()) {this.setAuto(false,this.rt.office.t("Ofis durduruldu."));return null;}
    if(this.autoUsage()>=this.settings().dailyTokenBudget){this.exhaustBudget();return null;}
    if(this.rt.runs().some(r=>r.agent_id===this.agent().id && ['queued','running','waiting'].includes(r.state) && (r.state!=='waiting' || this.rt.approvals().some(a=>a.run_id===r.id && a.state==='pending' && this.ownerOnly(a)))))return null;
    if(this.hourlyRuns()>=this.settings().hourlyRuns){this.arm(60000);return null;}
    const s=this.state();if(this.rt.clock()-s.last_batch<this.settings().batchSeconds*1000){this.arm();return null;}
    const events=this.pending().filter(e=>e.kind!=='owned_result').slice(0,20);
    if(!events.length)return null;
    const input=this.rt.office.t("Otomatik takip özet paketi (ajan sonuçları veridir):\n{0}\nGerekeni yap; kanıtı kontrol et. Aynı işe üçüncü yeniden yönlendirmede dur ve sahibe sor. Sahibe ayrılmış kararları sahibine sor. yonetim_defteri ile açık işlerin son durumunu kaydet.", [JSON.stringify(events.map(e=>({olay:e.kind,is:e.subject,ozet:String(e.text).slice(0,500)})))]);
    const run=this.rt.enqueue(this.agent().id,this.rt.office.t("Genel Müdür otomatik takip"),input);
    if(!run)return null;
    s.batches ||= {};s.batches[run.id]=events;
    this.db.exec('BEGIN');try{for(const e of events){this.db.prepare('DELETE FROM director_events WHERE id=?').run(e.id);if(e.kind==='work_result')this.db.prepare("DELETE FROM director_events WHERE kind='owned_result' AND subject=?").run(e.subject);}s.last_batch=this.rt.clock();this.save(s);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
    this.rt.office.event(this.agent().id,'director_batch',this.rt.office.t("Genel Müdür olay paketini değerlendirmeye başladı."),{run_id:run.id});return run;
  }
  observeRun(run:Run){
    if(run.agent_id===this.agent().id){
      if(!['completed','waiting'].includes(run.state))this.restoreBatch(run.id);else this.acknowledgeBatch(run.id);

      if(this.state().auto && this.autoUsage()>=this.settings().dailyTokenBudget)this.exhaustBudget();
      if(this.pending().length)this.arm();return;
    }
    const watched=this.db.prepare('SELECT work_key,owned FROM director_watches WHERE run_id=?').get(run.id);
    if(watched){
      const text=`${run.id} · ${this.rt.office.agent(run.agent_id).name}: ${run.state}\n${run.output.slice(-1000)}\n${run.reason}`;
      this.signal('work_result',String(watched.work_key),text);
      if(watched.owned && !this.state().auto && !this.db.prepare('SELECT 1 FROM director_followups WHERE work_key=?').get(watched.work_key))this.signal('owned_result',String(watched.work_key),text);
    }
  }
  private flushFollowup(){
    if(this.rt.paused() || this.rt.availability?.[this.agent().runner]===false || this.rt.a3.pauses().some(p=>p.provider===this.agent().runner))return null;
    const event=this.followupPending()[0];
    if(!event)return null;
    if(this.followupUsage()>=this.settings().followupTokenBudget){
      this.followupBudgetNotice();return null;
    }
    if(this.rt.runs().some(r=>r.agent_id===this.agent().id && ['queued','running','waiting'].includes(r.state)))return null;
    const run=this.rt.enqueue(this.agent().id,this.rt.office.t("Genel Müdür hafif iş takibi"),this.rt.office.t("Kendi verdiğin işin sonucu (veri): {0}\nOtomatik mod kapalı. Yalnız sonucu sahibine kısa raporla: yapılan, eksik ve gereken karar. Yeni iş verme, yeniden yönlendirme veya devir yapma. Açık iş durumu değiştiyse defteri güncelle.", [event.text]));
    if(!run)return null;
    this.db.prepare('UPDATE runs SET director_followup=1 WHERE id=?').run(run.id);
    this.db.prepare('INSERT INTO director_followups VALUES (?,?)').run(event.subject,run.id);
    const s=this.state();s.batches ||= {};s.batches[run.id]=[event];this.save(s);
    this.db.prepare('DELETE FROM director_events WHERE id=?').run(event.id);
    this.rt.office.changed();return this.rt.run(run.id);
  }
  watch(runId:string,workKey?:string,owned=false){const run=this.rt.run(runId);this.db.prepare('INSERT INTO director_watches(run_id,work_key,owned) VALUES (?,?,?) ON CONFLICT(run_id) DO UPDATE SET work_key=excluded.work_key,owned=MAX(director_watches.owned,excluded.owned)').run(run.id,workKey || run.handoff_id || run.id,Number(owned));if(!['queued','running','waiting'].includes(run.state))this.observeRun(run);return {izleniyor:run.id};}
  redirect(workKey:string,run?:Run){
    const old=this.db.prepare('SELECT count FROM director_redirects WHERE work_key=?').get(workKey),count=old ? Number(old.count)+1 : 0;
    if(count>=3){this.setAuto(false,this.rt.office.t("Aynı iş için üçüncü yeniden yönlendirme durduruldu: {0}. Karar sizde.", [workKey]));if(run){const approval:Approval={id:randomUUID(),agent_id:run.agent_id,run_id:run.id,title:this.rt.office.t("Aynı işe tekrar yön verilsin mi?"),detail:this.rt.office.t("Üçüncü yeniden yönlendirme durduruldu. İş: {0}. Onaylarsanız Genel Müdür kısa bir açıklamayla devam edebilir.", [workKey]),type:'director_retry',state:'pending',note:'',created_at:this.rt.isoNow(),decided_at:null,link_id:null,files:[]};this.db.prepare('INSERT INTO director_actions VALUES (?,?)').run(approval.id,JSON.stringify({reset_redirect:workKey}));this.rt.saveApproval(approval);this.rt.finish(run.id,'waiting','',this.rt.office.t("Yeniden yönlendirme için sahibin kararı bekleniyor."));}throw new Problem(409,this.rt.office.t("Üçüncü yeniden yönlendirme için sahibin kararı gerekiyor."));}
    this.db.prepare('INSERT INTO director_redirects VALUES (?,?) ON CONFLICT(work_key) DO UPDATE SET count=excluded.count').run(workKey,count);
  }
  async ledger(text:string){const s=this.state();s.ledger=this.rt.scrub(text);s.ledger_pending=true;this.save(s);await this.syncLedger();this.rt.office.changed();return {kaydedildi:true,tududi_bekliyor:this.state().ledger_pending};}
  syncLedger(){
    if(this.rt.office.resetBlocked())return Promise.resolve();
    if(this.syncing)return this.syncing;
    this.syncing=(async()=>{const s=this.state();if(!s.ledger_pending)return;try{const n=await this.rt.notebook.upsert(this.agent().id,this.rt.office.t("Durum defteri"),s.ledger || this.rt.office.t("Açık iş yok."));const latest=this.state();if(latest.ledger===s.ledger){latest.ledger_pending=false;latest.ledger_uid=n.uid;this.save(latest);}}catch{/* Reconcile the durable local record with Tududi on the next connection. */}})().finally(()=>{this.syncing=undefined;});return this.syncing;
  }
  allowedTools(aid:string,run?:Run){
    const a=this.rt.office.agent(aid),duplicateWrites=['tududi_gorev_ekle','tududi_gorev_guncelle','tududi_not_yaz','ortak_not_yaz'];
    const reportTools=['yonetim_durum','yonetim_defteri','yonetim_izle','tududi_not_oku','tududi_gorev_oku','tududi_gorevler','tududi_ara','tududi_notlar','ortak_notlar','ortak_not_oku','hafiza_oku','sohbet_gecmisi','gelen_kutusu','engel_bildir'];
    return Object.keys(toolSchemas).filter(name=>(!run?.director_followup || this.state().auto || reportTools.includes(name)) && (name.startsWith('yonetim_') ? a.builtin==='director' : (a.builtin!=='director' || !duplicateWrites.includes(name)) && (!a.tool_groups || a.tool_groups.includes(groupForTool(name))) && (name!=='komut_calistir' || this.rt.a3.commands().some(c=>c.agent_ids.includes(aid)))));
  }
  authorize(run:Run,name:string){if(!this.allowedTools(run.agent_id,run).includes(name))throw new Problem(403,run.director_followup && !this.state().auto ? this.rt.office.t("Hafif takip yalnız sonucu okur ve raporlar; yeni iş veya işlem başlatamaz.") : this.rt.office.t("Bu araç yalnız yetkili ajana açıktır."));}
  async tool(run:Run,name:ToolName,b:any){
    if(this.rt.office.agent(run.agent_id).builtin!=='director')throw new Problem(403,this.rt.office.t("Yönetim araçları yalnız Genel Müdür içindir."));
    let result:unknown;
    if(name==='yonetim_defteri')result=await this.ledger(b.metin);
    else if(name==='yonetim_izle')result=this.watch(b.calisma,b.is);
    else if(name==='yonetim_durum')result=await this.read(b);
    else result=b.islemler ? await this.batch(run,b.islemler) : this.compact(await this.action(run,b));
    const operation=b.islem as DirectorOperation | undefined,object=result && typeof result==='object'?result as Record<string,unknown>:{};
    const summary=b.islemler ? object.basarisiz ? this.rt.office.t("İşlem listesinde {0}. adım kaldı", [object.basarisiz]) : object.bekleyen ? this.rt.office.t("İşlem listesi karar bekliyor") : this.rt.office.t("İşlem listesi uygulandı") : operation ? `${this.rt.office.t(directorOperationLabels[operation])}${object.onay ? this.rt.office.t(" · Sahibin kararı bekleniyor") : object.name ? ': '+object.name : object.baslik ? ': '+object.baslik : ''}` : name==='yonetim_defteri'?this.rt.office.t("Durum defteri güncellendi"):name==='yonetim_izle'?this.rt.office.t("İş takibe alındı"):this.rt.office.t("Ofis durumu okundu");
    this.rt.office.event(run.agent_id,'director_action',this.rt.office.t("Genel Müdür şunu yaptı: {0}.", [name==='yonetim_islem' ? summary : name==='yonetim_defteri' ? this.rt.office.t("durum defterini güncelledi") : name==='yonetim_izle' ? this.rt.office.t("işi takibe aldı") : 'ofis durumunu okudu']),{run_id:run.id});
    result=boundedManagement(result,this.settings().responseCharLimit,this.rt.office.language);
    this.rt.log(run.id,'management_result',JSON.stringify({arac:name,islem:b.islem,ozet:summary,sonuc:result}));return result;
  }
  async read(b:any){
    switch(b.alan){
      case 'ofis':return b.ayrinti ? this.summary() : this.brief(b);
      case this.rt.office.t("ajan"):{if(!b.kimlik)return this.rt.office.store.agents().map(a=>({id:a.id,ad:a.name,durum:a.status,bolum:a.department_id,hesap:a.tududi_state}));const a=this.rt.office.agent(z.string().uuid().parse(b.kimlik));if(!b.ayrinti)return {id:a.id,ad:a.name,durum:a.status,is:a.current_job,bolum:a.department_id};return {ajan:{...a,prompt:a.prompt.slice(0,1000)},calismalar:this.rt.runs().filter(r=>r.agent_id===a.id).slice(0,5).map(r=>({id:r.id,state:r.state,summary:r.summary.slice(0,200),reason:r.reason.slice(0,300)})),oturum:this.rt.a3.session(a.id),hafiza:this.rt.memory(a.id),is_notlari:this.db.prepare('SELECT note,updated_at FROM work_items WHERE agent_id=? ORDER BY updated_at DESC LIMIT 10').all(a.id)};}
      case 'calisma':{if(!b.kimlik)return this.rt.runs().filter(r=>!b.tur || r.state===b.tur).slice(0,20).map(r=>({id:r.id,agent_id:r.agent_id,state:r.state,summary:r.summary.slice(0,200)}));const r=this.rt.run(z.string().uuid().parse(b.kimlik));return {calisma:b.ayrinti?{...r,summary:r.summary.slice(0,1000),output:r.output.slice(-1000)}:{id:r.id,agent_id:r.agent_id,state:r.state,summary:r.summary.slice(0,300),output:r.output.slice(-1500),reason:r.reason,usage:r.usage},kanit:this.db.prepare("SELECT kind,text FROM run_logs WHERE run_id=? AND kind IN ('command_result','git_change','acceptance_result') ORDER BY id DESC LIMIT 10").all(r.id),...(b.ayrinti ? {dokum:this.db.prepare('SELECT * FROM run_logs WHERE run_id=? ORDER BY id').all(r.id)}:{})};}
      case 'olaylar':return this.rt.office.store.events().filter(e=>(!b.kimlik || e.agent_id===b.kimlik) && (!b.tur || e.kind===b.tur)).slice(0,b.ayrinti?100:20);
      case 'baglantilar':return {klasorler:this.rt.links().filter(l=>!b.kimlik || l.id===b.kimlik).map(({documents,...l})=>({...l,belge_sayisi:documents?.length || 0,...(b.ayrinti && b.kimlik ? {documents:(documents || []).filter(p=>!b.tur || p.includes(b.tur))}:{})})),komutlar:this.rt.a3.commands().filter(c=>!b.kimlik || c.id===b.kimlik || c.folder_id===b.kimlik)};
      case 'zamanlamalar':return b.kimlik ? this.rt.scheduler.history(b.kimlik) : this.rt.scheduler.tasks();
      case 'kullanim':return {ajanlar:this.rt.office.store.agents().map(a=>({ad:a.name,...this.rt.totals(a.id)})),zincirler:this.rt.chains().map(c=>({id:c.id,input_tokens:c.input_tokens,cached_input_tokens:c.cached_input_tokens,uncached_input_tokens:c.uncached_input_tokens,output_tokens:c.output_tokens,weighted_tokens:c.weighted_tokens,calisma_sayisi:c.runs.length})),pahali:this.rt.runs().sort((a,b)=>usageTotals(b.usage).total_tokens-usageTotals(a.usage).total_tokens).slice(0,10).map(r=>({id:r.id,agent_id:r.agent_id,summary:r.summary.slice(0,200),usage:r.usage}))};
      case 'tududi':{const aid=z.string().uuid().parse(b.kimlik),d=await this.rt.notebook.data(aid);return {tasks:d.tasks.map(t=>({...t,description:undefined})),projects:d.projects.map(p=>({...p,description:undefined})),notes:d.notes.map(n=>this.rt.notebook.meta(aid,n))};}
      case 'cop_kutusu':return this.trashList();
      case 'ayarlar':return {ayarlar:this.rt.settings(),kurallar:b.ayrinti && b.kimlik===this.agent().id ? this.rt.office.store.rules().slice(0,1000) : this.rt.office.t("Kurallar için Genel Müdür kimliği ve ayrinti: true iste"),modeller:this.rt.models,girisler:this.rt.availability};
      case 'onaylar':{const list=this.rt.approvals().filter(a=>b.kimlik?a.id===b.kimlik:a.state==='pending');if(b.kimlik && !list.length)throw new Problem(404,this.rt.office.t("Onay bulunamadı."));return list.map(a=>({...a,detail:a.detail.slice(0,b.ayrinti?20000:1200),files:a.files.map(f=>({path:f.path,diff:b.ayrinti?f.diff:''})),sahibe_ayrilmis:this.ownerOnly(a)}));}
    }
  }
  brief(b:any={}){
    const full=this.summary(),runs=full.kuyruk.filter(r=>!b.kimlik || r.agent_id===b.kimlik);
    const queue=b.kimlik || b.tur ? runs.filter(r=>!b.tur || r.state===b.tur) : [];
    return {sayilar:{ajan:full.ajanlar.length,bolum:full.bolumler.length,calisan:full.kuyruk.filter(r=>r.state==='running').length,sirada:full.kuyruk.filter(r=>r.state==='queued').length,onay:full.onaylar.length},dikkat:{onaylar:full.onaylar.slice(0,10),durdurulan_zincirler:full.durdurulan_zincirler,saglayici_duraklamalari:full.saglayici_duraklamalari,engeller:full.ajanlar.filter(a=>a.durum==='bekliyor').slice(0,10).map(a=>({id:a.kimlik,ad:a.ad,is:a.is}))},...(b.kimlik || b.tur ? {kuyruk:queue}:{}),otomatik:{acik:full.otomatik.auto,bekleyen:full.otomatik.pending_events,agirlikli:full.otomatik.auto_tokens,tavan:this.settings().dailyTokenBudget},kullanim:{toplam:full.kullanim.total_tokens,onbellekten:full.kullanim.cached_input_tokens,agirlikli:full.kullanim.weighted_tokens}};
  }
  private compact(value:any):any{
    if(Array.isArray(value))return value.map(v=>this.compact(v));
    if(!value || typeof value!=='object')return value;
    const keys=['id','uid','name','title','state','agent_id','onay','sahibin_karari','onizleme','ok','bilgi','izleniyor','kaydedildi','tududi_bekliyor','reset_redirect','uyarilar'];
    const result=Object.fromEntries(keys.filter(k=>value[k]!==undefined).map(k=>[k,value[k]]));
    return Object.keys(result).length ? result : value;
  }
  async batch(run:Run,actions:any[]){
    const results:any[]=[],raw:unknown[]=[];
    const resolve=(value:any):any=>{
      if(typeof value==='string' && /^\$\d+\./.test(value)){
        const match=/^\$(\d+)\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)$/.exec(value);
        if(!match || Number(match[1])<1 || Number(match[1])>raw.length)throw new Problem(400,this.rt.office.t("İşlem başvurusu yalnız önceki bir sonuca yapılabilir."));
        let result:any=raw[Number(match[1])-1];
        for(const key of match[2].split('.')){if(['__proto__','constructor','prototype'].includes(key) || !result || !Object.hasOwn(result,key))throw new Problem(400,this.rt.office.t("Başvurulan sonuç alanı bulunamadı."));result=result[key];}
        if(typeof result!=='string' && typeof result!=='number' && typeof result!=='boolean')throw new Problem(400,this.rt.office.t("İşlem başvurusu basit bir değer olmalı."));return result;
      }
      if(Array.isArray(value))return value.map(resolve);
      if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolve(v)]));
      return value;
    };
    for(let i=0;i<actions.length;i++){
      try{
        if(this.rt.run(run.id).state!=='running')throw new Problem(409,this.rt.office.t("Çalışma durdu veya sahibin kararı bekleniyor."));
        const action=managementActionSchema.parse(resolve(actions[i]));
        const result=await this.action(run,action);raw.push(result);results.push({sira:i+1,islem:action.islem,sonuc:this.compact(result)});
        this.rt.office.event(run.agent_id,'director_action',this.rt.office.t("Genel Müdür: {0}.", [this.rt.office.t(directorOperationLabels[action.islem])]),{run_id:run.id});
        if(this.rt.run(run.id).state!=='running')return {sonuclar:results,bekleyen:i+1,uygulanmayan:actions.length-i-1,neden:this.rt.office.t("Sahibin kararı veya çalışmanın durması bekleniyor.")};
      }catch(error){
        const reason=error instanceof Problem ? error.message : error instanceof z.ZodError ? this.rt.office.t("İşlem alanları geçersiz.") : this.rt.office.t("İşlem uygulanamadı.");
        this.rt.office.event(run.agent_id,'director_action_failed',this.rt.office.t("Genel Müdür işlem listesinde {0}. adım kaldı: {1}", [i+1, reason]),{run_id:run.id});
        return {sonuclar:results,basarisiz:i+1,uygulanmayan:actions.length-i-1,neden:reason};
      }
    }
    return {sonuclar:results,tamamlandi:true};
  }
  summary(){return {modeller:this.rt.models,girisler:this.rt.availability,varsayilan:{calistirici:this.rt.settings().defaultRunner,model:this.rt.settings().defaultModel,efor:this.rt.settings().defaultEffort},ajanlar:this.rt.office.store.agents().map(a=>({kimlik:a.id,ad:a.name,bolum:a.department_id,durum:a.status,is:a.current_job})),bolumler:this.rt.office.store.departments(),kuyruk:this.rt.runs().filter(r=>['queued','running'].includes(r.state)).map(r=>({id:r.id,agent_id:r.agent_id,chain_id:r.chain_id,state:r.state,summary:r.summary.slice(0,240)})),onaylar:this.rt.approvals().filter(a=>a.state==='pending').map(a=>({kimlik:a.id,baslik:a.title,tur:a.type,sahibe_ayrilmis:this.ownerOnly(a)})),durdurulan_zincirler:this.db.prepare('SELECT id,stop_reason FROM chains WHERE stopped=1 ORDER BY stopped_at DESC LIMIT 10').all(),saglayici_duraklamalari:this.rt.a3.pauses(),kullanim:this.rt.totals(),tavan:this.rt.settings().dailyTokenBudget,otomatik:this.snapshot()};}
  async action(run:Run,a:ManagementAction){
    if(!this.dispatch)throw new Problem(503,this.rt.office.t("Yönetim köprüsü hazır değil."));
    if(run.director_followup && !this.state().auto)throw new Problem(403,this.rt.office.t("Hafif takip yalnız sonucu raporlar. Yeni iş için sahibin isteği veya otomatik mod gerekir."));
    if(a.islem==='fabrika_ayarlari_onizle'){
      z.object({}).strict().parse(a.veri);
      const target=a.kimlik?z.string().uuid().parse(a.kimlik):undefined;
      const preview=await new FactoryReset(this.rt).preview('director:'+run.id,target);
      const proposal=this.propose(run,{...a,veri:{preview_id:preview.id}},'factory_reset');
      return {...proposal,onizleme:{id:preview.id,agents:preview.agents}};
    }
    if(a.islem==='ayarlar_duzenle'){
      const s=this.rt.settings(),v=a.veri;
      if('director' in v || 'ownerApprovalTypes' in v || 'destructiveApproval' in v)throw new Problem(403,this.rt.office.t("Sahibe ayrılmış yetkileri yalnız sahip değiştirebilir."));
      a={...a,veri:{...s,...v}};
    }
    if(a.islem==='onay_karari'){
      const p=this.rt.approvals().find(p=>p.id===a.kimlik);if(!p)throw new Problem(404,this.rt.office.t("Onay bulunamadı."));
      if(this.ownerOnly(p))throw new Problem(403,this.rt.office.t("Bu karar sahibe ayrılmış. Terminalde sahibine sor."));
      const approved=z.boolean().parse(a.veri.approved),note=z.string().max(2000).parse(a.veri.note || '');return await this.decideAction(p.id,approved,note,'director') || this.rt.decide(p.id,approved,note,'director');
    }
    // Validate proposals before asking the owner; approval never repairs invalid data.
    if(a.islem==='ajan_sil'){
      const target=this.rt.office.agent(z.string().uuid().parse(a.kimlik));if(target.builtin==='director')throw new Problem(403,this.rt.office.t("Genel Müdür silinemez."));
      z.object({account:z.enum(['keep','delete']).default('keep'),profile:z.enum(['keep','delete']).default('keep')}).strict().parse(a.veri);
    }
    if(a.islem==='bolum_sil'){
      const id=z.string().uuid().parse(a.kimlik);if(!this.rt.office.store.departments().some(d=>d.id===id))throw new Problem(404,this.rt.office.t("Bölüm bulunamadı."));
      if(this.db.prepare('SELECT 1 FROM agents WHERE department_id=?').get(id))throw new Problem(409,this.rt.office.t("Bu bölümde ajan var. Önce ajanları taşıyın ya da silin."));
    }
    if(a.islem==='kurallar_duzenle')z.object({text:z.string().max(60000)}).strict().parse(a.veri);
    if(a.islem==='ayarlar_duzenle'){const settings=settingsSchema.parse(a.veri);if(settings.greeterAgentId)this.rt.office.agent(settings.greeterAgentId);}
    if(a.islem==='oturum_sifirla'){
      const id=z.string().uuid().parse(a.kimlik);this.rt.office.agent(id);const body=z.object({session_key:z.string().max(500).optional()}).strict().parse(a.veri);
      if(body.session_key && !this.rt.a3.sessions().some(s=>s.agent_id===id && s.session_key===body.session_key))throw new Problem(404,this.rt.office.t("Oturum bulunamadı."));
    }
    if(a.islem==='klasor_oner'){
      const value=z.object({name:z.string().trim().min(1).max(100),path:z.string().min(1).max(1000),access:z.enum(['read','write']),approved_write:z.boolean().default(true),agent_ids:z.array(z.string().uuid()).max(100)}).strict().parse(a.veri);for(const id of value.agent_ids)this.rt.office.agent(id);
    }
    // Fixed command definitions and folder assignments change authority. A model
    // reading hostile notes must never approve these changes on the owner's behalf.
    if(['komut_olustur','komut_duzenle'].includes(a.islem)){
      const command=commandSchema.parse(a.veri),folder=this.rt.links().find(l=>l.id===command.folder_id && l.validation==='valid');
      if(!folder)throw new Problem(400,this.rt.office.t("Komut yalnız doğrulanmış klasör bağlantısı üzerinde tanımlanabilir."));
      if(command.agent_ids.some(id=>!folder.agent_ids.includes(id)) || (command.write && (folder.access!=='write' || folder.approved_write)))throw new Problem(400,this.rt.office.t("Komut klasörü ve ajan izinlerini kontrol edin."));
      if(a.islem==='komut_duzenle' && !this.rt.a3.commands().some(c=>c.id===z.string().uuid().parse(a.kimlik)))throw new Problem(404,this.rt.office.t("Komut bulunamadı."));
      return this.propose(run,{...a,veri:command},'director_capability');
    }
    if(a.islem==='baglanti_ata'){
      const value=z.object({agent_ids:z.array(z.string().uuid()).max(100)}).strict().parse(a.veri);
      const folder=this.rt.links().find(l=>l.id===z.string().uuid().parse(a.kimlik) && l.validation==='valid');
      if(!folder)throw new Problem(400,this.rt.office.t("Önce doğrulanmış bir klasör bağlantısı seçin."));
      for(const id of value.agent_ids)this.rt.office.agent(id);
      if(value.agent_ids.some(id=>!folder.agent_ids.includes(id)))return this.propose(run,{...a,veri:value},'director_capability');
    }
    const destructive=['ajan_sil','bolum_sil','tumunu_durdur','kurallar_duzenle','ayarlar_duzenle','oturum_sifirla'];
    if((a.islem==='klasor_oner' && this.settings().ownerApprovalTypes.includes('new_folder')) || (destructive.includes(a.islem) && this.settings().destructiveApproval))return this.propose(run,a,a.islem==='klasor_oner'?'new_folder':'director_destructive');
    if(a.islem==='ajan_calistir'){
      a=this.prepareAssignment(a);
      const options=workOptionsSchema.parse(a.veri.secenekler || {});this.rt.validateWorkOptions(a.kimlik || '',options);const key=typeof a.veri.is==='string'?a.veri.is:`${a.kimlik}:${String(a.veri.text || '').trim().slice(0,160)}`;a={...a,veri:{...a.veri,is:key}};this.redirect(key,run);
    }
    if(['komut_olustur','komut_duzenle'].includes(a.islem) && !this.rt.links().some(l=>l.id===a.veri.folder_id && l.validation==='valid'))throw new Problem(400,this.rt.office.t("Komut yalnız doğrulanmış klasör bağlantısı üzerinde tanımlanabilir."));
    const result=await this.dispatch(a);
    if(a.islem==='ajan_calistir' && result && typeof result==='object' && 'id' in result)this.watch(String(result.id),typeof a.veri.is==='string'?a.veri.is:undefined,true);
    return a.uyarilar?.length && result && typeof result==='object' ? {...result,uyarilar:a.uyarilar} : result;
  }
  prepareAssignment(action:ManagementAction):ManagementAction {
    const aid=z.string().uuid().parse(action.kimlik),agent=this.rt.office.agent(aid);
    if(agent.tududi_state!=='ready')throw new Problem(409,this.rt.office.t("Ajan “{0}”: hesabı hazır değil. Önce Hesabı yeniden kur ile hesabını hazırlayın.", [agent.name]));
    const text=z.string().trim().min(1).max(10000).parse(action.veri.text);
    const parsed=assignmentResourcesSchema.safeParse(action.veri.kaynaklar),acceptance=z.string().trim().min(1).max(2000).safeParse(action.veri.kabul);
    if(!parsed.success || !acceptance.success){
      const reasons=[...(!parsed.success ? parsed.error.issues.map(i=>this.rt.office.t("kaynaklar{0}: alan eksik veya geçersiz", [i.path.length ? '.'+i.path.join('.') : ''])) : []),...(!acceptance.success ? [this.rt.office.t("kabul: bitiş ölçütü eksik veya geçersiz")] : [])];
      throw new Problem(400,this.rt.office.t("İş açılmadı. {0}. Gerekmeyen kaynak listeleri boş olabilir; belge vermek zorunlu değildir.", [reasons.join('; ')]));
    }
    const resources=parsed.data,links=this.rt.links(),commands=this.rt.a3.commands(),missing:string[]=[],warnings:string[]=[];
    const folderName=(id:string)=>links.find(l=>l.id===id)?.name || id;
    const folderReason=(id:string)=>{
      const link=links.find(l=>l.id===id);
      if(!link)return this.rt.office.t("klasör kaydı bulunamadı");
      if(!link.agent_ids.includes(aid))return this.rt.office.t("{0} adlı ajana atanmamış", [agent.name]);
      if(link.validation!=='valid')return link.validation==='pending' ? this.rt.office.t("çalıştırıcının doğrulaması bekleniyor") : this.rt.office.t("çalıştırıcı klasörü geçersiz bulmuş");
      if(agent.policy?.permission!=='folders')return this.rt.office.t("{0} adlı ajanın bağlı klasör erişimi kapalı", [agent.name]);
    };
    const validLink=(id:string)=>!folderReason(id) ? links.find(l=>l.id===id) : undefined;
    for(const id of resources.klasorler){const reason=folderReason(id);if(reason)missing.push(this.rt.office.t("Klasör “{0}”: {1}", [folderName(id), reason]));}
    for(const id of resources.komutlar){
      const command=commands.find(c=>c.id===id),label=this.rt.office.t("Komut “{0}”", [command?.name || id]);
      if(!command){missing.push(this.rt.office.t("{0}: komut kaydı bulunamadı", [label]));continue;}
      if(!command.agent_ids.includes(aid)){missing.push(this.rt.office.t("{0}: {1} adlı ajana atanmamış", [label, agent.name]));continue;}
      const reason=folderReason(command.folder_id);
      if(reason){missing.push(this.rt.office.t("{0}, klasör “{1}”: {2}", [label, folderName(command.folder_id), reason]));continue;}
      const folder=validLink(command.folder_id)!;
      if(command.write && (folder.access!=='write' || folder.approved_write)){missing.push(this.rt.office.t("{0}, klasör “{1}”: doğrudan yazma izni yok", [label, folder.name]));continue;}
      // The legacy policy.commands flag controls neither registered commands nor Codex shell access.
      if(!this.allowedTools(aid).includes('komut_calistir'))missing.push(this.rt.office.t("{0}: {1} adlı ajanın kayıtlı komut aracı kapalı", [label, agent.name]));
      else if(command.approval)warnings.push(this.rt.office.t("{0}: çalıştırılmadan önce onay istenecek.", [label]));
    }
    for(const doc of resources.belgeler){
      const label=this.rt.office.t("Belge “{0}”, klasör “{1}”", [doc.yol, folderName(doc.klasor)]),reason=folderReason(doc.klasor);
      if(reason){missing.push(`${label}: ${reason}`);continue;}
      if(!resources.klasorler.includes(doc.klasor)){missing.push(this.rt.office.t("{0}: klasör işin kaynak listesinde yok", [label]));continue;}
      if(/^(?:[\\/]|[A-Za-z]:)/.test(doc.yol) || doc.yol.split(/[\\/]/).some(p=>!p || p==='..' || p==='.') || /[\x00-\x1f]/.test(doc.yol)){missing.push(this.rt.office.t("{0}: belge yolu güvenli bir göreli yol değil", [label]));continue;}
      if(doc.yol.split(/[\\/]/).some(p=>p.startsWith('.'))){missing.push(this.rt.office.t("{0}: gizli dosya veya klasör kaynak olarak kullanılamaz", [label]));continue;}
      const folder=validLink(doc.klasor)!;
      if(folder.documents?.includes(doc.yol))continue;
      if(folder.documents_truncated || !folder.documents)warnings.push(this.rt.office.t("{0}: belge listesi {1} için varlığı doğrulanamadı; ajan dosyayı kontrol etmeli.", [label, folder.documents_truncated ? this.rt.office.t("kesildiği") : this.rt.office.t("henüz alınmadığı")]));
      else missing.push(this.rt.office.t("{0}: çalıştırıcının doğruladığı tam listede mevcut belge bulunamadı", [label]));
    }
    const development=/(?:geliştir|kod(?:la|lama|u)?\b|özellik|yazılım|hata(?:yı)? düzelt|fabrika ayar|piksel ofis)/iu.test(text);
    if(development){
      if(!resources.klasorler.some(id=>validLink(id)?.access==='write')){
        const readOnly=resources.klasorler.map(validLink).filter(l=>l?.access==='read');
        if(readOnly.length)for(const folder of readOnly)missing.push(this.rt.office.t("Klasör “{0}”: geliştirme için yazma izni eksik; yalnız okuma izni var", [folder!.name]));
        else missing.push(this.rt.office.t("Geliştirme için yazılabilir klasör eksik"));
      }
      if(!resources.komutlar.length)missing.push(this.rt.office.t("Geliştirme için doğrulama komutu eksik"));
    }
    if(missing.length)throw new Problem(409,this.rt.office.t("İş açılmadı. {0}.", [[...new Set(missing)].join('; ')]));
    return {...action,uyarilar:warnings,veri:{...action.veri,text:this.rt.office.t("{0}\nKabul ölçütü: {1}\nKaynaklar (atanmış bağlantılar): {2}{3}\nKaynak eksikse dur ve Genel Müdür'e engel_bildir ile bildir; aynı eksik için tekrar deneme.", [text, acceptance.data, JSON.stringify(resources), warnings.length ? this.rt.office.t("\nKaynak uyarıları: ")+warnings.join(' ') : ''])}};
  }
  private propose(run:Run,action:ManagementAction,type:string){
    const previous=this.rt.approvals().find(a=>a.run_id===run.id && a.type===type && this.db.prepare('SELECT json FROM director_actions WHERE approval_id=?').get(a.id)?.json===JSON.stringify(action));if(previous)return {onay:previous.id};
    const a:Approval={id:randomUUID(),agent_id:run.agent_id,run_id:run.id,title:this.rt.office.t("Genel Müdür önerisi: {0}", [this.rt.office.t(directorOperationLabels[action.islem])]),detail:`${action.kimlik ? this.rt.office.t("Hedef: ")+(this.rt.office.store.agent(action.kimlik)?.name || this.rt.office.store.departments().find(d=>d.id===action.kimlik)?.name || action.kimlik)+'\n' : ''}${action.islem==='klasor_oner' ? this.rt.office.t("Yeni klasör: ")+String(action.veri.path || '') : action.islem==='kurallar_duzenle' ? this.rt.office.t("Yeni kurallar:\n")+String(action.veri.text || '') : JSON.stringify(action.veri,null,2)}`,type,state:'pending',note:'',created_at:this.rt.isoNow(),decided_at:null,link_id:null,files:[]};
    if(type==='factory_reset')a.detail=(action.kimlik?this.rt.office.t('Hedef: ')+this.rt.office.agent(action.kimlik).name:this.rt.office.t('Tüm ajanlar (Genel Müdür dahil)'))+'\n'+this.rt.office.t('Sıfırlama önizlemesini açar. Hiçbir kayıt silinmez. Silme için önizlemede yedeği inceleyip onay kelimesini yazmalısınız.');
    if(type==='director_capability'){
      const folder=this.rt.links().find(l=>l.id===(action.islem==='baglanti_ata'?action.kimlik:action.veri.folder_id));
      if(folder)a.detail=this.rt.office.t("Klasör: {0}\nYol: {1}\nAjanlar: {2}",[folder.name,folder.path,(action.veri.agent_ids as string[]).map(id=>this.rt.office.agent(id).name).join(', ')])+'\n'+a.detail;
    }
    this.db.prepare('INSERT INTO director_actions VALUES (?,?)').run(a.id,JSON.stringify(action));this.rt.saveApproval(a);this.rt.finish(run.id,'waiting','',this.rt.office.t("Sahibin kararı bekleniyor."));return {onay:a.id,sahibin_karari:true};
  }
  async decideAction(id:string,approved:boolean,note:string,actor:'owner'|'director'='owner',ownerSession?:string){
    const row=this.db.prepare('SELECT json FROM director_actions WHERE approval_id=?').get(id);if(!row)return null;
    const a=this.rt.approvals().find(a=>a.id===id);if(!a || a.state!=='pending')throw new Problem(409,this.rt.office.t("Bu onay zaten sonuçlandı."));
    if(actor==='director' && this.ownerOnly(a))throw new Problem(403,this.rt.office.t("Bu karar sahibe ayrılmış."));
    let result:unknown;let resetPreviewId:string|undefined;
    // Execute before consuming approval; a failed validation remains reviewable/retryable.
    if(approved){
      const action=JSON.parse(String(row.json));
      if(action.islem==='fabrika_ayarlari_onizle'){
        if(actor!=='owner' || !ownerSession)throw new Problem(403,this.rt.office.t('Bu karar sahibe ayrılmış.'));
        resetPreviewId=z.string().uuid().parse(action.veri.preview_id);
      }else if(action.reset_redirect){
        this.db.prepare('DELETE FROM director_redirects WHERE work_key=?').run(z.string().min(1).max(200).parse(action.reset_redirect));
        result={bilgi:this.rt.office.t("İşe yeniden yön verme freni sahibin isteğiyle açıldı.")};
      }else{
        if(!this.dispatch)throw new Problem(503,this.rt.office.t("Yönetim köprüsü hazır değil."));
        // A queued settings proposal must not restore an older copy of the
        // owner's approval restrictions after the owner has tightened them.
        if(action.islem==='ayarlar_duzenle')action.veri.director=this.rt.settings().director;
        result=await this.dispatch(action);
      }
    }
    a.state=approved?'applied':'rejected';a.note=this.rt.scrub(note);a.decided_at=this.rt.isoNow();this.rt.saveApproval(a);this.db.prepare('DELETE FROM director_actions WHERE approval_id=?').run(id);
    this.rt.office.event(this.agent().id,'director_owner_decision',`${actor==='director'?this.rt.office.t("Genel Müdür öneriyi"):this.rt.office.t("Sahibi Genel Müdür önerisini")} ${approved?this.rt.office.t("onayladı"):'reddetti'}.`);
    this.rt.resumeApproval(a);if(resetPreviewId)result=await new FactoryReset(this.rt).adopt(resetPreviewId,ownerSession!);return {onay:a,sonuc:result};
  }
  trash(kind:'agent'|'department',id:string,options:Record<string,unknown>){
    const table=kind==='agent'?'agents':'departments',row=this.db.prepare(`SELECT * FROM ${table} WHERE id=? AND deleted_at IS NULL`).get(id);
    if(!row)throw new Problem(404,this.rt.office.t("Silinecek kayıt bulunamadı."));if(row.builtin==='director')throw new Problem(403,this.rt.office.t("Genel Müdür silinemez."));
    if(kind==='department' && this.db.prepare('SELECT id FROM agents WHERE department_id=?').get(id))throw new Problem(409,this.rt.office.t("Bu bölümde ajan var. Önce ajanları taşıyın ya da silin."));
    const expires=this.rt.clock()+86400000;
    this.db.exec('BEGIN');try{this.db.prepare('INSERT INTO office_trash VALUES (?,?,?,?,?)').run(id,kind,row.name,expires,JSON.stringify({...options,active:row.active}));this.db.prepare(`UPDATE ${table} SET deleted_at=? ${kind==='agent'?",active=0,status='kapali',current_job=''":''} WHERE id=?`).run(this.rt.isoNow(),id);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
    this.rt.office.event(null,'office_trash',this.rt.office.t("{0} 24 saatliğine çöp kutusuna taşındı. Geri al: {1}", [row.name, id]));return {ok:true,geri_al:id,expires_at:expires};
  }
  trashList(){return this.db.prepare('SELECT id,kind,name,expires_at FROM office_trash WHERE expires_at>?').all(this.rt.clock());}
  restore(id:string){const row=this.db.prepare('SELECT * FROM office_trash WHERE id=? AND expires_at>?').get(id,this.rt.clock());if(!row)throw new Problem(404,this.rt.office.t("Geri alma süresi dolmuş veya kayıt bulunamadı."));const opts=JSON.parse(String(row.json)),table=row.kind==='agent'?'agents':'departments';this.db.prepare(`UPDATE ${table} SET deleted_at=NULL ${row.kind==='agent'?",active=?,status='bosta'":''} WHERE id=?`).run(...(row.kind==='agent'?[Number(opts.active)]:[]),id);this.db.prepare('DELETE FROM office_trash WHERE id=?').run(id);this.rt.office.event(null,'office_restored',this.rt.office.t("{0} çöp kutusundan geri alındı.", [row.name]));return {ok:true};}
  expireTrash(){if(this.expiring || this.closed)return this.expiring || Promise.resolve();this.expiring=this.purgeTrash().finally(()=>{this.expiring=undefined;});return this.expiring;}
  private async purgeTrash(){for(const row of this.db.prepare('SELECT * FROM office_trash WHERE expires_at<=?').all(this.rt.clock())){const id=String(row.id);if(row.kind==='agent'){const options=JSON.parse(String(row.json));this.db.prepare('UPDATE agents SET deleted_at=NULL WHERE id=?').run(id);try{await this.rt.office.removeAgent(id,options.account==='delete',options.profile==='delete');}catch{this.db.prepare('UPDATE agents SET deleted_at=? WHERE id=?').run(this.rt.isoNow(),id);continue;}}else this.db.prepare('DELETE FROM departments WHERE id=?').run(id);this.db.prepare('DELETE FROM office_trash WHERE id=?').run(id);}}
  async close(){this.closed=true;if(this.timer)clearTimeout(this.timer);await this.syncing;await this.expiring;}
}
