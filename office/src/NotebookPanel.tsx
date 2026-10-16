import { t as tx } from "./i18n";
import { useEffect,useState } from 'react';
import type { Snapshot } from '../shared/types';
import { api } from './api';
import type { Perform } from './chat/ChatPanel';
export function NotebookPanel({data,perform,disabled}:{data:Snapshot;perform:Perform;disabled:boolean}) {
  const [summaries,setSummaries] = useState<{day:string;text:string;published:boolean}[]>([]),[notes,setNotes] = useState<{id:string;title:string;content:string;locked:number;invalid:number}[]>([]),[title,setTitle]=useState(''),[content,setContent]=useState(''),[version,setVersion]=useState(0),[error,setError]=useState('');
  useEffect(()=>{let alive=true;void Promise.all([api<typeof summaries>('/summaries'),api<typeof notes>('/shared-notebook')]).then(([s,n])=>{if(alive){setSummaries(s);setNotes(n);}}).catch(()=>{if(alive)setError(tx("Defter bilgileri alınamadı."));});return()=>{alive=false;};},[version]);
  return <>
    <div className="page-heading"><h1>{tx("Özetler ve ortak defter")}</h1></div>
    {error && <p role="alert">{error}</p>}
    <button className="primary" disabled={disabled} onClick={()=>void perform(async()=>{await api('/summaries/now','POST',{});setVersion(v=>v+1);})}>{tx("Şimdi özetle")}</button>
    <div className="runtime-cards">{summaries.map(s=><details className="runtime-card" key={s.day}><summary>{s.day} · {s.published ? tx("Tududi’ye yazıldı") : tx("Tududi’ye aktarılmayı bekliyor")}</summary><pre className="runtime-text">{s.text}</pre></details>)}</div>
    <h2>{tx("Ortak defter")}</h2><p>{tx("Şirket bilgisi burada bir kez tutulur. Bütün ajanlar okuyabilir; yazabilecek ajanları şirket ayarından seçin.")}</p>
    <form className="runtime-card" onSubmit={e=>{e.preventDefault();void perform(async()=>{await api('/shared-notebook','POST',{title,content});setTitle('');setContent('');setVersion(v=>v+1);});}}>
      <label>{tx("Not başlığı")}<input required maxLength={200} value={title} onChange={e=>setTitle(e.target.value)} /></label><label>{tx("Doğrulanmış kısa bilgi")}<textarea required maxLength={4000} rows={3} value={content} onChange={e=>setContent(e.target.value)} /></label><button className="primary" disabled={disabled}>{tx("Ortak notu kaydet")}</button>
    </form>
    <div className="runtime-cards">{notes.map(n=><article className="runtime-card" key={n.id}><h3>{n.title}</h3><p className="runtime-text">{n.content}</p><label className="radio-label"><input type="checkbox" checked={!!n.locked} disabled={disabled} onChange={e=>void perform(async()=>{await api(`/shared-notebook/${n.id}/mark`,'PUT',{locked:e.target.checked,invalid:!!n.invalid});setVersion(v=>v+1);})} />{tx("Kilitli: ajan değiştiremesin")}</label><label className="radio-label"><input type="checkbox" checked={!!n.invalid} disabled={disabled} onChange={e=>void perform(async()=>{await api(`/shared-notebook/${n.id}/mark`,'PUT',{locked:!!n.locked,invalid:e.target.checked});setVersion(v=>v+1);})} />{tx("Yanlış: ajanlar kullanmasın")}</label></article>)}</div>
  </>;
}
