import { t as tx } from "./i18n";
import { useState } from 'react';
import type { Snapshot } from '../shared/types';
import { api } from './api';
import type { Perform } from './chat/ChatPanel';
export function CommandLinks({data,perform,disabled}:{data:Snapshot;perform:Perform;disabled:boolean}) {
  const blank={name:'',folder_id:'',directory:'.',command:'',timeout_seconds:120,write:false,approval:true,agent_ids:[] as string[]};
  const [form,setForm]=useState(blank);
  const folder=data.runtime?.links.find(l=>l.id===form.folder_id);
  return <section><h2>{tx("Komut bağlantıları")}</h2><p>{tx("Sabit bir komut tanımlayın. Ajan yalnız adını seçer; komutu değiştiremez.")}</p>
    <form className="runtime-card" onSubmit={e=>{e.preventDefault();void perform(async()=>{await api('/commands','POST',form);setForm(blank);},tx("Komut bağlantısı kaydedildi."));}}>
      <div className="form-grid"><label>{tx("Komut adı")}<input required maxLength={100} value={form.name} onChange={e=>setForm({...form,name:e.target.value})} /></label><label>{tx("Klasör bağlantısı")}<select required value={form.folder_id} onChange={e=>setForm({...form,folder_id:e.target.value,agent_ids:[]})}><option value="">{tx("Klasör seçin")}</option>{data.runtime?.links.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label><label>{tx("Klasörün altındaki çalışma yeri")}<input required value={form.directory} maxLength={500} onChange={e=>setForm({...form,directory:e.target.value})} /></label><label>{tx("Süre sınırı · saniye")}<input type="number" min={1} max={600} value={form.timeout_seconds} onChange={e=>setForm({...form,timeout_seconds:Number(e.target.value)})} /></label></div>
      <label>{tx("Sabit komut satırı")}<input required maxLength={2000} value={form.command} onChange={e=>setForm({...form,command:e.target.value})} placeholder="npm test" /></label>
      <label className="radio-label"><input type="checkbox" checked={form.approval} onChange={e=>setForm({...form,approval:e.target.checked})} />{tx("Her çalıştırmada onay gereksin")}</label><label className="radio-label"><input type="checkbox" checked={form.write} disabled={!folder || folder.access!=='write' || folder.approved_write} onChange={e=>setForm({...form,write:e.target.checked})} />{tx("Komut dosyalara yazabilsin")}</label>
      <fieldset><legend>{tx("Kimler çalıştırabilir?")}</legend>{data.agents.filter(a=>folder?.agent_ids.includes(a.id)).map(a=><label className="radio-label" key={a.id}><input type="checkbox" checked={form.agent_ids.includes(a.id)} onChange={e=>setForm({...form,agent_ids:e.target.checked?[...form.agent_ids,a.id]:form.agent_ids.filter(id=>id!==a.id)})} />{a.name}</label>)}</fieldset>
      <button className="primary" disabled={disabled || !form.agent_ids.length}>{tx("Komut ekle")}</button>
    </form>
    <div className="runtime-cards">{data.runtime?.commands?.map(c=><article className="runtime-card" key={c.id}><h3>{c.name}</h3><pre>{c.command}</pre><p>{c.timeout_seconds} {tx("saniye ·")} {c.approval?tx("Onay gerekir"):tx("Onay gerekmez")}</p><button className="danger-button" disabled={disabled} onClick={()=>void perform(async()=>{await api(`/commands/${c.id}`,'DELETE');})}>{tx("Komutu sil")}</button></article>)}</div>
  </section>;
}
