import { t as tx, locale } from "./i18n";
import { useEffect,useRef,useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { Snapshot,Agent } from '../shared/types';
import type { AgentSession,RunLog } from '../shared/runtime';
import type { DirectorSnapshot } from '../shared/director';
import { api } from './api';
import { toolSummary } from '../shared/runtime';
import './director.css';
import { CodexTerminal,terminalStatusLabels } from './CodexTerminal';
import type { TerminalSnapshot } from '../shared/terminal';
interface Transcript {director:DirectorSnapshot;agent:Agent;session:AgentSession;logs:RunLog[];has_older:boolean;}
type Mode='hidden'|'open'|'minimized';
const read=(key:string,fallback:string)=>{try{return localStorage.getItem(key) || fallback;}catch{return fallback;}};
const save=(key:string,value:string)=>{try{localStorage.setItem(key,value);}catch{/* Browser storage may be unavailable. */}};
const labels:Record<string,string>={get input() { return tx("Siz"); },get text() { return tx("Genel Müdür"); },get tool() { return tx("▸ Araç"); },get tool_success() { return tx("✓ Araç tamamlandı"); },get management_result() { return tx("▸ Yönetim sonucu"); },get command_result() { return tx("▸ Komut sonucu"); },get acceptance_result() { return tx("▸ Kabul ölçütü"); },get error() { return tx("Hata"); },get finish() { return tx("Tur sonucu"); },get git_change() { return tx("▸ Dosya değişikliği"); },get local() { return tx("Komut"); },get notice() { return tx("Bilgi"); },get budget_stop() { return tx("Devam kararı"); },get budget_wrap() { return tx("Bütçe uyarısı"); },get budget_wrap_delivered() { return tx("Toparlama girdisi"); }};
function readable(log:RunLog){
  if(log.kind==='tool')return tx(toolSummary(log.text));
  if(log.kind==='management_result'){try{const v=JSON.parse(log.text);return (v.ozet || v.arac.replaceAll('_',' '))+(v.sonuc?.neden ? ' · '+v.sonuc.neden : '');}catch{return log.text.slice(0,350);}}
  return log.text;
}
export function DirectorTerminal({data,disabled=false,onApprovals,onChanged}:{data:Snapshot;disabled?:boolean;onApprovals:()=>void;onChanged:()=>Promise<void>}){
  const [mode,setMode]=useState<Mode>(()=>{const v=read('po-gm-window','hidden');return v==='open' || v==='minimized'?v:'hidden';});
  const [pageVisible,setPageVisible]=useState(()=>!document.hidden);
  const changed=useRef(onChanged);changed.current=onChanged;
  const [tab,setTab]=useState<'terminal'|'flow'>('terminal');
  const [pty,setPty]=useState<TerminalSnapshot>({enabled:false,status:'disconnected',generation:1,usageKnown:false});
  const [text,setText]=useState(()=>read('po-gm-draft',''));
  const [full,setFull]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[loaded,setLoaded]=useState(false),[transcript,setTranscript]=useState<Transcript|null>(null),[logs,setLogs]=useState<RunLog[]>([]);
  const [geometry,setGeometry]=useState(()=>{try{const g=JSON.parse(read('po-gm-geometry','null'));if(g && ['x','y','width','height'].every(k=>Number.isFinite(g[k])))return g as {x:number;y:number;width:number;height:number};}catch{}return {x:Math.max(12,(window.innerWidth-880)/2),y:80,width:880,height:Math.min(600,window.innerHeight-100)};});
  const [seen,setSeen]=useState(()=>Number(read('po-gm-seen','0')) || 0);
  const scroll=useRef<HTMLDivElement>(null),nearBottom=useRef(true),panel=useRef<HTMLDivElement>(null),draft=useRef<HTMLTextAreaElement>(null),cursor=useRef(0),loading=useRef(false),again=useRef(false),alive=useRef(true);
  const modeRef=useRef(mode);modeRef.current=mode;
  const current=transcript?.director || data.runtime?.director;
  const pendingApprovals=data.runtime?.approvals.filter(a=>a.state==='pending').length || 0;
  const messageKey=data.messages.filter(m=>m.recipient_type==='agent' && m.recipient_id===current?.agent_id).map(m=>m.id).join(',');
  const running=transcript ? transcript.agent.status==='calisiyor' : data.runtime?.runs.some(r=>r.agent_id===current?.agent_id && r.state==='running');
  const pendingAgent=transcript?.agent || data.agents.find(a=>a.id===current?.agent_id);
  const pending=pendingAgent?.tududi_state==='pending';
  const status=tab==='terminal' || pty.enabled ? terminalStatusLabels[pty.status] : pending ? tx("Tududi hesabı bekliyor") : running ? tx("Çalışıyor…") : current?.status || tx("Sizi bekliyor");
  useEffect(()=>{save('po-gm-window',mode);if(mode==='open')draft.current?.focus();},[mode]);
  useEffect(()=>{save('po-gm-draft',text);},[text]);
  useEffect(()=>{
    const update=()=>setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange',update);
    return()=>document.removeEventListener('visibilitychange',update);
  },[]);
  useEffect(()=>{
    if(mode!=='open' || !pageVisible)return;
    let active=true;
    void api<{read:number}>('/director/read','POST',{}).then(async result=>{
      if(active && result.read>0)await changed.current();
    }).catch(e=>{if(active)setError((e as Error).message);});
    return()=>{active=false;};
  },[mode,pageVisible,messageKey]);
  useEffect(()=>{save('po-gm-geometry',JSON.stringify(geometry));},[geometry]);
  useEffect(()=>{save('po-gm-seen',String(seen));},[seen]);
  const reload=async()=>{
    if(loading.current){again.current=true;return;}loading.current=true;
    try{do{again.current=false;const r=await api<Transcript>(`/director?after=${cursor.current}`);if(!alive.current)return;setTranscript(old=>({...r,has_older:cursor.current>0 ? old?.has_older || false : r.has_older}));setLogs(old=>{const ids=new Set(old.map(l=>l.id));return [...old,...r.logs.filter(l=>!ids.has(l.id))];});cursor.current=Math.max(cursor.current,...r.logs.map(l=>l.id));setLoaded(true);if(r.logs.length===300 && cursor.current>0)again.current=true;}while(again.current && alive.current);}catch(e){if(alive.current)setError((e as Error).message);}finally{loading.current=false;}
  };
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  // Parent receives server SSE updates even when the window is closed or another page is open.
  useEffect(()=>{if(data.runtime?.director)void reload();},[data]);
  useEffect(()=>{
    const open=()=>setMode('open');const key=(e:KeyboardEvent)=>{if(e.ctrlKey && e.shiftKey && e.code==='KeyG'){e.preventDefault();open();}else if(e.key==='Escape' && modeRef.current==='open' && panel.current?.contains(document.activeElement) && !(document.activeElement as HTMLElement)?.closest('.gm-codex')){e.preventDefault();setMode('minimized');}};
    const update=()=>void reload();window.addEventListener('office:live-update',update);
    window.addEventListener('office:director-screen',open);window.addEventListener('office:director-open',open);window.addEventListener('keydown',key);
    return()=>{window.removeEventListener('office:live-update',update);window.removeEventListener('office:director-screen',open);window.removeEventListener('office:director-open',open);window.removeEventListener('keydown',key);};
  },[]);
  useEffect(()=>{if(mode==='open' && nearBottom.current && scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;if(mode==='open' && pageVisible)setSeen(cursor.current);},[logs,mode,pageVisible]);
  useEffect(()=>{const clamp=()=>setGeometry(g=>({...g,x:Math.max(0,Math.min(g.x,window.innerWidth-280)),y:Math.max(0,Math.min(g.y,window.innerHeight-80))}));window.addEventListener('resize',clamp);return()=>window.removeEventListener('resize',clamp);},[]);
  useEffect(()=>{if(mode!=='open' || full || !panel.current)return;const el=panel.current;const observer=new ResizeObserver(()=>{if(matchMedia('(max-width: 700px)').matches)return;const box=el.getBoundingClientRect();setGeometry(g=>g.width===box.width && g.height===box.height ? g : {...g,width:box.width,height:box.height});});observer.observe(el);return()=>observer.disconnect();},[mode,full]);
  const act=async(fn:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await fn();await reload();await onChanged();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const showApprovals=()=>{setMode('minimized');onApprovals();};
  const send=(kind:'queue'|'interrupt')=>{const value=text.trim();if(!value)return;void act(async()=>{await api('/director/input','POST',{text:value,mode:kind});setText('');});};
  const unread=logs.filter(l=>l.id>seen && l.kind==='text').reduce((n,l,i,all)=>n+(i===0 || all[i-1].run_id!==l.run_id?1:0),0);
  const visible=logs.filter(l=>labels[l.kind]);const merged:RunLog[]=[];for(const l of visible){const last=merged.at(-1);if(l.kind==='text' && last?.kind==='text' && last.run_id===l.run_id)last.text+=l.text;else merged.push({...l});}

  if(mode==='hidden')return null;
  return createPortal(<>{mode==='minimized' && <button className="gm-minimized" onClick={()=>setMode('open')} aria-label={tx("Genel Müdür terminalini aç{0}", [unread?tx(", {0} okunmamış cevap", [unread]):''])}><strong>{tx("◆ Genel Müdür")} {unread>0 && <b>{unread}</b>}</strong><span>{status}</span><small>{tx("Konuşma sürüyor · Açmak için tıklayın")}</small></button>}
    <section className={`gm-terminal ${full?'gm-full':''}`} ref={panel} role="dialog" aria-label={tx("Genel Müdür terminali")} style={{display:mode==='minimized'?'none':undefined,left:geometry.x,top:geometry.y,width:geometry.width,height:geometry.height} as CSSProperties}>
      <header className="gm-titlebar" onPointerDown={e=>{if((e.target as HTMLElement).closest('button,input') || full || matchMedia('(max-width: 700px)').matches)return;e.currentTarget.setPointerCapture(e.pointerId);e.currentTarget.dataset.dx=String(e.clientX-geometry.x);e.currentTarget.dataset.dy=String(e.clientY-geometry.y);}} onPointerMove={e=>{if(!e.currentTarget.hasPointerCapture(e.pointerId))return;const x=e.clientX-Number(e.currentTarget.dataset.dx),y=e.clientY-Number(e.currentTarget.dataset.dy);setGeometry(g=>({...g,x:Math.max(0,Math.min(Math.max(0,window.innerWidth-g.width-8),x)),y:Math.max(0,Math.min(Math.max(0,window.innerHeight-g.height-8),y))}));}}>
        <strong>◆ {transcript?.agent.name || tx("Genel Müdür")}</strong><span role="status">{status}</span>
        <button aria-label={tx("Genel Müdür terminalini küçült")} title={tx("Küçült")} onClick={()=>setMode('minimized')}>—</button><button aria-label={full?tx("Terminali pencereye döndür"):tx("Terminali tam ekran yap")} title={full?tx("Pencereye dön"):tx("Tam ekran")} onClick={()=>setFull(v=>!v)}>□</button><button aria-label={tx("Genel Müdür terminalini kapat")} title={tx("Kapat; işler sürer")} onClick={()=>setMode('minimized')}>×</button>
      </header>
      <div className="gm-controls"><button role="switch" aria-checked={!!current?.auto} disabled={busy || disabled || pty.enabled && !pty.usageKnown && !current?.auto} title={pty.enabled && !pty.usageKnown?tx("Otomatik mod için kullanım ölçümünü bekleyin"):undefined} onClick={()=>void act(()=>api('/director/auto','POST',{enabled:!current?.auto}))}>{tx("Oto")} {current?.auto?tx("açık"):tx("kapalı")}</button><button disabled={busy || disabled} onClick={()=>void act(()=>api('/director/input','POST',{text:'/durum'}))}>{tx("Durum")}</button><button onClick={showApprovals}>{tx("Onaylar")}{pendingApprovals?` · ${pendingApprovals}`:''}</button><button disabled={busy || disabled} onClick={()=>void act(()=>api('/director/input','POST',{text:'/yardim'}))}>{tx("Yardım")}</button><button disabled={busy || disabled} onClick={()=>void act(()=>api('/director/terminal/control','POST',{action:'restart'}))}>{tx("Yeniden başlat")}</button><button disabled={busy || disabled} onClick={()=>void act(()=>api('/director/terminal/control','POST',{action:'new'}))}>{tx("Yeni konuşma")}</button><small>Ctrl + Shift + G</small></div>
      <div className="gm-tabs" role="tablist" aria-label={tx("Genel Müdür görünümü")}><button role="tab" aria-selected={tab==='terminal'} onClick={()=>setTab('terminal')}>{tx("Terminal")}</button><button role="tab" aria-selected={tab==='flow'} onClick={()=>setTab('flow')}>{tx("Akış görünümü")}</button></div>
      <p className="gm-mode">{pty.enabled && current?.auto && !pty.usageKnown?tx("Otomatik takip kullanım ölçümünü bekliyor; olaylar korunuyor."):current?.auto?tx("Otomatik mod açık · Sonuçları izler, gerektiğinde yeni iş verir."):tx("Otomatik mod kapalı · Kendi verdiğim işlerin sonucunu bir kez raporlarım; yeni iş için sizden talimat beklerim.")}</p>
      {pending && <div className="gm-account" role="alert"><p>{data.events.find(e=>e.agent_id===current?.agent_id && e.kind==='tududi_pending')?.text || tx("Tududi hesabı bekliyor. Görevler ve defter için hesabı hazırlayın.")}</p><button disabled={busy || disabled} onClick={()=>void act(()=>api(`/agents/${current?.agent_id}/retry`,'POST',{}))}>{tx("Hesabı yeniden kur")}</button></div>}
      {error && <p className="gm-error" role="alert">{error}<button onClick={()=>{setError('');void reload();}}>{tx("Yeniden dene")}</button></p>}
      {pendingApprovals>0 && <button className="gm-question" onClick={showApprovals}>{tx("Sizin kararınızı bekleyen")} {pendingApprovals} {tx("onay var · Onay kutusunu aç")}</button>}
      {pendingAgent?.runner==='claude' && <p className="gm-mode">{tx("Claude desteği deneysel — gerçek hesapla sınanmadı.")}{data.runtime?.availability?.claude===false && <><br />{tx("Claude girişi yapılmamış — çalıştırıcıda ayrı hesapla giriş yapın.")} <code>{data.runtime?.claudeLoginCommand}</code></>}</p>}
      <div className="gm-terminal-content" style={{display:tab==='terminal'?undefined:'none'}}><CodexTerminal active={true} visible={mode==='open' && tab==='terminal'} onStatus={setPty} /></div>
      <div className="gm-transcript" style={{display:tab==='flow'?undefined:'none'}} ref={scroll} role="log" aria-label={tx("Genel Müdür dökümü")} onScroll={e=>{nearBottom.current=e.currentTarget.scrollHeight-e.currentTarget.clientHeight-e.currentTarget.scrollTop<48;}}>
        {transcript?.has_older && <button disabled={busy} onClick={()=>void act(async()=>{const first=logs[0]?.id;if(!first)return;const r=await api<Transcript>(`/director?before=${first}`);setTranscript(t=>t?{...t,has_older:r.has_older}:r);setLogs(old=>[...r.logs,...old]);})}>{tx("Önceki satırları göster")}</button>}
        {!loaded?<p>{tx("Terminal yükleniyor…")}</p>:!merged.length?<p>{tx("İşinizi Terminal sekmesine yazın. Burada araçların ve olayların özeti görünür.")}</p>:merged.map(l=><article key={l.id} className={`gm-line gm-${l.kind}`}><small>{labels[l.kind]}</small><pre>{readable(l)}</pre></article>)}
      </div>
      {!pty.enabled && tab==='flow' && <form className="gm-compose" onSubmit={e=>{e.preventDefault();send('queue');}}><label htmlFor="gm-input">{tx("İşiniz veya komutunuz")}</label><div className="gm-prompt"><span aria-hidden="true">{tx("siz &gt;")}</span><textarea id="gm-input" ref={draft} value={text} rows={2} maxLength={10000} onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==='Enter' && !e.shiftKey && !e.nativeEvent.isComposing){e.preventDefault();send('queue');}}} placeholder={tx("İş verin veya /yardim yazın")} disabled={disabled} /></div><div className="gm-send"><small>{tx("Enter: gönder · Shift + Enter: yeni satır")}</small><button disabled={busy || disabled || !text.trim()}>{running?tx("Sıraya ekle"):tx("Gönder")}</button>{running && <button type="button" disabled={busy || disabled || !text.trim()} onClick={()=>send('interrupt')}>{tx("Araya gir")}</button>}</div></form>}
      <footer>{pty.enabled?tx("Terminal kullanımı: {0} · ", [pty.usageKnown?tx("ölçüldü"):tx("ölçülemedi")]):''}{pty.enabled?tx("Kalıcı terminal konuşması"):tx("Kalıcı konuşma · {0} tur", [transcript?.session.turns || 0])} · {current?.auto_tokens.toLocaleString(locale()) || 0} {tx("otomatik token ·")} {current?.followup_tokens?.toLocaleString(locale()) || 0} {tx("takip token")}{current?.ledger_pending?tx(" · Defter Tududi bağlantısını bekliyor"):''}</footer>
    </section></>,document.body);
}
