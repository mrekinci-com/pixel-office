import { localeFor } from "../shared/i18n/index.js";
import { statusLabels } from "../shared/types.js";
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { z } from 'zod';
import { newKey,hash } from './security.js';
import type { Runtime } from './runtime.js';
import { Problem } from './service.js';
import type { ManagementAction } from './director.js';
const uuid=z.string().uuid();
const inputSchema=z.object({text:z.string().trim().min(1).max(10000),mode:z.enum(['queue','interrupt']).default('queue')}).strict();
export function directorRoutes(app:FastifyInstance,rt:Runtime){
  const gm=rt.director;
  const ownerRequest=async(method:HTTPMethods,url:string,payload?:unknown)=>{
    // Only fixed routes below can be called. This private one-request owner session
    // shares every existing panel validator; it is never given to the CLI or client.
    const key=newKey(),digest=hash(key);rt.registerSecrets([key]);
    rt.db.prepare('INSERT INTO sessions VALUES (?,?)').run(digest,Date.now()+60000);
    try{
      const result=await app.inject({method,url,headers:{cookie:`ofis_session=${encodeURIComponent(app.signCookie(key))}`,'x-ofis-islem':'1'},...(payload===undefined?{}:{payload:payload as Record<string,unknown>})});
      const body=result.json();if(result.statusCode>=400)throw new Problem(result.statusCode,body.error || rt.office.t("Yönetim işlemi tamamlanamadı."));return body;
    }finally{rt.db.prepare('DELETE FROM sessions WHERE id_hash=?').run(digest);rt.forgetSecret(key);}
  };
  gm.dispatch=async(a:ManagementAction)=>{
    const v=a.veri;
    const id=()=>uuid.parse(a.kimlik),agent=()=>uuid.parse(a.ajan),uid=()=>encodeURIComponent(z.string().min(1).max(120).parse(a.kimlik));
    const mapped:Partial<Record<ManagementAction['islem'],()=>Promise<unknown>>>={
      ajan_hafiza_yaz:()=>ownerRequest('PUT',`/api/agents/${id()}/memory`,v),ajan_hesap_kur:()=>ownerRequest('POST',`/api/agents/${id()}/retry`,{}),oturum_yenile:()=>ownerRequest('POST',`/api/agents/${id()}/session/renew`,v),oturum_sifirla:()=>ownerRequest('POST',`/api/agents/${id()}/session/reset`,v),saglayici_surdur:()=>ownerRequest('POST','/api/runtime/providers/resume',v),
      bolum_olustur:()=>ownerRequest('POST','/api/departments',v),bolum_duzenle:()=>ownerRequest('PUT',`/api/departments/${id()}`,v),bolum_sirala:()=>ownerRequest('PUT','/api/departments/order',v),bolum_sil:()=>ownerRequest('DELETE',`/api/departments/${id()}?trash=1`),
      ajan_olustur:()=>ownerRequest('POST','/api/agents',v),ajan_duzenle:()=>ownerRequest('PUT',`/api/agents/${id()}`,v),
      ajan_sil:()=>{const q=z.object({account:z.enum(['keep','delete']).default('keep'),profile:z.enum(['keep','delete']).default('keep')}).strict().parse(v);return ownerRequest('DELETE',`/api/agents/${id()}?account=${q.account}&profile=${q.profile}&trash=1`);},
      ajan_calistir:()=>{const {secenekler,is,kaynaklar,kabul,...body}=v;return ownerRequest('POST',`/api/agents/${id()}/run`,{...body,secenekler});},ajan_durdur:()=>ownerRequest('POST',`/api/agents/${id()}/stop`,{}),
      calisma_durdur:()=>ownerRequest('POST',`/api/runs/${id()}/stop`,{}),zincir_durdur:()=>ownerRequest('POST',`/api/chains/${id()}/stop`,{}),kuyruk_iptal:()=>ownerRequest('POST',`/api/runs/${id()}/cancel`,{}),kuyruk_one_al:()=>ownerRequest('POST',`/api/runs/${id()}/priority`,{}),tumunu_durdur:()=>ownerRequest('POST','/api/runtime/stop',{}),
      baglanti_ata:async()=>{const b=z.object({agent_ids:z.array(uuid).max(100)}).strict().parse(v),l=rt.links().find(l=>l.id===id());if(!l || l.validation!=='valid')throw new Problem(400,rt.office.t("Önce doğrulanmış bir klasör bağlantısı seçin."));const {id:lid,validation,detail,documents,documents_truncated,...body}=l;return ownerRequest('PUT',`/api/links/${lid}`,{...body,...b});},
      klasor_oner:()=>ownerRequest('POST','/api/links',v),komut_olustur:()=>ownerRequest('POST','/api/commands',v),komut_duzenle:()=>ownerRequest('PUT',`/api/commands/${id()}`,v),komut_sil:()=>ownerRequest('DELETE',`/api/commands/${id()}`),
      zamanlama_olustur:()=>ownerRequest('POST','/api/schedules',v),zamanlama_duzenle:()=>ownerRequest('PUT',`/api/schedules/${id()}`,v),zamanlama_sil:()=>ownerRequest('DELETE',`/api/schedules/${id()}`),zamanlama_calistir:()=>ownerRequest('POST',`/api/schedules/${id()}/run`,{}),
      gorev_ekle:()=>ownerRequest('POST',`/api/agents/${agent()}/tasks`,v),gorev_guncelle:()=>ownerRequest('PATCH',`/api/agents/${agent()}/tasks/${uid()}`,v),proje_ekle:()=>ownerRequest('POST',`/api/agents/${agent()}/projects`,v),proje_duzenle:()=>ownerRequest('PUT',`/api/agents/${agent()}/projects/${uid()}`,v),not_ekle:()=>ownerRequest('POST',`/api/agents/${agent()}/notes`,v),not_duzenle:()=>ownerRequest('PUT',`/api/agents/${agent()}/notes/${uid()}`,v),not_isaretle:()=>ownerRequest('PUT',`/api/agents/${agent()}/notes/${uid()}/mark`,v),
      ortak_not_yaz:()=>ownerRequest('POST','/api/shared-notebook',v),ortak_not_isaretle:()=>ownerRequest('PUT',`/api/shared-notebook/${uid()}/mark`,v),kurallar_duzenle:()=>ownerRequest('PUT','/api/rules',v),ayarlar_duzenle:()=>ownerRequest('PUT','/api/runtime/settings',v),geri_al:()=>ownerRequest('POST',`/api/trash/${id()}/restore`,{}),
    };
    const action=mapped[a.islem];if(!action)throw new Problem(400,rt.office.t("Yönetim işlemi geçersiz."));return action();
  };
  app.get('/api/director',async req=>{
    const q=z.object({after:z.coerce.number().int().nonnegative().default(0),before:z.coerce.number().int().positive().optional()}).parse(req.query);
    const aid=gm.agent().id;
    const initial=q.after===0 && !q.before;
    const logs=rt.db.prepare(`SELECT * FROM director_terminal WHERE id>? ${q.before?'AND id<?':''} ORDER BY id ${q.before || initial?'DESC':'ASC'} LIMIT 300`).all(q.after,...(q.before?[q.before]:[]));
    if(q.before || initial)logs.reverse();
    return {director:gm.snapshot(),agent:gm.agent(),session:rt.a3.session(aid),logs:rt.scrubValue(logs),has_older:logs.length>0 && !!rt.db.prepare('SELECT 1 FROM director_terminal WHERE id<?').get(logs[0].id)};
  });
  // The terminal replaces the legacy direct chat. Include older messages beyond
  // the snapshot's 500-row limit; approvals and other conversations are untouched.
  app.post('/api/director/read',async()=>{
    const aid=gm.agent().id,now=new Date().toISOString();
    const conversation=`recipient_type='agent' AND recipient_id=?
      AND (sender_type IN ('agent','system') OR sender_agent_id IS NOT NULL)`;
    const result=rt.db.prepare(`INSERT OR IGNORE INTO message_reads(message_id,reader_id,read_at)
      SELECT id,'owner',? FROM messages WHERE ${conversation}`).run(now,aid);
    if(result.changes){
      rt.db.prepare(`UPDATE messages SET read_at=COALESCE(read_at,?) WHERE ${conversation}`).run(now,aid);
      rt.office.changed();
    }
    return {ok:true,read:Number(result.changes)};
  });
  app.post('/api/director/input',async req=>{
    const b=inputSchema.parse(req.body),aid=gm.agent().id;
    if(b.text.startsWith('/'))return command(b.text);
    if(rt.terminal?.enabled)throw new Problem(409,rt.office.t("Mesajınızı gerçek terminale yazın. Akış görünümü olayları gösterir."));
    await rt.office.provision(aid);
    if(b.mode==='interrupt')for(const r of rt.runs().filter(r=>r.agent_id===aid && r.state==='running'))rt.finish(r.id,'stopped','',rt.office.t("Sahibi yeni girdiyle araya girdi."));
    const m=rt.office.message(null,'agent',aid,b.text);return {message:m,queued:true};
  });
  const command=async(text:string)=>{
    const [rawName,...args]=text.trim().split(/\s+/);
    const aliases:Record<string,string>={'/status':'/durum','/agents':'/ajanlar','/queue':'/kuyruk','/usage':'/kullanim','/approvals':'/onaylar','/auto':'/oto','/stop':'/durdur','/renew':'/yenile','/continue':'/devam','/help':'/yardim'};
    const name=aliases[rawName] || rawName,rawValue=args.join(' '),value=name==='/oto' ? ({on:'aç',off:'kapat'} as Record<string,string>)[rawValue] || rawValue : name==='/durdur' && rawValue==='all' ? 'hepsi' : rawValue;let result:unknown;
    switch(name){
      case '/durum':result=gm.summary();break;
      case '/ajanlar':result=gm.summary().ajanlar;break;
      case '/kuyruk':result=gm.summary().kuyruk;break;
      case '/kullanim':result=await gm.read({alan:'kullanim'});break;
      case '/onaylar':result=gm.summary().onaylar;break;
      case '/oto':if(!['aç','ac','kapat'].includes(value))throw new Problem(400,rt.office.t("/oto aç veya /oto kapat yazın."));result=gm.setAuto(value!=='kapat');break;
      case '/durdur':if(value==='hepsi'){rt.stop();result={bilgi:rt.office.t("Tüm çalışmalar durduruldu; otomatik mod kapandı.")};}else{const a=value ? rt.office.store.agents().find(a=>a.id===value || a.name.toLocaleLowerCase('tr-TR')===value.toLocaleLowerCase('tr-TR') || a.username===value) : gm.agent();if(!a)throw new Problem(404,rt.office.t("Ajan bulunamadı. Adını veya kullanıcı adını yazın."));rt.stop(a.id);result={bilgi:rt.office.t("{0} durduruldu.", [a.name])};}break;
      case '/yenile':{if(rt.runs().some(r=>r.agent_id===gm.agent().id && r.state==='running'))throw new Problem(409,rt.office.t("Önce çalışan Genel Müdür turunu durdurun veya bitmesini bekleyin."));rt.a3.rotate(gm.agent().id);result={bilgi:rt.office.t("Konuşma yenilendi; durum defteri ve bütün terminal geçmişi korundu.")};break;}
      case '/devam':result=gm.resumeBudget();break;
      case '/yardim':result={bilgi:rt.office.t("/durum · /ajanlar · /kuyruk · /kullanim · /onaylar · /durdur [ajan|hepsi] · /oto aç|kapat · /yenile · /devam · /yardim. Yalnız /devam kalan iş için model turu açar.")};break;
      default:throw new Problem(400,rt.office.t("Komut bulunamadı. /yardim yazın."));
    }
    const office=gm.summary(),agentName=(id:string)=>rt.office.store.agent(id)?.name || rt.office.t("Eski ajan");
    let display:string;
    switch(name){
      case '/durum':display=rt.office.t("{0} ajan · {1} çalışıyor · {2} sırada · {3} onay bekliyor\n{4}\nBugünkü toplam: {5} token · Oto {6}", [office.ajanlar.length, office.kuyruk.filter(r=>r.state==='running').length, office.kuyruk.filter(r=>r.state==='queued').length, office.onaylar.length, office.ajanlar.map(a=>`${a.ad}: ${rt.office.t(statusLabels[a.durum])}${a.is?' · '+a.is:''}`).join('\n'), office.kullanim.total_tokens.toLocaleString(localeFor(rt.office.language)), office.otomatik.auto?rt.office.t("açık"):rt.office.t("kapalı")]);break;
      case '/ajanlar':display=office.ajanlar.map(a=>`${a.ad} · ${rt.office.t(statusLabels[a.durum])} · ${a.kimlik}`).join('\n');break;
      case '/kuyruk':display=office.kuyruk.map(r=>`${agentName(r.agent_id)}: ${r.state==='running'?rt.office.t("Çalışıyor"):rt.office.t("Sırada")} · ${r.summary}`).join('\n') || rt.office.t("Sırada veya çalışan iş yok.");break;
      case '/onaylar':display=office.onaylar.map(a=>`${a.baslik} · ${a.sahibe_ayrilmis?rt.office.t("Sizin kararınız"):rt.office.t("Ofis içi karar")}`).join('\n') || rt.office.t("Bekleyen onay yok.");break;
      case '/kullanim':display=rt.office.store.agents().map(a=>{const u=rt.totals(a.id);return rt.office.t("{0}: {1} toplam token · ağırlıklı {2} · önbellekli {3} · önbelleksiz {4}", [a.name, u.total_tokens.toLocaleString(localeFor(rt.office.language)), u.weighted_tokens.toLocaleString(localeFor(rt.office.language)), u.cached_input_tokens.toLocaleString(localeFor(rt.office.language)), u.uncached_input_tokens.toLocaleString(localeFor(rt.office.language))]);}).join('\n');break;
      default:display=result && typeof result==='object' && 'bilgi' in result?String(result.bilgi):name==='/oto'?rt.office.t("Otomatik mod {0}.", [gm.state().auto?rt.office.t("açık"):rt.office.t("kapalı")]):JSON.stringify(result,null,2);
    }
    gm.entry('local',`${text}\n${display}`);
    const m=rt.office.message(null,'agent',gm.agent().id,`${text}\n${JSON.stringify(result,null,2)}`,true,'system');
    rt.office.event(gm.agent().id,'director_command',rt.office.t("Genel Müdür terminali: {0} (model çağrısı yok).", [name]));return {local:true,result,message:m};
  };
  app.put('/api/director/ledger',async req=>gm.ledger(z.object({metin:z.string().max(8000)}).strict().parse(req.body).metin));
  app.post('/api/director/auto',async req=>{const b=z.object({enabled:z.boolean()}).strict().parse(req.body);return gm.setAuto(b.enabled);});
  app.get('/api/trash',async()=>gm.trashList());
  app.post('/api/trash/:id/restore',async req=>gm.restore(uuid.parse((req.params as {id:string}).id)));
  for(const [action,state] of [['stop','stopped'],['cancel','stopped']] as const)app.post(`/api/runs/:id/${action}`,async req=>{const r=rt.run(uuid.parse((req.params as {id:string}).id));if(action==='cancel' && r.state!=='queued')throw new Problem(409,rt.office.t("Yalnız sıradaki iş iptal edilebilir."));rt.finish(r.id,state,'',rt.office.t("Sahibi çalışmayı durdurdu."));return {ok:true};});
  app.post('/api/runs/:id/priority',async req=>{const r=rt.run(uuid.parse((req.params as {id:string}).id));if(r.state!=='queued')throw new Problem(409,rt.office.t("Yalnız sıradaki iş öne alınabilir."));rt.db.prepare('UPDATE runs SET priority=priority+1 WHERE id=?').run(r.id);rt.office.changed();return {ok:true};});
  app.post('/api/chains/:id/stop',async req=>{const id=uuid.parse((req.params as {id:string}).id);if(!rt.db.prepare('SELECT 1 FROM chains WHERE id=?').get(id))throw new Problem(404,rt.office.t("İş zinciri bulunamadı."));rt.stopChain(id,rt.office.t("Sahibi iş zincirini durdurdu."));return {ok:true};});
  app.post('/api/notices/:id/dismiss',async req=>{const id=uuid.parse((req.params as {id:string}).id);rt.db.prepare('INSERT OR IGNORE INTO dismissed_notices VALUES (?)').run(id);rt.office.changed();return {ok:true};});
}
