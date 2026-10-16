import { translate } from "../shared/i18n/index";
import { t as tx, locale, setLanguage } from "./i18n";
import { defaultDirectorSettings } from "../shared/director";
import { SchedulesPanel } from "./SchedulesPanel";
import { SessionPanel } from "./SessionPanel";
import { CommandLinks } from "./CommandLinks";
import { useEffect, useState } from "react";
import type { Agent, Snapshot } from "../shared/types";
import {
  defaultSettings,
  runLabels,
  toolSummary,
  type FolderLink,
  type Run,
  type RunLog,
  usageTotals,
  weightedTokens,
  type ChainUsage,
} from "../shared/runtime";
import { api } from "./api";
import type { Perform } from "./chat/ChatPanel";
import { defaultPolicy } from "../shared/runtime";

function contextText(text: string) {
  try {
    const c = JSON.parse(text);
    if (typeof c.karakter !== "number" || !Array.isArray(c.en_buyuk_uc)) return text;
    return tx("{0} karakter · yaklaşık {1} token\nTahmin: 4 karakter yaklaşık 1 token. Araç tanımları ve çalıştırıcının eklediği bilgiler bu ölçüme dahil değildir.\n\nEn büyük üç parça\n{2}", [c.karakter, c.tahmini_token, c.en_buyuk_uc.map((p: { ad: string; karakter: number; tahmini_token: number }) => tx("{0}: {1} karakter · yaklaşık {2} token", [tx(p.ad), p.karakter, p.tahmini_token])).join("\n")]);
  } catch { return text; }
}

function MarkdownPreview({ text }: { text: string }) {
  // Only React text nodes: embedded HTML, scripts and external image URLs cannot execute.
  return (
    <div className="artifact-markdown">
      {text.split(/\n\s*\n/).map((block, index) => {
        if (block.startsWith("```"))
          return (
            <pre key={index}>
              {block.replace(/^```[^\n]*\n/, "").replace(/\n```$/, "")}
            </pre>
          );
        if (block.startsWith("# "))
          return <h2 key={index}>{block.slice(2)}</h2>;
        if (block.startsWith("## "))
          return <h3 key={index}>{block.slice(3)}</h3>;
        if (/^[-*] /.test(block))
          return (
            <ul key={index}>
              {block.split("\n").map((line, item) => (
                <li key={item}>{line.replace(/^[-*] /, "")}</li>
              ))}
            </ul>
          );
        return <p key={index}>{block}</p>;
      })}
    </div>
  );
}
export function Approvals({
  data,
  perform,
  disabled,
  agentId,
}: {
  data: Snapshot;
  perform: Perform;
  disabled: boolean;
  agentId?: string | null;
}) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const approvals = (data.runtime?.approvals || []).filter(
    (a) => !agentId || a.agent_id === agentId,
  );
  const labels = {
    pending: tx("Karar bekliyor"),
    approved: tx("Onaylandı"),
    rejected: tx("Reddedildi"),
    applying: tx("Dosyalar kopyalanıyor"),
    applied: tx("Dosyalar kopyalandı"),
    apply_failed: tx("Kopyalanamadı"),
  };
  return (
    <>
      <div className="page-heading">
        <h1>{tx("Onay kutusu")}</h1>
      </div>
      <div className="runtime-cards">
        {approvals.length ? (
          approvals.map((a) => (
            <article className="runtime-card" key={a.id}>
              <span className="badge">{a.type==='factory_reset' && a.state==='applied'?tx('Önizleme açıldı'):labels[a.state]}</span>
              <h2>{a.title}</h2>
              <p>
                {data.agents.find((x) => x.id === a.agent_id)?.name ||
                  tx("Eski ajan")}{" "}
                · {new Date(a.created_at).toLocaleString(locale())}
              </p>
              <p className="runtime-text">{a.detail}</p>
              {a.files.length > 0 && (
                <details>
                  <summary>{a.link_id ? tx("Dosya farkları") : tx("Dosya ekleri")} · {a.files.length}</summary>
                  {a.files.map((f, index) => (
                    <div key={f.path}>
                      <a href={`/api/approvals/${a.id}/files/${index}`} target="_blank" rel="noreferrer">{f.path} {tx("· Eki aç")}</a>
                      <pre>{f.diff}</pre>
                    </div>
                  ))}
                </details>
              )}
              {a.state === "pending" ? (
                <>
                  <label>
                    {tx("Karar notu")}
                    <textarea
                      rows={2}
                      maxLength={2000}
                      value={notes[a.id] || ""}
                      onChange={(e) =>
                        setNotes({ ...notes, [a.id]: e.target.value })
                      }
                    />
                  </label>
                  <div className="runtime-actions">
                    <button
                      className="primary"
                      disabled={disabled}
                      onClick={() =>
                        void perform(async () => {
                          const decision=await api<{sonuc?:unknown}>(`/approvals/${a.id}/decision`, "POST", {
                            approved: true,
                            note: notes[a.id] || "",
                          });
                          if(a.type==='factory_reset' && decision.sonuc)window.dispatchEvent(new CustomEvent('office:factory-reset-open',{detail:decision.sonuc}));
                        })
                      }
                    >
                      {a.type==='factory_reset'?tx("Önizlemeyi aç"):tx("Onayla")}
                    </button>
                    <button
                      className="secondary"
                      disabled={disabled}
                      onClick={() =>
                        void perform(async () => {
                          await api(`/approvals/${a.id}/decision`, "POST", {
                            approved: false,
                            note: notes[a.id] || "",
                          });
                        })
                      }
                    >
                      {tx("Reddet")}
                    </button>
                  </div>
                </>
              ) : (
                <p>{a.note || tx("Karar kaydedildi.")}</p>
              )}
            </article>
          ))
        ) : (
          <p className="hint">{tx("Henüz bir onay isteği yok.")}</p>
        )}
      </div>
    </>
  );
}
export function Links({
  data,
  perform,
  disabled,
}: {
  data: Snapshot;
  perform: Perform;
  disabled: boolean;
}) {
  const blank = {
    name: "",
    path: "",
    access: "read" as "read" | "write",
    approved_write: true,
    agent_ids: [] as string[],
  };
  const [form, setForm] = useState(blank),
    [editing, setEditing] = useState<string | null>(null);
  return (
    <>
      <div className="page-heading">
        <h1>{tx("Bağlantılar")}</h1>
      </div>
      <p>
        {tx("Klasör ve komut bağlantılarını seçtiğiniz ajanlara açın.")}
      </p>
      <div className="runtime-columns">
        <form
          className="runtime-card"
          onSubmit={(e) => {
            e.preventDefault();
            void perform(async () => {
              await api(
                editing ? `/links/${editing}` : "/links",
                editing ? "PUT" : "POST",
                form,
              );
              setForm(blank);
              setEditing(null);
            }, tx("Klasör bağlantısı kaydedildi."));
          }}
        >
          <h2>{editing ? tx("Bağlantıyı düzenle") : tx("Klasör ekle")}</h2>
          <label>
            {tx("Bağlantı adı")}
            <input
              value={form.name}
              required
              maxLength={100}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            {tx("Sunucudaki klasör yolu")}
            <input
              value={form.path}
              required
              maxLength={1000}
              placeholder={tx("/izinli-klasor/calisma")}
              onChange={(e) => setForm({ ...form, path: e.target.value })}
            />
          </label>
          <label>
            {tx("Klasör izni")}
            <select
              value={form.access}
              onChange={(e) =>
                setForm({ ...form, access: e.target.value as "read" | "write" })
              }
            >
              <option value="read">{tx("Yalnız okur")}</option>
              <option value="write">{tx("Okur ve yazar")}</option>
            </select>
          </label>
          {form.access === "write" && (
            <label className="radio-label">
              <input
                type="checkbox"
                checked={form.approved_write}
                onChange={(e) =>
                  setForm({ ...form, approved_write: e.target.checked })
                }
              />
              {tx("Yazmadan önce onay gerekir")}
            </label>
          )}
          <fieldset>
            <legend>{tx("Bu klasörü kullanacak ajanlar")}</legend>
            {data.agents.map((a) => (
              <label className="radio-label" key={a.id}>
                <input
                  type="checkbox"
                  checked={form.agent_ids.includes(a.id)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      agent_ids: e.target.checked
                        ? [...form.agent_ids, a.id]
                        : form.agent_ids.filter((id) => id !== a.id),
                    })
                  }
                />
                {a.name}
              </label>
            ))}
          </fieldset>
          <p className="field-help">
            {tx("Ajanın yetkisini “Klasör bağlantıları” seçin. Sistem ve özel ayar klasörleri eklenemez.")}
          </p>
          <button className="primary" disabled={disabled}>
            {tx("Bağlantıyı kaydet")}
          </button>
        </form>
        <div className="runtime-cards">
          {(data.runtime?.links || []).map((l) => (
            <article key={l.id} className="runtime-card">
              <h2>{l.name}</h2>
              <p className="runtime-text">{l.path}</p>
              <p>
                {l.access === "read"
                  ? tx("Yalnız okur")
                  : l.approved_write
                    ? tx("Onayla yazar")
                    : tx("Doğrudan yazar")}{" "}
                ·{" "}
                {l.validation === "valid"
                  ? tx("Hazır")
                  : l.validation === "pending"
                    ? tx("Kontrol bekliyor")
                    : tx("Kullanılamıyor")}
              </p>
              <p>{l.detail}</p>
              <p>
                {l.agent_ids
                  .map((id) => data.agents.find((a) => a.id === id)?.name)
                  .filter(Boolean)
                  .join(", ") || tx("Ajan atanmadı")}
              </p>
              <div className="runtime-actions">
                <button
                  className="secondary"
                  disabled={disabled}
                  onClick={() => {
                    const { id, validation, detail, documents, documents_truncated, ...b } = l;
                    setForm(b);
                    setEditing(id);
                  }}
                >
                  {tx("Düzenle")}
                </button>
                <button
                  className="secondary"
                  disabled={disabled}
                  onClick={() =>
                    void perform(async () => {
                      await api(`/links/${l.id}`, "DELETE");
                    })
                  }
                >
                  {tx("Kaldır")}
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>
      <CommandLinks data={data} perform={perform} disabled={disabled} />
    </>
  );
}
export function Usage({ data,perform,disabled=false }: { data: Snapshot;perform?:Perform;disabled?:boolean }) {
  const [details,setDetails]=useState<{expensive:Run[];sessions:(import("../shared/runtime").AgentSession & {average_tokens:number;average_cached_tokens:number;average_uncached_tokens:number;weighted_tokens:number;total_tokens:number})[];days:{agent_id:string;day:string;input_tokens:number;cached_input_tokens:number;uncached_input_tokens:number;output_tokens:number;weighted_tokens:number;total_tokens:number}[]}|null>(null);
  useEffect(()=>{let alive=true;api<typeof details>("/usage/details").then(r=>{if(alive)setDetails(r);}).catch(()=>{});return()=>{alive=false;};},[JSON.stringify(data.runtime?.sessions)]);
  const [days, setDays] = useState(1),
    [rows, setRows] = useState<
      {
        id: string;
        name: string;
        terminal_usage?: 'measured'|'unknown';
        runs: number;
        duration_ms: number;
        failed: number;
        budget_exceeded?: number;
        input_tokens: number;
        cached_input_tokens?:number;
        uncached_input_tokens?:number;
        average_cached_tokens?:number;
        average_uncached_tokens?:number;
        output_tokens: number;
        total_tokens: number;
        weighted_tokens?:number;
        average_ms: number;
        average_tokens?:number;
        notes_read?:number;
        notes_written?:number;
      }[]
    >([]),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    api<typeof rows>(`/usage?days=${days}`)
      .then((r) => {
        if (alive) setRows(r);
      })
      .catch(() => {
        if (alive) setError(tx("Kullanım bilgisi alınamadı."));
      });
    return () => {
      alive = false;
    };
  }, [days]);
  const budget = data.runtime?.settings.dailyTokenBudget ?? defaultSettings.dailyTokenBudget;
  const used = data.runtime?.dailyUsage?.weighted_tokens || 0;
  return (
    <>
      <div className="page-heading">
        <h1>{tx("Kullanım ve kota")}</h1>
      </div>
      <section className="runtime-card daily-token-usage" aria-label={tx("Bugünkü token kullanımı")}>
        <h2>{tx("Bugünkü kullanım / günlük tavan")}</h2>
        <p>{used.toLocaleString(locale())} / {budget.toLocaleString(locale())} {tx("ağırlıklı token")}</p>
        <p>{tx("Toplam:")} {(data.runtime?.dailyUsage?.total_tokens || 0).toLocaleString(locale())} {tx("· Önbellekten:")} {(data.runtime?.dailyUsage?.cached_input_tokens || 0).toLocaleString(locale())} {tx("· Ağırlıklı:")} {used.toLocaleString(locale())}</p>
        <p className="field-help">{tx("Bütün token tavanları ağırlıklı kullanıma göre hesaplanır: önbelleksiz girdi + çıktı + önbellekten okunan girdi ×")} {data.runtime?.settings.cachedInputWeight ?? 0.1}{tx(". Önbellek bilgisi yoksa girdi tam sayılır.")}</p>
        <progress value={Math.min(used,budget)} max={budget} aria-label={tx("Günlük token tavanı")} />
        <p className="field-help">{tx("Gün")} {data.runtime?.settings.timeZone || defaultSettings.timeZone} {tx("saat diliminde gece yarısında sıfırlanır.")}</p>
        <a href="#daily-token-setting">{tx("Günlük tavanı değiştir")}</a>
      </section>
      {(data.runtime?.providerPauses || []).map(p=><div className="runtime-card" key={p.provider}><p>{p.provider === "codex" ? "Codex" : "Claude"} {tx("kotası doldu ·")} {p.until ? new Date(p.until).toLocaleString(locale()) : tx("Açılma saati bilinmiyor")}</p><button disabled={!perform || disabled} onClick={()=>perform && void perform(async()=>{await api("/runtime/providers/resume","POST",{provider:p.provider});})}>{tx("Sağlayıcıyı sürdür")}</button></div>)}
      <label>
        {tx("Dönem")}
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={1}>{tx("Bugün")}</option>
          <option value={7}>{tx("Son 7 gün")}</option>
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="runtime-cards">
        {rows.map((r) => (
          <article className="runtime-card" key={r.id}>
            <h2>{r.name}</h2>
            {r.terminal_usage && <p>{tx("Terminal kullanımı:")} {r.terminal_usage==='measured'?tx("ölçüldü"):tx("ölçülemedi")}</p>}
            <p>
              {r.runs} {tx("çalışma ·")} {(r.duration_ms / 60000).toLocaleString(locale(),{minimumFractionDigits:1,maximumFractionDigits:1})} {tx("dakika ·")}{" "}
              {r.failed || 0} {tx("başarısız")}{r.budget_exceeded ? tx(" · {0} bütçede kesildi", [r.budget_exceeded]) : ""}
            </p>
            <p>{(r.total_tokens || 0).toLocaleString(locale())} {tx("toplam token ·")} {(r.weighted_tokens || 0).toLocaleString(locale())} {tx("ağırlıklı ·")} {(r.input_tokens || 0).toLocaleString(locale())} {tx("girdi ·")} {(r.output_tokens || 0).toLocaleString(locale())} {tx("çıktı")}</p>
            <p>{tx("Önbellekli:")} {(r.cached_input_tokens || 0).toLocaleString(locale())} {tx("· Önbelleksiz:")} {(r.uncached_input_tokens ?? r.input_tokens).toLocaleString(locale())} {tx("girdi token")}</p>
            {!!(data.runtime?.settings.inputPricePerMillion || data.runtime?.settings.outputPricePerMillion) && <p>{tx("Tahmini maliyet:")} {(((r.uncached_input_tokens ?? r.input_tokens)*(data.runtime?.settings.inputPricePerMillion || 0)+(r.output_tokens || 0)*(data.runtime?.settings.outputPricePerMillion || 0))/1000000).toLocaleString(locale(),{maximumFractionDigits:4})}</p>}
            <p>{tx("Ortalama önbellekli:")} {(r.average_cached_tokens || 0).toLocaleString(locale())} {tx("· Önbelleksiz:")} {(r.average_uncached_tokens || 0).toLocaleString(locale())}</p>
            <p>{tx("Çalışma başına ortalama:")} {(r.average_tokens || 0).toLocaleString(locale())} {tx("girdi token · Not okuma:")} {r.notes_read || 0} {tx("· Not yazma:")} {r.notes_written || 0}</p>
            <p>{tx("Ortalama süre:")} {((r.average_ms || 0) / 1000).toLocaleString(locale(),{minimumFractionDigits:1,maximumFractionDigits:1})} {tx("saniye")}</p>
          </article>
        ))}
      </div>
      <p className="field-help">
        {tx("Token miktarı sağlayıcının akışta bildirdiği gözlenen kullanımdır. Bildirim yoksa miktar bilinmez. Günler Ofisin saat dilimine göre hesaplanır. Kuyruğa alınan işler çalışma sayısına dahildir.")}
      </p>
      <details className="runtime-card"><summary>{tx("En pahalı 5 çalışma")}</summary>{details?.expensive.map(r=><p key={r.id}>{data.agents.find(a=>a.id===r.agent_id)?.name || tx("Eski ajan")} · {r.summary.slice(0,120)} · {usageTotals(r.usage).total_tokens.toLocaleString(locale())} {tx("toplam ·")} {weightedTokens(r.usage,data.runtime?.settings.cachedInputWeight).toLocaleString(locale())} {tx("ağırlıklı ·")} {usageTotals(r.usage).input_tokens.toLocaleString(locale())} {tx("girdi token · Önbellekli")} {usageTotals(r.usage).cached_input_tokens.toLocaleString(locale())} {tx("· Önbelleksiz")} {usageTotals(r.usage).uncached_input_tokens.toLocaleString(locale())}</p>)}</details>
      <details className="runtime-card"><summary>{tx("Oturum kullanımı")}</summary>{details?.sessions.map(s=><p key={s.session_key || s.agent_id}>{data.agents.find(a=>a.id===s.agent_id)?.name} · {s.total_tokens.toLocaleString(locale())} {tx("toplam ·")} {s.weighted_tokens.toLocaleString(locale())} {tx("ağırlıklı ·")} {s.input_tokens.toLocaleString(locale())} {tx("girdi token · Önbellekli")} {(s.cached_input_tokens || 0).toLocaleString(locale())} {tx("· Önbelleksiz")} {(s.input_tokens-(s.cached_input_tokens || 0)).toLocaleString(locale())} {tx("· Ortalama")} {s.average_tokens.toLocaleString(locale())} {tx("(önbellekli")} {(s.average_cached_tokens || 0).toLocaleString(locale())}{tx(", önbelleksiz")} {(s.average_uncached_tokens || 0).toLocaleString(locale())}) · {s.renewals} {tx("yenileme")}</p>)}</details>
      <details className="runtime-card"><summary>{tx("Günlere göre kullanım")}</summary>{details?.days.map(d=><p key={d.agent_id+d.day}>{new Date(d.day+"T12:00:00Z").toLocaleDateString(locale(),{timeZone:"UTC",year:"numeric",month:"short",day:"numeric"})} · {data.agents.find(a=>a.id===d.agent_id)?.name} · {d.total_tokens.toLocaleString(locale())} {tx("toplam ·")} {d.weighted_tokens.toLocaleString(locale())} {tx("ağırlıklı ·")} {d.input_tokens.toLocaleString(locale())} {tx("girdi (önbellekli")} {(d.cached_input_tokens || 0).toLocaleString(locale())}{tx(", önbelleksiz")} {(d.uncached_input_tokens || 0).toLocaleString(locale())}) / {d.output_tokens.toLocaleString(locale())} {tx("çıktı token")}</p>)}</details>
      <RuntimeSettings data={data} perform={perform} disabled={disabled} />
      <ChainList chains={data.runtime?.chains || []} data={data} />
    </>
  );
}
function ChainList({ chains, data }: { chains: ChainUsage[]; data: Snapshot }) {
  return <div className="runtime-cards">{chains.map((c) => <details className="runtime-card" key={c.id}>
    <summary>{tx("İş zinciri ·")} {c.runs.length} {tx("çalışma ·")} {(c.weighted_tokens || 0).toLocaleString(locale())} {tx("ağırlıklı ·")} {c.input_tokens.toLocaleString(locale())} {tx("girdi (önbellekli")} {(c.cached_input_tokens || 0).toLocaleString(locale())}{tx(", önbelleksiz")} {(c.uncached_input_tokens ?? c.input_tokens).toLocaleString(locale())}) / {c.output_tokens.toLocaleString(locale())} {tx("çıktı token ·")} {(c.duration_ms / 60000).toLocaleString(locale(),{minimumFractionDigits:1,maximumFractionDigits:1})} {tx("dakika")}</summary>
    {!!(data.runtime?.settings.inputPricePerMillion || data.runtime?.settings.outputPricePerMillion) && <p>{tx("Tahmini maliyet:")} {(((c.uncached_input_tokens ?? c.input_tokens)*(data.runtime?.settings.inputPricePerMillion || 0)+c.output_tokens*(data.runtime?.settings.outputPricePerMillion || 0))/1000000).toLocaleString(locale(),{maximumFractionDigits:4})}</p>}
    {c.runs.map((r) => <p key={r.id}>{data.agents.find((a) => a.id === r.agent_id)?.name || tx("Eski ajan")} · {tx(runLabels[r.state])} · {r.summary.slice(0, 120)} · {usageTotals(r.usage).total_tokens.toLocaleString(locale())} {tx("token")}</p>)}
  </details>)}</div>;
}
export function RuntimeSettings({
  data,
  perform,
  disabled = false,
}: {
  data: Snapshot;
  perform?: Perform;
  disabled?: boolean;
}) {
  const initial = data.runtime?.settings || defaultSettings;
  const [settings, setSettings] = useState(initial),
    [rules, setRules] = useState(initial.approvalRules.join("\n"));
  useEffect(() => {
    setSettings(initial);
    setRules(initial.approvalRules.join("\n"));
  }, [JSON.stringify(initial)]);
  const fields: [
    "concurrency" | "maxDepth" | "chainRuns" | "chainTokenBudget" | "dailyRuns" | "dailyMinutes" | "dailyTokenBudget" | "sessionTurnLimit" | "sessionTokenLimit" | "chatTurnLimit",
    string,
    number,
  ][] = [
    ["concurrency", tx("Aynı anda çalışma"), 16],
    ["maxDepth", tx("En uzun devir zinciri"), 20],
    ["chainRuns", tx("Bir zincirde toplam çalışma"), 100],
    ["chainTokenBudget", tx("Zincirin ağırlıklı token bütçesi"), 1000000000],
    ["dailyTokenBudget", tx("Ofisin günlük ağırlıklı token bütçesi"), 1000000000],
    ["sessionTurnLimit", tx("Oturum yenileme · tur sınırı"), 10000],
    ["sessionTokenLimit", tx("Oturum yenileme · son tek isteğin bağlam sınırı"), 1000000000],
    ["chatTurnLimit", tx("Serbest sohbet · en çok tur"), 100],
    ["dailyRuns", tx("Ofisin günlük çalışma sayısı"), 10000],
    ["dailyMinutes", tx("Ofisin günlük toplam dakikası"), 14400],
  ];
  return (
    <form
      className="runtime-card runtime-settings"
      onSubmit={(e) => {
        e.preventDefault();
        if (perform)
          void perform(async () => {
            await api("/runtime/settings", "PUT", {
              ...settings,
              approvalRules: rules
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
            });
            setLanguage(settings.language || "tr");
          }, translate(settings.language || "tr", "Çalışma sınırları kaydedildi."));
      }}
    >
      <h2>{tx("Çalışma sınırları ve onay kuralları")}</h2>
      <label>{tx("Ofis dili")}<select aria-label={tx("Ofis dili")} value={settings.language || "tr"} disabled={!perform || disabled} onChange={e=>setSettings({...settings,language:e.target.value as "tr"|"en"})}><option value="tr">{tx("Türkçe")}</option><option value="en">{tx("İngilizce")}</option></select></label>
      <label>{tx("Ofisin saat dilimi")}<select value={settings.timeZone || defaultSettings.timeZone} onChange={e=>setSettings({...settings,timeZone:e.target.value})} disabled={!perform || disabled}>{[...new Set([settings.timeZone || defaultSettings.timeZone,'Europe/Istanbul','UTC','Europe/Berlin','Europe/London','America/New_York','Asia/Dubai'])].map(zone=><option key={zone} value={zone}>{zone === 'Europe/Istanbul' ? tx("Türkiye · İstanbul") : zone === 'UTC' ? tx("UTC · Dünya saati") : zone}</option>)}</select></label>
      <div className="form-grid"><label>{tx("Tududi e-posta alan adı")}<input value={settings.emailDomain || defaultSettings.emailDomain} onChange={e=>setSettings({...settings,emailDomain:e.target.value})} disabled={!perform || disabled} /></label><label>{tx("Varsayılan model")}<input value={settings.defaultModel || defaultSettings.defaultModel} onChange={e=>setSettings({...settings,defaultModel:e.target.value})} disabled={!perform || disabled} /></label><label>{tx("Varsayılan düşünme düzeyi")}<select value={settings.defaultEffort || 'high'} onChange={e=>setSettings({...settings,defaultEffort:e.target.value as typeof settings.defaultEffort})} disabled={!perform || disabled}><option value="low">{tx("Hafif")}</option><option value="medium">{tx("Orta")}</option><option value="high">{tx("Yüksek")}</option><option value="xhigh">{tx("Çok yüksek")}</option><option value="max">{tx("En yüksek")}</option></select></label></div>
      <label>{tx("Varsayılan çalıştırıcı")}<select value={settings.defaultRunner || 'codex'} onChange={e=>setSettings({...settings,defaultRunner:e.target.value as 'codex'|'claude'})} disabled={!perform || disabled}><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
      <fieldset><legend>{tx("Genel Müdür · otomatik mod ve sahip kararları")}</legend>
        <label className="radio-label"><input type="checkbox" checked={(settings.director || defaultDirectorSettings).destructiveApproval} onChange={e=>setSettings({...settings,director:{...defaultDirectorSettings,...settings.director,destructiveApproval:e.target.checked}})} disabled={!perform || disabled} />{tx("Yıkıcı işlemler için benim onayımı iste")}</label>
        <div className="form-grid">{([['batchSeconds',tx("Olayları birleştirme · saniye"),3600],['dailyTokenBudget',tx("Otomatik mod · günlük ağırlıklı token"),1000000000],['hourlyRuns',tx("Otomatik mod · saatte en çok çalışma"),100],['contextTokenLimit',tx("Genel Müdür · son isteğin bağlam sınırı"),1000000],['responseCharLimit',tx("Genel Müdür · araç cevabının karakter sınırı"),10000],['followupTokenBudget',tx("İş takibi · günlük ağırlıklı token"),1000000000]] as const).map(([key,label,max])=><label key={key}>{label}<input type="number" min={key==='contextTokenLimit'?1000:key==='responseCharLimit'?500:1} max={max} value={{...defaultDirectorSettings,...settings.director}[key]} onChange={e=>setSettings({...settings,director:{...defaultDirectorSettings,...settings.director,[key]:Number(e.target.value)}})} disabled={!perform || disabled} /></label>)}</div>
        <div className="form-grid">{([['chatEffort',tx("Genel Müdür · sohbet düşünme düzeyi")],['workEffort',tx("Genel Müdür · iş düşünme düzeyi")]] as const).map(([key,label])=><label key={key}>{label}<select value={{...defaultDirectorSettings,...settings.director}[key]} disabled={!perform || disabled} onChange={e=>setSettings({...settings,director:{...defaultDirectorSettings,...settings.director,[key]:e.target.value as 'low'|'medium'|'high'}})}><option value="low">{tx("Hafif")}</option><option value="medium">{tx("Orta")}</option><option value="high">{tx("Yüksek")}</option></select></label>)}</div>
        <p>{tx("Kararını bana bırakacağı işler")}</p>{([['release_ready',tx("Yayına hazır")],['external',tx("Şirket dışına çıkan işlem")],['spending',tx("Para harcama")],['new_folder',tx("Yeni klasör yolu")],['folder_write',tx("Onaylı klasöre yazma")],['command',tx("Kayıtlı komut çalıştırma")]] as const).map(([type,label])=><label className="radio-label" key={type}><input type="checkbox" checked={(settings.director || defaultDirectorSettings).ownerApprovalTypes.includes(type)} onChange={e=>{const config={...defaultDirectorSettings,...settings.director};setSettings({...settings,director:{...config,ownerApprovalTypes:e.target.checked?[...config.ownerApprovalTypes,type]:config.ownerApprovalTypes.filter(t=>t!==type)}});}} disabled={!perform || disabled} />{label}</label>)}<p className="field-help">{tx("İşaretini kaldırdığınız kararları Genel Müdür verebilir. Yıkıcı işlem onayı ayrıca denetlenir.")}</p>
      </fieldset>
      <fieldset><legend>{tx("Tahmini maliyet · seçtiğiniz para birimiyle")}</legend><div className="form-grid"><label>{tx("1 milyon önbelleksiz girdi fiyatı")}<input type="number" min={0} max={1000000} step="0.001" value={settings.inputPricePerMillion || 0} onChange={e=>setSettings({...settings,inputPricePerMillion:Number(e.target.value)})} disabled={!perform || disabled} /></label><label>{tx("1 milyon çıktı fiyatı")}<input type="number" min={0} max={1000000} step="0.001" value={settings.outputPricePerMillion || 0} onChange={e=>setSettings({...settings,outputPricePerMillion:Number(e.target.value)})} disabled={!perform || disabled} /></label></div><p className="field-help">{tx("Bu bir tahmindir; sağlayıcının faturası değildir. Önce birim fiyatları girin.")}</p></fieldset>
      <label>{tx("Önbellekten okunan girdinin bütçe katsayısı")}<input type="number" min={0} max={1} step="0.01" value={settings.cachedInputWeight ?? 0.1} disabled={!perform || disabled} onChange={e=>setSettings({...settings,cachedInputWeight:Number(e.target.value)})} /></label><p className="field-help">{tx("Varsayılan 0,1: önbellekten okunan 10 token bütçede 1 sayılır. Önbelleksiz girdi ve çıktı tam sayılır.")}</p>
      {perform && <fieldset><legend>{tx("Ortak deftere yazabilen ajanlar")}</legend>{data.agents.map(a=><label className="radio-label" key={a.id}><input type="checkbox" checked={(settings.sharedWriters || []).includes(a.id)} disabled={disabled} onChange={e=>setSettings({...settings,sharedWriters:e.target.checked?[...(settings.sharedWriters || []),a.id]:(settings.sharedWriters || []).filter(id=>id!==a.id)})} />{a.name}</label>)}</fieldset>}
      <div className="form-grid">
        {fields.map(([key, label, max]) => (
          <label key={key}>
            {label}
            <input
              type="number"
              id={key === "dailyTokenBudget" ? "daily-token-setting" : undefined}
              min={1}
              max={max}
              value={settings[key] ?? defaultSettings[key]}
              onChange={(e) =>
                setSettings({ ...settings, [key]: Number(e.target.value) })
              }
              disabled={!perform || disabled}
            />
          </label>
        ))}
      </div>
      <label>
        {tx("Genel sohbette anılmadan yazılana kim cevap verir?")}
        <select value={settings.greeterAgentId || ""} disabled={!perform || disabled} onChange={(e) => setSettings({ ...settings, greeterAgentId: e.target.value || null })}>
          <option value="">{tx("Seçilmemiş")}</option>
          {data.agents.filter((a) => a.active).map((a) => <option value={a.id} key={a.id}>{a.name}</option>)}
        </select>
      </label>
      <p className="field-help">{tx("Token sınırı akışta gözlenen kullanımla denetlenir. Sağlayıcı kullanımı geç bildirirse sınır sonradan fark edilir; kesin harcama sınırı değildir.")}</p>
      <label>
        {tx("Onay gereken işler · her satıra bir kural")}
        <textarea
          rows={4}
          value={rules}
          maxLength={20000}
          onChange={(e) => setRules(e.target.value)}
          disabled={!perform || disabled}
        />
      </label>
      <p className="field-help">
        {tx("Bu metin kuralları ajana talimat olarak verilir. Onaylı klasör yazımı ayrıca sistem tarafından engellenir.")}
      </p>
      {perform && (
        <button className="primary" disabled={disabled}>
          {tx("Sınırları kaydet")}
        </button>
      )}
    </form>
  );
}
export function AgentWork({
  agent,
  data,
  perform,
  disabled,
}: {
  agent: Agent;
  data: Snapshot;
  perform: Perform;
  disabled: boolean;
}) {
  const [tab, setTab] = useState("runs"),
    [memory, setMemory] = useState(""),
    [detail, setDetail] = useState<{ run: Run; logs: RunLog[]; chain?: ChainUsage } | null>(null),
    [preview, setPreview] = useState<{
      text?: string;
      url?: string;
      name: string;
      markdown?: boolean;
    } | null>(null);
  useEffect(() => {
    api<{ text: string }>(`/agents/${agent.id}/memory`)
      .then((r) => setMemory(r.text))
      .catch(() => {});
  }, [agent.id]);
  const runs = (data.runtime?.runs || []).filter(
      (r) => r.agent_id === agent.id,
    ),
    files = (data.runtime?.artifacts || []).filter(
      (a) => a.agent_id === agent.id,
    );
  useEffect(
    () => () => {
      if (preview?.url) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );
  return (
    <section className="agent-work">
      <p className="field-help">
        {tx("Yetki:")}{" "}
        {
          {
            chat: tx("Yalnız sohbet"),
            workspace: tx("Çalışma klasörü"),
            folders: tx("Klasör bağlantıları"),
          }[(agent.policy || defaultPolicy).permission]
        }{" "}
        {tx("· Bir çalışma en çok")} {(agent.policy || defaultPolicy).timeoutMinutes}{" "}
        {tx("dakika ve")} {(agent.policy || defaultPolicy).maxCalls} {tx("tur/araç · Günlük")}{" "}
        {(agent.policy || defaultPolicy).dailyRuns} {tx("çalışma,")}{" "}
        {(agent.policy || defaultPolicy).dailyMinutes} {tx("dakika.")}
      </p>
      {agent.builtin === 'director' && <p className="field-help">{tx("Genel Müdürün gerçek terminalinde süre sınırı yoktur. Token ve araç sınırları geçerlidir.")}</p>}
      {data.runtime?.availability?.[agent.runner] === false && (
        <p role="status">{agent.runner === "claude" ? tx("Claude girişi yapılmamış") : tx("Codex girişi yapılmamış")}{tx(". Çalıştırıcı hesabını bağlayın.")}</p>
      )}
      {agent.runner==='claude' && data.runtime?.availability?.claude===false && <p>{tx("Çalıştırıcıda ayrı Claude hesabına giriş komutu:")} <code>{data.runtime?.claudeLoginCommand}</code></p>}

      <div className="runtime-actions">
        <button
          className="primary"
          disabled={disabled || !agent.active || data.runtime?.availability?.[agent.runner] === false}
          onClick={() =>
            void perform(async () => {
              await api(`/agents/${agent.id}/run`, "POST", {});
            })
          }
        >
          {tx("Şimdi çalıştır")}
        </button>
        <button
          className="secondary"
          disabled={disabled}
          onClick={() =>
            void perform(async () => {
              await api(`/agents/${agent.id}/stop`, "POST");
            })
          }
        >
          {tx("Durdur")}
        </button>
      </div>
      <div
        className="runtime-tabs"
        role="tablist"
        aria-label={tx("Ajan çalışma ayrıntısı")}
      >
        {[
          ["runs", tx("Çalışma kaydı")],
          ["files", tx("Çıktılar")],
          ["memory", tx("Hafıza notu")],
          ["session", tx("Oturum")],
          ["schedules", tx("Zamanlanmış görevler")],
        ].map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => {
              setTab(id);
              setDetail(null);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "schedules" && <SchedulesPanel data={data} perform={perform} disabled={disabled} agentId={agent.id} />}
      {tab === "session" && <SessionPanel agent={agent} data={data} perform={perform} disabled={disabled} />}
      {tab === "runs" && (
        <div className="runtime-cards">
          {runs.length ? (
            runs.map((r) => (
              <button
                className="runtime-card"
                key={r.id}
                data-run-id={r.id}
                onClick={() =>
                  void perform(async () => {
                    setDetail(await api(`/runs/${r.id}`));
                  })
                }
              >
                {tx(runLabels[r.state])} · {r.summary.slice(0, 100)}
                <small>
                  {r.reason || new Date(r.created_at).toLocaleString(locale())}
                </small>
              </button>
            ))
          ) : (
            <p>{tx("Henüz çalışma kaydı yok.")}</p>
          )}
          {detail && (
            <div className="runtime-card">
              <h3>{tx("Çalışmanın dökümü")}</h3>
              <p>{detail.run.reason}</p>
              {detail.run.state === 'failed' && detail.logs.some(l=>l.kind==='workspace_dirty') && <button className="primary" disabled={disabled} onClick={()=>void perform(async()=>{await api(`/runs/${detail.run.id}/save-continue`,'POST',{});setDetail(null);})}>{tx("Değişiklikleri kaydet ve devam et")}</button>}
              {detail.run.state === 'budget_exceeded' && <p>{tx("İş yarıda kalmış olabilir. Son cevap ve kaydedilen değişiklikler aşağıdadır.")}</p>}
              <p>{tx("Gözlenen kullanım:")} {weightedTokens(detail.run.usage,data.runtime?.settings.cachedInputWeight).toLocaleString(locale())} {tx("ağırlıklı ·")} {usageTotals(detail.run.usage).input_tokens.toLocaleString(locale())} {tx("girdi (önbellekli")} {usageTotals(detail.run.usage).cached_input_tokens.toLocaleString(locale())}{tx(", önbelleksiz")} {usageTotals(detail.run.usage).uncached_input_tokens.toLocaleString(locale())}) · {usageTotals(detail.run.usage).output_tokens.toLocaleString(locale())} {tx("çıktı token")}</p>
              {detail.chain && <ChainList chains={[detail.chain]} data={data} />}
              <pre>{detail.run.output}</pre>
              {detail.logs.map((l) => (
                <details key={l.id}>
                  <summary>
                    {l.kind === "tool"
                      ? tx(toolSummary(l.text))
                      : l.kind === "input"
                        ? tx("Verilen iş")
                        : l.kind === "diagnostic"
                          ? tx("Tanı")
                          : l.kind === "context"
                            ? tx("Talimat ve bağlam boyutu")
                            : tx("Çalışma bilgisi")}
                  </summary>
                  <pre>{l.kind === "context" ? contextText(l.text) : l.text}</pre>
                </details>
              ))}
            </div>
          )}
        </div>
      )}
      {tab === "files" && (
        <>
          <div className="runtime-cards">
            {files.length ? (
              files.map((f) => (
                <article key={f.id} className="runtime-card">
                  <h3>{f.title}</h3>
                  <p>{f.summary}</p>
                  <p>
                    {f.name} · {f.size} {tx("bayt")}
                  </p>
                  <div className="runtime-actions">
                    <a
                      className="secondary"
                      href={`/api/artifacts/${f.id}/download`}
                    >
                      {tx("İndir")}
                    </a>
                    <button
                      className="secondary"
                      onClick={() =>
                        void perform(async () => {
                          const response = await fetch(
                            `/api/artifacts/${f.id}/download`,
                          );
                          if (!response.ok) throw new Error(tx("Çıktı alınamadı."));
                          if (f.mime.startsWith("image/"))
                            setPreview({
                              name: f.name,
                              url: URL.createObjectURL(await response.blob()),
                            });
                          else
                            setPreview({
                              name: f.name,
                              text: await response.text(),
                              markdown: f.mime === "text/markdown",
                            });
                        })
                      }
                    >
                      {tx("Önizle")}
                    </button>
                  </div>
                </article>
              ))
            ) : (
              <p>{tx("Henüz teslim edilen dosya yok.")}</p>
            )}
          </div>
          {preview && (
            <div className="runtime-card">
              <h3>{preview.name}</h3>
              {preview.url ? (
                <img
                  className="artifact-preview"
                  alt={preview.name}
                  src={preview.url}
                />
              ) : preview.markdown ? (
                <MarkdownPreview text={preview.text || ""} />
              ) : (
                <pre>{preview.text}</pre>
              )}
            </div>
          )}
        </>
      )}
      {tab === "memory" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void perform(async () => {
              await api(`/agents/${agent.id}/memory`, "PUT", { text: memory });
            }, tx("Hafıza notu kaydedildi."));
          }}
        >
          <label>
            {tx("Kalıcı kısa not")}
            <textarea
              rows={6}
              maxLength={8000}
              value={memory}
              onChange={(e) => setMemory(e.target.value)}
            />
          </label>
          <button className="primary" disabled={disabled}>
            {tx("Hafızayı kaydet")}
          </button>
        </form>
      )}
    </section>
  );
}
