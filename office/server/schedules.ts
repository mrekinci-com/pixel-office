import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Runtime } from './runtime.js';
import { Problem } from './service.js';
import { TududiError } from './tududi.js';
import { nextTimes, type ScheduledTask, type ScheduleHistory } from '../shared/schedules.js';
import { officeDay, dayStart, previousDay } from '../shared/time.js';
import { usageTotals, type Run } from '../shared/runtime.js';
const time=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>!Number.isNaN(Date.parse(s)) && new Date(s+'T12:00:00Z').toISOString().slice(0,10)===s,'Geçerli bir tarih seçin.');
export const timingSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('daily'),time}).strict(),
  z.object({kind:z.literal('weekly'),time,days:z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(a=>new Set(a).size===a.length)}).strict(),
  z.object({kind:z.literal('interval'),hours:z.number().int().min(1).max(24),start:z.number().int().min(0).max(23),end:z.number().int().min(0).max(23)}).strict().refine(t=>t.end>=t.start,'Bitiş saati başlangıçtan önce olamaz.'),
  z.object({kind:z.literal('monthly'),time,day:z.number().int().min(1).max(31)}).strict(),
  z.object({kind:z.literal('once'),time,date}).strict(),
]);
export const scheduleSchema=z.object({name:z.string().trim().min(1).max(100),agent_id:z.string().uuid(),instruction:z.string().trim().min(1).max(16000),timing:timingSchema,enabled:z.boolean().default(true),end_date:date.nullable().default(null),attention_only:z.boolean().default(false),token_budget:z.number().int().min(1000).max(1000000000).default(150000),daily_limit:z.number().int().min(1).max(100).default(24)}).strict();
export class Scheduler {
  private preparing=new Map<string,Promise<void>>();
  private syncPromise:Promise<void>|undefined;
  private lastSyncAt=0;
  constructor(private rt:Runtime, public clock:()=>number=()=>Date.now()) {}
  get db(){return this.rt.db;}
  tasks():ScheduledTask[] {return this.db.prepare('SELECT scheduled_tasks.json FROM scheduled_tasks JOIN agents ON agents.id=scheduled_tasks.agent_id WHERE agents.deleted_at IS NULL ORDER BY scheduled_tasks.rowid').all().map(r=>{const t=JSON.parse(String(r.json));return {...t,last_note:this.note(t.id),last_result:this.history(t.id,1)[0] || null};});}
  task(id:string){const t=this.tasks().find(t=>t.id===id);if(!t)throw new Problem(404,this.rt.office.t("Zamanlanmış görev bulunamadı."));return t;}
  note(id:string){return String(this.db.prepare('SELECT note FROM work_items WHERE id=?').get('schedule:'+id)?.note || '');}
  save(t:ScheduledTask){const {last_result,last_note,...value}=t;this.db.prepare('INSERT INTO scheduled_tasks(id,agent_id,json) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET agent_id=excluded.agent_id,json=excluded.json').run(t.id,t.agent_id,JSON.stringify(value));}
  history(id:string,limit=100):ScheduleHistory[]{return this.db.prepare('SELECT json FROM schedule_history WHERE task_id=? ORDER BY rowid DESC LIMIT ?').all(id,limit).map(row=>{
    const h=JSON.parse(String(row.json)) as ScheduleHistory;
    if(h.chain_id){const runs=this.db.prepare('SELECT usage,duration_ms,state,started_at FROM runs WHERE chain_id=?').all(h.chain_id);h.tokens=runs.reduce((n,r)=>{const u=usageTotals(JSON.parse(String(r.usage)));return n+u.input_tokens+u.output_tokens;},0);h.duration_ms=runs.reduce((n,r)=>n+Number(r.duration_ms)+(r.state==='running' && r.started_at ? Math.max(0,this.clock()-Date.parse(String(r.started_at))) : 0),0);}
    return h;
  });}
  pendingHistory(id:string):ScheduleHistory[]{return this.db.prepare("SELECT h.json FROM schedule_history h LEFT JOIN chains c ON c.id=h.chain_id WHERE h.task_id=? AND (json_extract(h.json,'$.state') IN ('queued','running','waiting') OR (c.stopped=1 AND json_extract(h.json,'$.state') NOT IN ('skipped','missed'))) ORDER BY h.rowid").all(id).map(r=>JSON.parse(String(r.json)));}
  async retireTask(t:ScheduledTask){
    await this.preparing.get(t.id);
    const uid=this.db.prepare('SELECT task_uid FROM work_items WHERE id=?').get('schedule:'+t.id)?.task_uid;
    if(uid){
      const id=`${t.id}:${t.agent_id}:${uid}`;
      this.db.prepare('INSERT OR IGNORE INTO schedule_retirements VALUES (?,?,?)').run(id,t.agent_id,String(uid));
      await this.retirePending(id);
    }
  }
  private async retirePending(id?:string){
    const rows=id ? this.db.prepare('SELECT * FROM schedule_retirements WHERE id=?').all(id) : this.db.prepare('SELECT * FROM schedule_retirements').all();
    for(const row of rows){
      try {
        const task=await this.rt.office.tududi.updateTask(this.rt.office.token(String(row.agent_id)),String(row.task_uid),2);
        this.rt.notebook.record(String(row.agent_id),'task',task);
        this.db.prepare('DELETE FROM schedule_retirements WHERE id=?').run(row.id);
      }catch(error){
        if(error instanceof TududiError && error.status===404)this.db.prepare('DELETE FROM schedule_retirements WHERE id=?').run(row.id);
        else if(id)throw error;
      }
    }
  }
  saveHistory(h:ScheduleHistory){this.db.prepare('INSERT INTO schedule_history(id,task_id,due_at,run_id,chain_id,json) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(h.id,h.task_id,h.due_at,h.run_id,h.chain_id,JSON.stringify(h));}
  upsert(body:unknown,id?:string){const input=scheduleSchema.parse(body),old=id ? this.task(id) : undefined;this.rt.office.agent(input.agent_id);input.instruction=this.rt.scrub(input.instruction);input.name=this.rt.scrub(input.name);
    if(old && old.agent_id!==input.agent_id && this.active(old.id))throw new Problem(409,this.rt.office.t("Çalışma sürerken ajan değiştirilemez."));
    const t:ScheduledTask={...input,id:id || randomUUID(),created_at:old?.created_at || new Date(this.clock()).toISOString(),failures:old && !(input.enabled && !old.enabled) ? old.failures : 0,notice_reason:old?.notice_reason || '',last_note:'',next_at:nextTimes(input.timing,this.clock(),this.rt.settings().timeZone,input.end_date,1)[0] || null};
    if(!old || old.agent_id!==input.agent_id)this.db.prepare('INSERT INTO work_items(id,agent_id,updated_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET agent_id=excluded.agent_id,task_uid=NULL,note=\'\'').run('schedule:'+t.id,t.agent_id,new Date(this.clock()).toISOString());
    if(old && JSON.stringify(old.timing)===JSON.stringify(input.timing) && old.end_date===input.end_date && old.enabled===input.enabled)t.next_at=old.next_at;
    this.save(t);this.rt.office.changed();return this.task(t.id);
  }
  async ensureTask(t:ScheduledTask,verify=false) {
    if(!verify && this.db.prepare("SELECT task_uid FROM work_items WHERE id=?").get("schedule:"+t.id)?.task_uid)return;
    const ongoing=this.preparing.get(t.id);if(ongoing)return ongoing;
    const promise=(async()=>{
      const id='schedule:'+t.id,item=this.db.prepare('SELECT * FROM work_items WHERE id=?').get(id);
      if(!item)return;
      const token=this.rt.office.token(t.agent_id),data=await this.rt.notebook.data(t.agent_id);
      let task=data.tasks.find(task=>task.uid===item.task_uid);
      const name=this.rt.office.t("Zamanlanmış: {0}", [t.name]);
      if(!task){task=await this.rt.office.tududi.task(token,{name,description:String(item.note || ''),project_uid:await this.rt.office.ensureWorkbook(t.agent_id)});this.db.prepare('UPDATE work_items SET task_uid=? WHERE id=?').run(task.uid,id);this.rt.notebook.record(t.agent_id,'task',task);}
      else if(task.name!==name){const renamed=await this.rt.office.tududi.renameTask(token,task.uid,name);this.rt.notebook.record(t.agent_id,'task',renamed);}
    })();
    this.preparing.set(t.id,promise);try{await promise;}finally{this.preparing.delete(t.id);}
  }
  async syncTasks(){
    if(this.rt.office.resetBlocked())return;
    if(this.syncPromise)return this.syncPromise;
    if(this.clock()-this.lastSyncAt<30000)return;
    this.lastSyncAt=this.clock();
    this.syncPromise=(async()=>{await this.retirePending().catch(()=>{});for(const t of this.tasks())try{await this.ensureTask(t,true);}catch { /* Retry when Tududi reconnects. */ }})();
    try{await this.syncPromise;}finally{this.syncPromise=undefined;}
  }
  async close(){await this.syncPromise;await Promise.allSettled(this.preparing.values());}
  private activeRun(run:Run){
    if(['queued','running'].includes(run.state))return true;
    return run.state==='waiting' && this.rt.approvals().some(a=>a.run_id===run.id && (a.state==='pending' || (!!a.link_id && ['approved','applying'].includes(a.state))));
  }
  active(id:string){return this.db.prepare("SELECT id FROM runs WHERE chain_id IN (SELECT chain_id FROM schedule_history WHERE task_id=?) AND state IN ('queued','running','waiting')").all(id).some(row=>this.activeRun(this.rt.run(String(row.id))));}
  notify(t:ScheduledTask,reason:string){const key=reason.replace(/\d[\d.,: /-]*/g,'#');if(t.notice_reason!==key){this.rt.office.event(t.agent_id,'schedule_attention',this.rt.office.t("Zamanlanmış: {0} — {1}", [t.name, reason]));this.rt.notice(t.agent_id,this.rt.office.t("Zamanlanmış: {0} — {1}", [t.name, reason]));t.notice_reason=key;this.save(t);}}
  launch(t:ScheduledTask,due:string){
    const at=this.clock(),today=officeDay(at,this.rt.settings().timeZone);
    const start=dayStart(today,this.rt.settings().timeZone).toISOString(),end=dayStart(previousDay(today,-1),this.rt.settings().timeZone).toISOString();
    const count=Number(this.db.prepare("SELECT COUNT(*) AS n FROM schedule_history h JOIN runs r ON r.id=h.run_id WHERE h.task_id=? AND COALESCE(r.started_at,json_extract(h.json,'$.created_at'))>=? AND COALESCE(r.started_at,json_extract(h.json,'$.created_at'))<?").get(t.id,start,end)!.n);
    const reason=this.active(t.id) ? this.rt.office.t("Önceki çalıştırma hâlâ sürüyor.") : !this.rt.office.agent(t.agent_id).active ? this.rt.office.t("Ajan pasif.") : count>=t.daily_limit ? this.rt.office.t("Görevin günlük çalıştırma sınırı doldu.") : this.rt.queueBlock(t.agent_id)?.reason || (this.rt.availability?.[this.rt.office.agent(t.agent_id).runner]===false ? this.rt.office.t("Sağlayıcı hesabı bağlı değil.") : '');
    const h:ScheduleHistory={id:randomUUID(),task_id:t.id,due_at:due,created_at:new Date(at).toISOString(),run_id:null,chain_id:null,state:'skipped',reason,output:'',duration_ms:0,tokens:0,finished_at:null};
    if(reason){h.finished_at=h.created_at;this.saveHistory(h);this.notify(t,reason);return h;}
    try {
      const r=this.rt.enqueue(t.agent_id,this.rt.office.t("Zamanlanmış görev: {0}", [t.name]),t.instruction+this.rt.office.t("\n\nBu zamanlanmış çalıştırmanın sonunda is_notu_yaz ile kısa, doğrulanmış son durumu güncelle.")+(t.attention_only ? this.rt.office.t("\nYalnız dikkat gerektiren bir şey varsa haber ver. Önemli bir şey yoksa yalnız SESSIZ yaz.") : ''));
      if(!r)throw new Problem(409,this.rt.office.t("Çalışma sınırları başlatmaya izin vermedi."));
      this.db.prepare('UPDATE runs SET scheduled_task_id=?,work_item_id=? WHERE id=?').run(t.id,'schedule:'+t.id,r.id);
      this.db.prepare('UPDATE chains SET scheduled_token_budget=? WHERE id=?').run(t.token_budget,r.chain_id);
      h.run_id=r.id;h.chain_id=r.chain_id;h.state='queued';this.saveHistory(h);this.save(t);
    }catch(e){h.reason=this.rt.publicText(e instanceof Error ? e.message : this.rt.office.t("Çalışma başlatılamadı."));h.finished_at=h.created_at;this.saveHistory(h);this.notify(t,h.reason);}
    this.rt.office.changed();return h;
  }
  reconcile(){for(const t of this.tasks())for(const h of this.pendingHistory(t.id)){
    const runs=this.db.prepare('SELECT id FROM runs WHERE chain_id=? ORDER BY created_at,rowid').all(h.chain_id).map(r=>this.rt.run(String(r.id)));
    for(const run of runs.filter(r=>r.state==='queued')) {
      const block=this.rt.queueBlock(run.agent_id),inactive=!this.rt.office.agent(run.agent_id).active;
      if(inactive || (block && block.setting!=='links'))this.rt.finish(run.id,'failed','',inactive ? this.rt.office.t("Ajan pasif.") : block!.reason);
    }
    for(let i=0;i<runs.length;i++)runs[i]=this.rt.run(runs[i].id);
    const pending=runs.some(r=>this.activeRun(r));
    h.duration_ms=runs.reduce((n,r)=>n+r.duration_ms+(r.state==='running' && r.started_at ? Math.max(0,this.clock()-Date.parse(r.started_at)) : 0),0);h.tokens=runs.reduce((n,r)=>{const u=usageTotals(r.usage);return n+u.input_tokens+u.output_tokens;},0);
    if(pending){h.state=runs.some(r=>r.state==='running') ? 'running' : runs.some(r=>r.state==='queued') ? 'queued' : 'waiting';h.reason=h.state==='waiting' ? this.rt.office.t("Sahibin onayı bekleniyor.") : '';this.saveHistory(h);continue;}
    const root=runs.filter(r=>r.agent_id===t.agent_id && r.state==='completed').at(-1) || this.rt.run(h.run_id!),failed=runs.filter(r=>(['failed','stopped','interrupted','budget_exceeded'].includes(r.state) && !runs.some(child=>child.parent_run_id===r.id && child.state==='completed')) || (r.state==='waiting' && !this.activeRun(r) && !runs.some(child=>child.parent_run_id===r.id))).map(r=>r.state==='waiting' ? {...r,reason:this.rt.office.t("Onay sonrası çalışma başlatılamadı.")} : r);
    const chainReason=String(this.db.prepare('SELECT stop_reason FROM chains WHERE id=?').get(h.chain_id)?.stop_reason || '');
    h.result_run_id=root.id;h.output=root.output;h.finished_at=new Date(this.clock()).toISOString();h.state=failed.length ? 'failed' : t.attention_only && root.output.trimStart().startsWith('SESSIZ') ? 'silent' : 'completed';h.reason=failed.map(r=>r.reason).join(' · ') || chainReason;
    const limitReason=chainReason || [h.reason,...failed.map(r=>r.reason)].find(reason=>/token.*(bütçesi|tavanı)|günlük.*sınırı|kota|duraklatıldı|Ofis durduruldu|Ajan pasif|sınıra ulaştığı/i.test(reason));
    if(limitReason){h.state='skipped';h.reason=limitReason;this.notify(t,limitReason);}
    if(['completed','silent'].includes(h.state))t.notice_reason='';
    t.failures=h.state==='failed' ? t.failures+1 : h.state==='skipped' ? t.failures : 0;
    if(t.failures>=3){t.enabled=false;this.notify(t,this.rt.office.t("Arka arkaya 3 başarısızlık nedeniyle görev pasife alındı."));}
    this.saveHistory(h);this.save(t);this.rt.office.changed();
  }}
  tick(){this.reconcile();if(!this.rt.runnerId || this.rt.clock()-this.rt.heartbeatAt>=5000)return;
    const at=this.clock(),zone=this.rt.settings().timeZone;
    for(const t of this.tasks()){
      if(!t.enabled || !t.next_at || Date.parse(t.next_at)>at)continue;
      const due=Date.parse(t.next_at),recent=nextTimes(t.timing,Math.max(due-1,at-6*3600000-1),zone,t.end_date,10).filter(s=>Date.parse(s)<=at);
      const latest=recent.at(-1);
      if(at-due>6*3600000 || (latest && Date.parse(latest)>due))this.saveHistory({id:randomUUID(),task_id:t.id,due_at:t.next_at,created_at:new Date(at).toISOString(),run_id:null,chain_id:null,state:'missed',reason:this.rt.office.t("Kaçırıldı; biriken çalıştırmalar yığılmadı."),output:'',duration_ms:0,tokens:0,finished_at:new Date(at).toISOString()});
      if(latest)this.launch(t,latest);
      t.next_at=nextTimes(t.timing,at,zone,t.end_date,1)[0] || null;
      // launch may change the notification state; preserve that update.
      t.notice_reason=this.task(t.id).notice_reason;this.save(t);this.rt.office.changed();
    }
  }
  output(run:Run,final:string){if(!run.scheduled_task_id)return false;const t=this.task(run.scheduled_task_id);
    if(!final.trimStart().startsWith('SESSIZ'))this.rt.office.event(run.agent_id,'schedule_attention',this.rt.office.t("Zamanlanmış: {0} · {1}", [t.name, final.slice(0,1000)]),{run_id:run.id});
    if(!(t.attention_only && final.trimStart().startsWith('SESSIZ')))this.rt.office.message(run.agent_id,'agent',run.agent_id,this.rt.office.t("Zamanlanmış: {0}\n\n{1}", [t.name, final.slice(0,9800)]),true);
    return true;
  }
  rezone(){for(const t of this.tasks()){t.next_at=nextTimes(t.timing,this.clock(),this.rt.settings().timeZone,t.end_date,1)[0] || null;this.save(t);}}
}
export function scheduleRoutes(app:FastifyInstance,rt:Runtime){
  app.get('/api/schedules',async()=>rt.scrubValue(rt.scheduler.tasks()));
  app.post('/api/schedules/preview',async req=>{const b=z.object({timing:timingSchema,end_date:date.nullable().default(null)}).strict().parse(req.body);return {times:nextTimes(b.timing,rt.scheduler.clock(),rt.settings().timeZone,b.end_date)};});
  app.post('/api/schedules',async req=>{const t=rt.scheduler.upsert(req.body);await rt.scheduler.ensureTask(t,true).catch(()=>{});return rt.scrubValue(rt.scheduler.task(t.id));});
  app.put('/api/schedules/:id',async req=>{
    const id=(req.params as {id:string}).id,input=scheduleSchema.parse(req.body),old=rt.scheduler.task(id);
    if(old.agent_id!==input.agent_id){
      rt.office.agent(input.agent_id);
      if(rt.scheduler.active(id))throw new Problem(409,rt.office.t("Çalışma sürerken ajan değiştirilemez."));
      await rt.scheduler.retireTask(old).catch(()=>{});
    }
    const t=rt.scheduler.upsert(input,id);await rt.scheduler.ensureTask(t,true).catch(()=>{});return rt.scrubValue(rt.scheduler.task(t.id));
  });
  app.delete('/api/schedules/:id',async req=>{const t=rt.scheduler.task((req.params as {id:string}).id);if(rt.scheduler.active(t.id))throw new Problem(409,rt.office.t("Silmeden önce devam eden çalışmayı durdurun."));await rt.scheduler.retireTask(t).catch(()=>{});rt.db.prepare('DELETE FROM scheduled_tasks WHERE id=?').run(t.id);rt.db.prepare('DELETE FROM work_items WHERE id=?').run('schedule:'+t.id);rt.office.changed();return {ok:true};});
  app.post('/api/schedules/:id/run',async req=>rt.scheduler.launch(rt.scheduler.task((req.params as {id:string}).id),new Date(rt.scheduler.clock()).toISOString()));
  app.get('/api/schedules/:id/history',async req=>{const id=(req.params as {id:string}).id;rt.scheduler.task(id);rt.scheduler.reconcile();return rt.scrubValue(rt.scheduler.history(id));});
}
