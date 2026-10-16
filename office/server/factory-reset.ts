import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Runtime } from './runtime.js';
import { TududiError } from './tududi.js';
import { Problem } from './service.js';
import { encrypt, decrypt, hash } from './security.js';
import { messageInfo } from '../shared/i18n/messages.js';
import { resetCountLabels, resetScope, type ResetState, type ResetView, type ResetResult } from '../shared/factory-reset.js';
type Rows = Record<string, any[]>;
type Inventory = {
    id: string;
    name: string;
    remote: Rows;
    local: Rows;
};
type Reset = {
    id: string;
    owner: string;
    ids: string[];
    state: ResetState;
    data: Inventory[];
    fingerprint: string;
    idle?: string;
    nonce?: string;
    error?: string;
    results?: ResetResult[];
};
const tables = ['memories', 'work_items', 'agent_sessions', 'notebook_cache', 'notebook_marks', 'notebook_writes', 'scheduled_tasks', 'schedule_retirements', 'login_tickets'];
export const scope = resetScope;
// Child collections are inventoried separately. Their removal must not make a
// parent look edited when retrying a partial reset. Other fields remain checked.
function recordFingerprint(value: Record<string, unknown>) {
    const { Tasks, Notes, subtasks, Subtasks, ...own } = value;
    return hash(JSON.stringify(own));
}
function taskOrder(tasks: any[]) {
    const ordered: any[] = [], done = new Set<string>(), visiting = new Set<string>();
    const visit = (task: any) => {
        if (done.has(task.uid))
            return;
        if (visiting.has(task.uid))
            throw new Problem(409, 'Görev ilişkileri doğrulanamadı; silme başlamadı.');
        visiting.add(task.uid);
        for (const child of tasks)
            if (task.id != null && (child.parent_task_id === task.id || child.recurring_parent_id === task.id))
                visit(child);
        visiting.delete(task.uid);
        done.add(task.uid);
        ordered.push(task);
    };
    for (const task of tasks)
        visit(task);
    return ordered;
}
export class FactoryReset {
    constructor(public rt: Runtime) { }
    get db() { return this.rt.db; }
    read(id: string): Reset {
        const row = this.db.prepare('SELECT json FROM factory_resets WHERE id=?').get(id);
        if (!row)
            throw new Problem(404, this.rt.office.t('Sıfırlama bulunamadı.'));
        const saved = JSON.parse(String(row.json));
        return { ...saved, data: JSON.parse(decrypt(saved.inventory, this.rt.office.config.secretKey, id + ':inventory')) };
    }
    load(id: string, owner: string): Reset {
        const r = this.read(id);
        if (r.owner !== owner)
            throw new Problem(403, this.rt.office.t('Önizleme başka sahip oturumuna ait.'));
        return r;
    }
    save(r: Reset) {
        const { data, ...metadata } = r;
        const inventory = encrypt(JSON.stringify(data), this.rt.office.config.secretKey, r.id + ':inventory');
        this.db.prepare('INSERT INTO factory_resets(id,json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(r.id, JSON.stringify({ ...metadata, inventory }));
    }
    backup(r: Reset) {
        const local = r.data.map(a => ({
            id: a.id,
            agent: this.db.prepare('SELECT id,workbook_uid,current_job,status FROM agents WHERE id=?').get(a.id),
            local: a.local,
            runs: this.db.prepare('SELECT * FROM runs WHERE agent_id=?').all(a.id),
            logs: this.db.prepare('SELECT * FROM run_logs WHERE run_id IN (SELECT id FROM runs WHERE agent_id=?)').all(a.id),
            approvals: this.db.prepare('SELECT * FROM approvals WHERE agent_id=?').all(a.id),
            commands: this.db.prepare('SELECT * FROM command_jobs WHERE run_id IN (SELECT id FROM runs WHERE agent_id=?)').all(a.id),
            director: this.rt.office.agent(a.id).builtin === 'director' ? Object.fromEntries(
                ['director_state', 'director_watches', 'director_redirects', 'director_actions', 'director_terminal', 'director_events', 'director_followups']
                    .map(table => [table, this.db.prepare(`SELECT * FROM ${table}`).all()]),
            ) : undefined,
        }));
        const backup = encrypt(JSON.stringify({ scope, date: new Date().toISOString(), data: r.data, local }), this.rt.office.config.secretKey, r.id);
        this.db.prepare('UPDATE factory_resets SET backup=? WHERE id=?').run(backup, r.id);
        decrypt(String(this.db.prepare('SELECT backup FROM factory_resets WHERE id=?').get(r.id)!.backup), this.rt.office.config.secretKey, r.id);
    }
    async adopt(id: string, owner: string) {
        const r = this.read(id);
        if (!r.owner.startsWith('director:') || r.state !== 'preview')
            throw new Problem(409, this.rt.office.t('Önizleme artık geçerli değil.'));
        r.owner = owner;
        r.data = await this.collect(r.ids);
        r.fingerprint = hash(JSON.stringify(r.data));
        this.save(r);
        this.backup(r);
        return this.view(r);
    }
    current(owner: string) {
        const id = this.db.prepare('SELECT reset_id FROM reset_gate').get()?.reset_id;
        return id ? this.view(this.load(String(id), owner)) : null;
    }
    localInventory(id: string): Rows {
        const a = this.rt.office.agent(id);
        const local: Rows = {};
        for (const t of tables)
            local[t] = this.db.prepare(`SELECT * FROM ${t} WHERE agent_id=? ORDER BY rowid`).all(id);
        local.schedule_history = this.db.prepare('SELECT h.* FROM schedule_history h JOIN scheduled_tasks t ON t.id=h.task_id WHERE t.agent_id=? ORDER BY h.rowid').all(id);
        local.approvals = this.db.prepare("SELECT * FROM approvals WHERE agent_id=? AND json_extract(json,'$.state') IN ('pending','approved','applying') ORDER BY rowid").all(id);
        local.command_jobs = this.db.prepare("SELECT * FROM command_jobs WHERE run_id IN (SELECT id FROM runs WHERE agent_id=?) AND json_extract(json,'$.state') IN ('pending','running') ORDER BY rowid").all(id);
        if (a.builtin === 'director')
            local.director_state = this.db.prepare('SELECT * FROM director_state').all();
        local.pending = this.db.prepare("SELECT id FROM runs WHERE agent_id=? AND state IN ('queued','running','waiting') ORDER BY id").all(id);
        local.content = this.db.prepare('SELECT id,summary,output,work_item_id FROM runs WHERE agent_id=? ORDER BY id').all(id);
        return local;
    }
    async collect(ids: string[]) {
        const result: Inventory[] = [];
        for (const id of ids) {
            const a = this.rt.office.agent(id);
            if (!a.tududi_user_id)
                throw new Problem(409, this.rt.office.t('{0}: hesap kapsamı doğrulanamadı.', [a.name]));
            const remote = await this.rt.office.tududi.resetInventory(this.rt.office.token(id), a.tududi_user_id);
            result.push({ id, name: a.name, remote, local: this.localInventory(id) });
        }
        return result;
    }
    view(r: Reset): ResetView {
        return {
            id: r.id, state: r.state, scope: this.rt.office.t(scope),
            error: r.error ? messageInfo(this.rt.office.language, r.error).error : undefined,
            backupReady: !!this.db.prepare('SELECT backup FROM factory_resets WHERE id=?').get(r.id)?.backup,
            results: r.results?.map(v => ({ ...v, remaining: v.remaining.map(text => messageInfo(this.rt.office.language, text).error) })),
            agents: r.data.map(a => ({
                id: a.id, name: a.name,
                counts: Object.fromEntries([...Object.entries(a.remote), ...Object.entries(a.local)].map(([k, v]) => [k, v.length])),
            })),
        };
    }
    async preview(owner: string, aid?: string) {
        if (this.rt.office.resetBlocked())
            throw new Problem(409, 'Süren sıfırlamayı tamamlayın.');
        const ids = aid ? [this.rt.office.agent(aid).id] : this.rt.office.store.agents().map(a => a.id);
        const data = await this.collect(ids);
        const r: Reset = { id: randomUUID(), owner, ids, state: 'preview', data, fingerprint: hash(JSON.stringify(data)) };
        this.save(r);
        try { this.backup(r); }
        catch (e) {
            this.db.prepare('DELETE FROM factory_resets WHERE id=?').run(r.id);
            throw e;
        }
        return this.view(r);
    }
    async execute(id: string, owner: string, confirmation: string) {
        const word = this.rt.office.language === 'en' ? 'RESET' : 'SIFIRLA';
        if (confirmation !== word)
            throw new Problem(400, this.rt.office.t('Tam olarak {0} yazın.', [word]));
        return this.rt.office.locked('factory-reset', async () => {
            const r = this.load(id, owner);
            if (r.state === 'completed')
                return this.view(r);
            const gate = this.db.prepare('SELECT reset_id FROM reset_gate').get();
            if (gate && gate.reset_id !== id)
                throw new Problem(409, 'Başka sıfırlama sürüyor.');
            this.db.prepare('INSERT OR IGNORE INTO reset_gate VALUES (1,?)').run(id);
            try {
                let deadline = Date.now() + 20000;
                while (this.rt.office.inFlight || this.rt.office.background.size) {
                    if (Date.now() > deadline)
                        throw new Problem(409, 'Önceki işlemler kapanmadı; silme başlamadı.');
                    await new Promise(resolve => setTimeout(resolve, 25));
                }
                if (r.state === 'preview') {
                    const data = await this.collect(r.ids);
                    if (hash(JSON.stringify(data)) !== r.fingerprint)
                        throw new Problem(409, 'Veriler değişti. Yeni önizleme alın; hiçbir kayıt silinmedi.');
                    this.backup(r);
                    r.state = 'quiescing';
                    this.save(r);
                }
                r.idle = undefined;
                r.nonce = randomUUID();
                this.save(r);
                for (const aid of r.ids)
                    this.rt.stop(aid);
                if (this.rt.office.config.runnerKey) {
                    deadline = Date.now() + 20000;
                    while (this.load(id, owner).idle !== this.rt.runnerId) {
                        if (Date.now() > deadline)
                            throw new Problem(409, 'Süreç kapanışı doğrulanamadı; silme başlamadı.');
                        await new Promise(resolve => setTimeout(resolve, 25));
                    }
                }
                else if (r.ids.some(aid => this.db.prepare('SELECT 1 FROM runs WHERE agent_id=? AND runner_id IS NOT NULL').get(aid)))
                    throw new Problem(409, 'Süreç kapanışı kanıtlanamadı.');
                const completed = new Map((r.results || []).filter(result => result.ok).map(result => [result.id, result]));
                r.state = 'deleting';
                r.results = [];
                this.save(r);
                for (const a of r.data) {
                    const prior = completed.get(a.id);
                    if (prior) {
                        r.results.push(prior);
                        this.save(r);
                        continue;
                    }
                    const errors: string[] = [];
                    let counts: Record<string, number> | null = null;
                    try {
                        const current = await this.rt.office.tududi.resetInventory(this.rt.office.token(a.id), this.rt.office.agent(a.id).tududi_user_id!);
                        for (const kind of ['Task', 'Note', 'Project']) {
                            const known = new Map(a.remote[kind].map(v => [v.uid, v]));
                            if (current[kind].some(v => !known.has(v.uid) || recordFingerprint(v) !== recordFingerprint(known.get(v.uid))))
                                throw new Problem(409, 'Yedekten sonra içerik değişti; yeni kayıtlar silinmedi.');
                            const ordered = kind === 'Task' ? taskOrder(current[kind]) : current[kind];
                            for (const v of ordered)
                                try {
                                    await this.rt.office.tududi.resetDelete(this.rt.office.token(a.id), kind, v.uid);
                                }
                                catch {
                                    errors.push(this.rt.office.t('{0} silinemedi: {1}', [this.rt.office.t(resetCountLabels[kind]), v.uid]));
                                }
                            if (errors.length)
                                break;
                        }
                        const left = await this.rt.office.tududi.resetInventory(this.rt.office.token(a.id), this.rt.office.agent(a.id).tududi_user_id!);
                        counts = Object.fromEntries(Object.entries(left).map(([k, v]) => [k, v.length]));
                        if (Object.values(left).some(v => v.length))
                            errors.push('Tududi kayıtları kaldı; sayıları kontrol edin.');
                        if (!errors.length)
                            this.clearLocal(a.id);
                        const local = this.localInventory(a.id);
                        for (const [kind, rows] of Object.entries(local)) {
                            if (kind === 'director_state') continue; // The retained settings/usage row is not an uncleared ledger.
                            counts[kind] = kind === 'content'
                                ? rows.filter(row => row.summary || row.output || row.work_item_id).length
                                : rows.length;
                        }
                    }
                    catch (e) {
                        errors.push(e instanceof Problem || e instanceof TududiError ? e.message : 'Listeleme başarısız.');
                    }
                    r.results.push({ id: a.id, name: a.name, ok: !errors.length, remaining: errors, counts });
                    this.save(r);
                }
                r.state = r.results.every(v => v.ok) ? 'completed' : 'partial';
                r.error = undefined;
                this.save(r);
                if (r.state === 'completed')
                    this.db.prepare('DELETE FROM reset_gate WHERE reset_id=?').run(id);
                this.rt.office.changed();
                return this.view(r);
            }
            catch (e) {
                r.error = e instanceof Problem || e instanceof TududiError ? e.message : 'İşlem tamamlanamadı.';
                this.save(r);
                if (r.state === 'preview')
                    this.db.prepare('DELETE FROM reset_gate WHERE reset_id=?').run(id);
                throw e;
            }
        });
    }
    clearLocal(aid: string) {
        this.db.exec('BEGIN');
        try {
            for (const t of tables)
                this.db.prepare(`DELETE FROM ${t} WHERE agent_id=?`).run(aid);
            this.db.prepare("DELETE FROM approvals WHERE agent_id=? AND json_extract(json,'$.state') IN ('pending','approved','applying')").run(aid);
            this.db.prepare("DELETE FROM command_jobs WHERE run_id IN (SELECT id FROM runs WHERE agent_id=?) AND json_extract(json,'$.state') IN ('pending','running')").run(aid);
            this.db.prepare("UPDATE runs SET state=CASE WHEN state IN ('queued','running','waiting') THEN 'stopped' ELSE state END,summary='',output='',reason='',work_item_id=NULL,session_action=NULL,work_options='{}',lease_hash=NULL,lease_expires=NULL WHERE agent_id=?").run(aid);
            this.db.prepare("DELETE FROM run_logs WHERE run_id IN (SELECT id FROM runs WHERE agent_id=?) AND kind NOT IN ('usage','tool_success')").run(aid);
            this.db.prepare("UPDATE run_logs SET text=substr(text,1,instr(text,':')) WHERE run_id IN (SELECT id FROM runs WHERE agent_id=?) AND kind='tool_success'").run(aid);
            this.db.prepare("UPDATE agents SET workbook_uid=NULL,current_job='',status=CASE WHEN active=1 THEN 'bosta' ELSE 'kapali' END WHERE id=?").run(aid);
            this.db.prepare('INSERT OR IGNORE INTO profile_deletions VALUES (?)').run(aid);
            if (this.rt.office.agent(aid).builtin === 'director') {
                this.db.prepare('UPDATE director_state SET json=? WHERE id=1').run(JSON.stringify({ auto: false, ledger: '', ledger_pending: false, last_batch: 0, terminal_enabled: this.rt.director.state().terminal_enabled, terminal_generation: (this.rt.director.state().terminal_generation || 1) + 1, terminal_usage: this.rt.director.state().terminal_usage, provider_selected: this.rt.director.state().provider_selected }));
                this.db.exec('DELETE FROM director_watches;DELETE FROM director_redirects;DELETE FROM director_actions;DELETE FROM director_terminal;DELETE FROM director_events;DELETE FROM director_followups');
            }
            this.db.exec('COMMIT');
        }
        catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
        if (this.rt.office.agent(aid).builtin === 'director')
            this.rt.terminal?.resetHistory();
    }
}
export function factoryResetRoutes(app: FastifyInstance, rt: Runtime) {
    const reset = new FactoryReset(rt);
    app.get('/api/factory-reset/current', async (req) => reset.current(req.ownerSession!));
    app.post('/api/factory-reset/preview', async (req) => { const b = z.object({ agent_id: z.string().uuid().optional() }).strict().parse(req.body); return reset.preview(req.ownerSession!, b.agent_id); });
    app.get<{
        Params: {
            id: string;
        };
    }>('/api/factory-reset/:id', async (req) => reset.view(reset.load(z.string().uuid().parse(req.params.id), req.ownerSession!)));
    app.post<{
        Params: {
            id: string;
        };
    }>('/api/factory-reset/:id/execute', async (req) => { const b = z.object({ confirmation: z.string() }).strict().parse(req.body); return reset.execute(z.string().uuid().parse(req.params.id), req.ownerSession!, b.confirmation); });
    app.get<{
        Params: {
            id: string;
        };
    }>('/api/factory-reset/:id/backup', async (req, reply) => { const id = z.string().uuid().parse(req.params.id); reset.load(id, req.ownerSession!); const b = reset.db.prepare('SELECT backup FROM factory_resets WHERE id=?').get(id)?.backup; if (!b)
        throw new Problem(404, 'Yedek yok.'); return reply.header('Content-Disposition', 'attachment; filename="sifirlama-yedegi.json"').type('application/json').send(decrypt(String(b), rt.office.config.secretKey, id)); });
    app.post('/api/runner/reset-idle', async (req) => { const b = z.object({ runner: z.string(), reset: z.string().uuid(), nonce: z.string().uuid() }).strict().parse(req.body); if (b.runner !== rt.runnerId || reset.db.prepare('SELECT reset_id FROM reset_gate').get()?.reset_id !== b.reset)
        throw new Problem(409, 'Kapanış onayı güncel değil.'); const r = reset.read(b.reset); if (r.nonce !== b.nonce)
        throw new Problem(409, 'Eski kapanış onayı.'); r.idle = b.runner; reset.save(r); return { ok: true }; });
}
