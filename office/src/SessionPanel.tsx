import { t as tx, locale } from "./i18n";
import { useEffect,useRef,useState } from 'react';
import type { Agent,Snapshot } from '../shared/types';
import type { AgentSession,RunLog } from '../shared/runtime';
import { api } from './api';
import type { Perform } from './chat/ChatPanel';
export function TududiLogin({agent,perform,disabled,prominent=false}:{agent:Agent;perform:Perform;disabled:boolean;prominent?:boolean}) {
  const [credentialsLink,setCredentialsLink] = useState('');
  const lastVowel = agent.name.toLocaleLowerCase(locale()).match(/[aeıioöuü]/g)?.at(-1) || 'i';
  const suffix = /[aı]/.test(lastVowel) ? 'ın' : /[ou]/.test(lastVowel) ? 'un' : /[öü]/.test(lastVowel) ? 'ün' : 'in';
  const [fallback,setFallback] = useState(false), [password,setPassword] = useState(''), [credentials,setCredentials] = useState<{email:string;password:string;url:string}|null>(null);
  useEffect(()=>{setFallback(false);setPassword('');setCredentials(null);setCredentialsLink('');},[agent.id]);
  return <div className="tududi-login">
    <button className={prominent ? 'primary' : 'secondary'} disabled={disabled || agent.tududi_state !== 'ready'} onClick={() => {
      const tab = window.open('about:blank','_blank'); if (tab) tab.opener = null;
      void perform(async () => {
        try { const link = await api<{url?:string;fallback?:boolean}>(`/agents/${agent.id}/tududi-link`,'POST',{});
          if (link.url) { const url = new URL(link.url,window.location.href).href; if (tab) tab.location.href = url; else setCredentialsLink(url); }
          else {tab?.close();setFallback(true);}
        } catch(e) {tab?.close();throw e;}
      });
    }}>{prominent ? tx("{0}'{1}{2} Tududi panelini aç ↗", [agent.name, /[aeıioöuü]$/i.test(agent.name) ? 'n' : '', suffix]) : tx("Tududi paneli")}</button>
    {credentialsLink && <a href={credentialsLink} target="_blank" rel="noreferrer">{tx("Tududi paneli ↗")}</a>}
    {fallback && <form onSubmit={e => {e.preventDefault();void perform(async () => {setCredentials(await api(`/agents/${agent.id}/tududi-credentials`,'POST',{password}));setPassword('');});}}>
      <p>{agent.tududi_email}</p><label>{tx("Giriş bilgilerini göstermek için Ofis şifreniz")}<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
      <button className="secondary" disabled={disabled}>{tx("Giriş bilgilerini göster")}</button>
      {credentials && <div><label>{tx("E-posta")}<input readOnly value={credentials.email} /></label><label>{tx("Ajanın şifresi")}<input readOnly value={credentials.password} /></label><a href={credentials.url} target="_blank" rel="noreferrer">{tx("Tududi giriş sayfasını aç")}</a><button type="button" onClick={() => {setCredentials(null);setFallback(false);}}>{tx("Bilgileri gizle")}</button></div>}
    </form>}
  </div>;
}
export function SessionPanel({agent,data,perform,disabled}:{agent:Agent;data:Snapshot;perform:Perform;disabled:boolean}) {
  const [session,setSession] = useState<AgentSession|undefined>(data.runtime?.sessions?.find(s => s.agent_id === agent.id)), [logs,setLogs] = useState<RunLog[]>([]),[text,setText] = useState(''),[reset,setReset] = useState(false),[error,setError] = useState(''),[selected,setSelected]=useState('');
  const scroll = useRef<HTMLDivElement>(null),nearBottom = useRef(true);
  useEffect(() => {
    let alive = true,loading = false;
    const update = async () => { if (loading) return; loading = true; try {const r = await api<{session:AgentSession;logs:RunLog[]}>(`/agents/${agent.id}/session${selected ? '?key='+encodeURIComponent(selected) : ''}`);if(alive){setSession(r.session);setLogs(r.logs);setError('');}}catch {if(alive)setError(tx("Oturum dökümü alınamadı."));}finally {loading=false;}};
    void update();const timer=setInterval(()=>void update(),1500);return()=>{alive=false;clearInterval(timer);};
  },[agent.id,selected]);
  useEffect(()=>{if(scroll.current && nearBottom.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[logs]);
  const labels:Record<string,string>={input:tx("Yeni istek"),text:tx("Ajan"),tool:tx("Araç"),tool_success:tx("Araç tamamlandı"),command_result:tx("Komut sonucu"),git_change:tx("Dosya farkı"),finish:tx("Tur sonucu"),diagnostic:tx("Çalışma ayrıntısı"),context:tx("Girdi bilgisi"),turn:tx("Tur"),usage:tx("Kullanım")};
  return <section className="session-panel" aria-label={tx("Canlı oturum")}>
    <div className="runtime-actions"><h3>{tx("Oturum")}</h3><button className="danger-button" disabled={disabled} onClick={()=>void perform(async()=>{await api(`/agents/${agent.id}/stop`,'POST',{});})}>{tx("Durdur")}</button></div>
    <p className="field-help">{agent.session_mode === 'single' ? tx("Tek seferlik çalışma") : agent.session_mode==='persistent' ? tx("Kalıcı konuşma") : tx("İş başına oturum")} · {session?.turns || 0} {tx("tur ·")} {session?.input_tokens.toLocaleString(locale()) || 0} {tx("girdi token ·")} {session?.renewals || 0} {tx("yenileme ·")} {session ? Math.max(0,Math.floor((Date.now()-Date.parse(session.created_at))/60000)) : 0} {tx("dakika ·")} {Math.round((session?.bytes || 0)/1024)} KB</p>
    {agent.session_mode==='work' && <label>{tx("Gösterilen iş")}<select value={selected} onChange={e=>setSelected(e.target.value)}><option value="">{tx("Son çalışılan iş")}</option>{data.runtime?.sessions?.filter(s=>s.agent_id===agent.id).map(s=><option key={s.session_key || s.generation} value={s.session_key}>{data.runtime?.runs.find(r=>r.work_item_id===s.work_item_id)?.summary.slice(0,80) || tx("Sohbet")}{s.closed ? tx(" · Kapandı") : ''}</option>)}</select></label>}
    <p className="field-help">{tx("Son tek isteğin bağlamı:")} {session?.last_input_tokens_known ? (session.last_input_tokens || 0).toLocaleString(locale())+' token' : tx("Bilinmiyor")} {tx("· Yenilemeye kalan:")} {Math.max(0,(agent.policy?.sessionTurnLimit ?? data.runtime?.settings.sessionTurnLimit ?? 12)-(session?.turns || 0)).toLocaleString(locale())} {tx("tur /")} {Math.max(0,(agent.policy?.sessionTokenLimit ?? data.runtime?.settings.sessionTokenLimit ?? 150000)-(session?.last_input_tokens || 0)).toLocaleString(locale())} {tx("bağlam token")}{session?.closed ? tx(" · Oturum kapandı; yeni girdi iş notundan devam eder.") : ''}</p>
    {error && <p role="status">{error}</p>}
    <div className="session-transcript" ref={scroll} role="log" aria-label={tx("Oturum dökümü")} onScroll={e=>{nearBottom.current=e.currentTarget.scrollHeight-e.currentTarget.clientHeight-e.currentTarget.scrollTop<48;}}>
      {logs.length ? logs.filter(l=>l.kind!=='context' && l.kind!=='usage').map(l=><article key={l.id}><small>{labels[l.kind] || tx("Olay")}</small><pre>{l.text}</pre></article>) : <p>{tx("İlk çalışma başlayınca döküm burada görünür.")}</p>}
    </div>
    <form onSubmit={e=>{e.preventDefault();void perform(async()=>{await api(`/agents/${agent.id}/session/input`,'POST',{text,mode:'queue',session_key:session?.session_key});setText('');});}}>
      <label>{tx("Bu oturuma yaz")}<textarea value={text} onChange={e=>setText(e.target.value)} rows={2} maxLength={10000} required /></label>
      <div className="runtime-actions"><button className="primary" disabled={disabled || !text.trim()}>{tx("Sıraya ekle")}</button><button type="button" className="secondary" disabled={disabled || !text.trim()} onClick={()=>void perform(async()=>{await api(`/agents/${agent.id}/session/input`,'POST',{text,mode:'interrupt',session_key:session?.session_key});setText('');})}>{tx("Araya gir")}</button>{agent.session_mode==='work' && <button type="button" className="secondary" disabled={disabled || !text.trim()} onClick={()=>void perform(async()=>{await api(`/agents/${agent.id}/session/input`,'POST',{text,mode:'new'});setText('');setSelected('');})}>{tx("Yeni iş olarak gönder")}</button>}</div>
    </form>
    <div className="runtime-actions"><button className="secondary" disabled={disabled || agent.session_mode==='single' || session?.renewing} onClick={()=>void perform(async()=>{await api(`/agents/${agent.id}/session/renew`,'POST',{session_key:session?.session_key});})}>{session?.renewing ? tx("Özet hazırlanıyor…") : tx("Oturumu yenile")}</button><button className="secondary" disabled={disabled} onClick={()=>setReset(true)}>{tx("Oturumu sıfırla")}</button></div>
    {reset && <div className="hint"><p>{tx("Konuşma silinecek. Hafıza ve Tududi çalışma defteri korunacak.")}</p><button className="danger-button" disabled={disabled} onClick={()=>void perform(async()=>{await api(`/agents/${agent.id}/session/reset`,'POST',{session_key:session?.session_key});setReset(false);})}>{tx("Konuşmayı sil")}</button><button onClick={()=>setReset(false)}>{tx("Vazgeç")}</button></div>}
    <TududiLogin agent={agent} perform={perform} disabled={disabled} />
  </section>;
}
