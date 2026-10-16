import { officeDay } from '../shared/time.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { accessRoutes } from './tududi-access.js';
import type { Runtime } from './runtime.js';
import { usageTotals } from '../shared/runtime.js';
import { Problem } from './service.js';
const uuid = z.string().uuid();
export const commandSchema = z.object({ name: z.string().trim().min(1).max(100), folder_id: uuid, directory: z.string().max(500).default('.').refine(p => !p.startsWith('/') && !p.includes('\\') && !p.split('/').includes('..') && !/[\x00-\x1f]/.test(p)), command: z.string().trim().min(1).max(2000), timeout_seconds: z.number().int().min(1).max(600).default(120), write: z.boolean().default(false), approval: z.boolean().default(true), agent_ids: z.array(uuid).max(100) }).strict();
export function a3Routes(app: FastifyInstance, rt: Runtime) {
  accessRoutes(app,rt);
  app.get<{Params:{id:string}}>('/api/agents/:id/session', async req => {
    const id=uuid.parse(req.params.id),key=z.object({key:z.string().max(500).optional()}).parse(req.query).key,session=key ? rt.a3.sessions().find(s=>s.agent_id===id && s.session_key===key) : rt.a3.session(id);
    if(!session)throw new Problem(404,rt.office.t("Oturum bulunamadı."));
    const single=rt.office.agent(id).session_mode==='single';
    const raw=rt.db.prepare('SELECT run_logs.* FROM run_logs JOIN runs ON runs.id=run_logs.run_id WHERE runs.agent_id=? AND (runs.session_generation=? OR ?=1) ORDER BY run_logs.id DESC LIMIT 500').all(id,session.generation,Number(single)).reverse();
    const logs:typeof raw=[];for(const row of raw){const last=logs.at(-1);if(last && row.kind==='text' && last.kind==='text' && row.run_id===last.run_id)last.text=String(last.text)+String(row.text);else logs.push(row);}
    return {session,logs,runs:rt.runs().filter(r=>r.agent_id===id)};
  });
  app.post<{Params:{id:string}}>('/api/agents/:id/session/input', async req => {
    const id = uuid.parse(req.params.id), b = z.object({ text: z.string().trim().min(1).max(10000), mode: z.enum(['queue','interrupt','new']).default('queue'), session_key:z.string().max(500).optional() }).strict().parse(req.body);
    const session=b.session_key ? rt.a3.sessions().find(s=>s.agent_id===id && s.session_key===b.session_key) : rt.a3.session(id);
    if(!session)throw new Problem(404,rt.office.t("Oturum bulunamadı."));
    const item={work_item_id:session.work_item_id};
    if (b.mode === 'interrupt') for (const r of rt.runs().filter(r => r.agent_id === id && r.state === 'running')) rt.finish(r.id, 'stopped', '', rt.office.t("Sahibi yeni girdiyle araya girdi."));
    const message = rt.office.message(null, 'agent', id, b.text);
    if(b.mode==='new') {
      for(const r of rt.runs().filter(r=>r.message_id===message.id && r.agent_id===id)) {
        const work=`${id}:${r.chain_id}`;rt.db.prepare('INSERT OR IGNORE INTO work_items(id,agent_id,updated_at) VALUES (?,?,?)').run(work,id,new Date().toISOString());rt.db.prepare('UPDATE runs SET work_item_id=? WHERE id=?').run(work,r.id);
      }
    } else if(item.work_item_id)rt.db.prepare('UPDATE runs SET work_item_id=? WHERE message_id=? AND agent_id=?').run(item.work_item_id,message.id,id);
    rt.office.event(id, 'session_input', b.mode === 'interrupt' ? rt.office.t("Sahibi oturuma araya girerek yazdı.") : rt.office.t("Sahibinin girdisi oturum sırasına eklendi.")); return message;
  });
  const selected=(id:string,body:unknown) => {
    const b=z.object({session_key:z.string().max(500).optional()}).strict().parse(body || {});
    const s=b.session_key ? rt.a3.sessions().find(s=>s.agent_id===id && s.session_key===b.session_key) : rt.a3.session(id);
    if(!s)throw new Problem(404,rt.office.t("Oturum bulunamadı."));return s;
  };
  app.post<{Params:{id:string}}>('/api/agents/:id/session/renew', async req => { const id=uuid.parse(req.params.id);rt.a3.renew(id,selected(id,req.body)); return { ok: true }; });
  app.post<{Params:{id:string}}>('/api/agents/:id/session/reset', async req => { const id = uuid.parse(req.params.id); const s=selected(id,req.body);rt.stop(id); rt.a3.rotate(id,s); return { ok: true }; });
  app.post('/api/runtime/providers/resume', async req => { const b = z.object({ provider: z.enum(['codex','claude']) }).strict().parse(req.body); rt.a3.resume(b.provider); return { ok: true }; });
  app.post('/api/commands', async req => {
    const body = commandSchema.parse(req.body);
    if (rt.a3.commands().some(c => c.name === body.name)) throw new Problem(409, rt.office.t("Komut adı zaten kullanılıyor."));
    const folder = rt.links().find(l => l.id === body.folder_id);
    if (!folder || body.agent_ids.some(id => !folder.agent_ids.includes(id)) || (body.write && (folder.access !== 'write' || folder.approved_write))) throw new Problem(400, rt.office.t("Komut klasörü ve ajan izinlerini kontrol edin."));
    const c = { ...body, id: randomUUID() }; rt.db.prepare('INSERT INTO command_links VALUES (?,?)').run(c.id, JSON.stringify(c)); rt.office.changed(); return c;
  });
  app.put<{Params:{id:string}}>('/api/commands/:id',async req=>{
    const id=uuid.parse(req.params.id),body=commandSchema.parse(req.body);if(!rt.a3.commands().some(c=>c.id===id))throw new Problem(404,rt.office.t("Komut bulunamadı."));
    if(rt.a3.commands().some(c=>c.id!==id && c.name===body.name))throw new Problem(409,rt.office.t("Komut adı zaten kullanılıyor."));
    const folder=rt.links().find(l=>l.id===body.folder_id);
    if(!folder || body.agent_ids.some(id=>!folder.agent_ids.includes(id)) || (body.write && (folder.access!=='write' || folder.approved_write)))throw new Problem(400,rt.office.t("Komut klasörü ve ajan izinlerini kontrol edin."));
    for(const j of rt.a3.jobs().filter(j=>j.command.id===id && j.state!=='completed'))rt.finish(j.run_id,'stopped','',rt.office.t("Komut bağlantısı değiştirildi."));
    const c={...body,id};rt.db.prepare('UPDATE command_links SET json=? WHERE id=?').run(JSON.stringify(c),id);rt.office.changed();return c;
  });
  app.delete<{Params:{id:string}}>('/api/commands/:id', async req => { const id=uuid.parse(req.params.id);for(const j of rt.a3.jobs().filter(j=>j.command.id===id && j.state!=='completed'))rt.finish(j.run_id,'stopped','',rt.office.t("Sahibi komut bağlantısını kaldırdı."));rt.db.prepare('DELETE FROM command_links WHERE id=?').run(id); rt.office.changed(); return { ok: true }; });
  app.post('/api/runner/sessions/update', async req => { const b = z.object({ runner: z.string(), id: uuid, provider_id: uuid, bytes: z.number().int().nonnegative().max(10000000000) }).strict().parse(req.body); rt.owns(b.id,b.runner); const r = rt.run(b.id); if (r.state !== 'running') throw new Problem(409,rt.office.t("Çalışma durduruldu.")); rt.a3.recordSession(r,b.provider_id,b.bytes); return { ok: true }; });
  app.post('/api/runner/quota', async req => { const b = z.object({ runner: z.string(), id: uuid, reason: z.string().max(2000), until: z.number().nullable() }).strict().parse(req.body); rt.owns(b.id,b.runner); const r = rt.run(b.id); rt.a3.pause(rt.office.agent(r.agent_id).runner,b.reason,b.until); return { ok: true }; });
  app.post('/api/runner/profiles/deleted', async req => { const b = z.object({ agent: uuid }).strict().parse(req.body); rt.db.prepare('DELETE FROM profile_deletions WHERE agent_id=?').run(b.agent); return { ok: true }; });
  app.post('/api/runner/commands/take', async req => {
    const b = z.object({ id: uuid }).strict().parse(req.body), j = rt.a3.jobs().find(j => j.id === b.id && j.state === 'pending');
    if (!j || rt.run(j.run_id).state !== 'running' || rt.a3.jobs().some(other => other.state === 'running' && other.folder.id === j.folder.id)) return null;
    j.state = 'running'; rt.a3.saveJob(j); return j;
  });
  app.post('/api/runner/commands/result', async req => {
    const b = z.object({ id: uuid, exit_code: z.number().int().nullable(), output: z.string().max(20000) }).strict().parse(req.body), j = rt.a3.jobs().find(j => j.id === b.id && j.state === 'running');
    if (!j) throw new Problem(409, rt.office.t("Komut işi geçersiz."));
    j.state = 'completed'; j.exit_code = b.exit_code; j.output = rt.publicText(b.output); rt.a3.saveJob(j); rt.log(j.run_id,'command_result',JSON.stringify({ ad:j.command.name, cikis:j.exit_code, cikti:j.output })); return { ok:true };
  });
  app.get<{Params:{id:string}}>('/api/agent-tools/command-result/:id', async req => { const r = rt.authenticate(req.headers.authorization?.replace(/^Bearer /,'') || ''), j = rt.a3.jobs().find(j => j.id === uuid.parse(req.params.id) && j.run_id === r.id); if (!j) throw new Problem(404,rt.office.t("Komut işi bulunamadı.")); return { state:j.state, exit_code:j.exit_code, output:j.output }; });
  app.put<{Params:{id:string;uid:string}}>('/api/agents/:id/notes/:uid/mark',async req => {
    const aid = uuid.parse(req.params.id); rt.office.agent(aid);
    const b = z.object({locked:z.boolean(),invalid:z.boolean(),verified:z.boolean().default(false)}).strict().parse(req.body);
    const own = await rt.notebook.data(aid); if (!own.notes.some(n => n.uid === req.params.uid)) throw new Problem(404,rt.office.t("Not bulunamadı."));
    rt.db.prepare('INSERT INTO notebook_marks(agent_id,uid,locked,invalid,verified_at) VALUES (?,?,?,?,?) ON CONFLICT(agent_id,uid) DO UPDATE SET locked=excluded.locked,invalid=excluded.invalid,verified_at=COALESCE(excluded.verified_at,notebook_marks.verified_at)').run(aid,req.params.uid,Number(b.locked),Number(b.invalid),b.verified ? new Date().toISOString() : null);
    rt.office.event(aid,'notebook_mark',rt.office.t("Sahibi bilgi notunun doğrulama veya kullanım işaretini değiştirdi."));
    await rt.notebook.refresh(aid); return {ok:true};
  });
  app.get('/api/shared-notebook',async () => rt.db.prepare('SELECT * FROM shared_notes').all());
  app.post('/api/shared-notebook',async req => { const b = z.object({title:z.string().trim().min(1).max(200),content:z.string().max(4000)}).strict().parse(req.body); return rt.notebook.sharedWrite(b.title,b.content,'owner',true); });
  app.put<{Params:{id:string}}>('/api/shared-notebook/:id/mark',async req => { const b = z.object({locked:z.boolean(),invalid:z.boolean()}).strict().parse(req.body); rt.db.prepare('UPDATE shared_notes SET locked=?,invalid=? WHERE id=?').run(Number(b.locked),Number(b.invalid),req.params.id); return {ok:true}; });
  app.get('/api/usage/details',async () => {
    const runs=rt.db.prepare('SELECT id FROM runs').all().map(r=>rt.run(r.id as string));
    const days=new Map<string,{agent_id:string;day:string;input_tokens:number;cached_input_tokens:number;uncached_input_tokens:number;output_tokens:number;weighted_tokens:number;total_tokens:number}>();
    for(const r of runs) {
      const day=officeDay(r.started_at || r.created_at,rt.settings().timeZone),key=r.agent_id+day,t=usageTotals(r.usage);
      const row=days.get(key) || {agent_id:r.agent_id,day,input_tokens:0,cached_input_tokens:0,uncached_input_tokens:0,output_tokens:0,weighted_tokens:0,total_tokens:0};
      for(const field of ['input_tokens','cached_input_tokens','uncached_input_tokens','output_tokens'] as const)row[field]+=t[field];
      row.weighted_tokens+=rt.budgetInput(r.usage);row.total_tokens+=t.total_tokens;days.set(key,row);
    }
    return {
      expensive:runs.sort((a,b)=>rt.budgetInput(b.usage)-rt.budgetInput(a.usage)).slice(0,5),
      sessions:rt.a3.sessions().map(s=>({...s,weighted_tokens:runs.filter(r=>r.agent_id===s.agent_id && r.session_generation===s.generation).reduce((n,r)=>n+rt.budgetInput(r.usage),0),total_tokens:runs.filter(r=>r.agent_id===s.agent_id && r.session_generation===s.generation).reduce((n,r)=>n+usageTotals(r.usage).total_tokens,0),average_tokens:s.turns ? Math.round(s.input_tokens/s.turns) : 0,average_cached_tokens:s.turns ? Math.round((s.cached_input_tokens || 0)/s.turns) : 0,average_uncached_tokens:s.turns ? Math.round((s.input_tokens-(s.cached_input_tokens || 0))/s.turns) : 0})),
      days:[...days.values()].sort((a,b)=>b.day.localeCompare(a.day)).slice(0,100)
    };
  });
  app.get('/api/summaries', async () => rt.db.prepare('SELECT json,published FROM daily_summaries ORDER BY day DESC LIMIT 100').all().map(r => ({ ...JSON.parse(r.json as string), published:!!r.published })));
  app.post('/api/summaries/now', async () => rt.a3.summary(officeDay(Date.now(),rt.settings().timeZone)));
}
