import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Runtime } from './runtime.js';
import { newKey, hash, equals } from './security.js';
import { Problem } from './service.js';
import { privateAddress } from './tududi-proxy.js';
export function accessRoutes(app: FastifyInstance, rt: Runtime) {
  app.post<{Params:{id:string}}>('/api/agents/:id/tududi-link',async req => {
    const aid = z.string().uuid().parse(req.params.id); rt.office.agent(aid);
    const target = rt.office.config.tududiPublicUrl;
    if (!target) return { fallback:true,email:rt.office.agent(aid).tududi_email };
    const destination = new URL(target), host = new URL(rt.office.config.publicOrigin || `${req.protocol}://${req.headers.host}`).hostname;
    const officeUrl=new URL(rt.office.config.publicOrigin || `${req.protocol}://${req.headers.host}`);
    if (destination.hostname !== host || !privateAddress(destination.hostname) || destination.protocol!==officeUrl.protocol) return {fallback:true,email:rt.office.agent(aid).tududi_email};
    const ticket = newKey();
    rt.db.prepare('DELETE FROM login_tickets WHERE expires_at<?').run(Date.now());
    rt.db.prepare('INSERT INTO login_tickets VALUES (?,?,?,?)').run(hash(ticket),aid,req.ownerSession!,Date.now()+60000);
    return { url:`/api/tududi/open?ticket=${encodeURIComponent(ticket)}` };
  });
  app.get('/api/tududi/open',async (req,reply) => {
    const b = z.object({ticket:z.string().min(20).max(120)}).strict().parse(req.query);
    const row = rt.db.prepare('DELETE FROM login_tickets WHERE ticket_hash=? AND owner_hash=? AND expires_at>? RETURNING agent_id').get(hash(b.ticket),req.ownerSession!,Date.now());
    if (!row) throw new Problem(410,rt.office.t("Geçiş bağlantısı kullanılmış veya süresi dolmuş. Yeniden açın."));
    const aid = row.agent_id as string, a = rt.office.agent(aid), password = await rt.office.password(aid);
    const cookie = await rt.office.tududi.login(a.tududi_email,password);
    const values = cookie.split('; ').map(v => { const at = v.indexOf('='); return {name:v.slice(0,at),value:v.slice(at+1)}; });
    if (values.some(v => !/^[A-Za-z0-9_.-]+$/.test(v.name) || v.name === 'ofis_session')) throw new Problem(502,rt.office.t("Tududi oturum çerezi geçersiz."));
    for (const v of values) reply.setCookie(v.name,decodeURIComponent(v.value),{path:'/',httpOnly:true,sameSite:'lax',secure:rt.office.config.secureCookie,maxAge:3600});
    reply.header('Cache-Control','no-store');
    reply.header('Referrer-Policy','no-referrer');
    return reply.redirect(rt.office.config.tududiPublicUrl!,303);
  });
  app.post<{Params:{id:string}}>('/api/agents/:id/tududi-credentials',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async (req,reply) => {
    reply.header('Cache-Control','no-store');
    const b = z.object({password:z.string().max(1024)}).strict().parse(req.body);
    if (!equals(b.password,rt.office.config.ownerPassword)) throw new Problem(401,rt.office.t("Ofis şifresi yanlış."));
    const id = z.string().uuid().parse(req.params.id);
    const email=rt.office.agent(id).tududi_email, url=new URL('/login',rt.office.config.tududiPublicUrl || 'http://127.0.0.1:9393');url.searchParams.set('email',email);
    return { email,password:await rt.office.password(id),url:url.href };
  });
}
