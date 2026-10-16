import { t as tx, locale } from "../i18n";
import { SessionPanel, TududiLogin } from "../SessionPanel";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Agent, Message, Snapshot } from "../../shared/types";
import { statusLabels } from "../../shared/types";
import { toolSummary } from "../../shared/runtime";
import { Avatar } from "../pixel/OfficeCanvas";
import { api } from "../api";
import {
  messageResponses,
  chatTimeline, dayKey, dayLabel, sameSender, senderName, shortReason, type ChatEvent,
  inConversation,
  insertMention,
  isIncoming,
  mentionSuggestions,
  recipientFor,
  unreadMessages,
} from "./model";
import { MessageBody } from "./Markdown";
export type Perform = (
  action: () => Promise<void>,
  success?: string,
  background?: boolean,
) => Promise<void>;
function OutputCard({ artifact, perform }: { artifact: import("../../shared/runtime").Artifact; perform: Perform }) {
  const [preview, setPreview] = useState<{ text?: string; url?: string } | null>(null);
  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url); }, [preview]);
  return <article className="output-card">
    <strong>{artifact.name}</strong> · {artifact.size.toLocaleString(locale())} {tx("bayt")}
    <div className="runtime-actions">
      <a href={`/api/artifacts/${artifact.id}/download`}>{tx("İndir")}</a>
      <button className="secondary" onClick={() => void perform(async () => {
        const response = await fetch(`/api/artifacts/${artifact.id}/download`);
        if (!response.ok) throw new Error(tx("Çıktı alınamadı."));
        setPreview(artifact.mime.startsWith("image/") ? { url: URL.createObjectURL(await response.blob()) } : { text: await response.text() });
      })}>{tx("Önizle")}</button>
      {preview && <button className="secondary" onClick={() => setPreview(null)}>{tx("Kapat")}</button>}
    </div>
    {preview?.url && <img className="artifact-preview" alt={artifact.name} src={preview.url} />}
    {preview?.text !== undefined && <pre>{preview.text}</pre>}
  </article>;
}
function EventRow({ events, data, demo, perform }: { events: ChatEvent[]; data: Snapshot; demo: boolean; perform: Perform }) {
  const [open, setOpen] = useState(false);
  const first = events[0];
  const heading = events.length > 1
    ? `${events.length} ${first.kind === "run_failed" ? tx("başarısız çalışma") : first.kind === "system" ? "bildirim" : first.kind === "run_budget_exceeded" ? tx("bütçede kesilen çalışma") : tx("durdurulan çalışma")}`
    : first.kind === "system" ? shortReason(first.text)
      : `${senderName({ sender_agent_id: first.agent_id }, data.agents)} ${first.kind === "run_failed" ? tx("çalışamadı") : first.kind === "run_budget_exceeded" ? tx("bütçede kesildi") : "durdu"}: ${shortReason(first.text)}`;
  const retry = (event: ChatEvent) => {
    const message = data.messages.find((m) => m.id === event.message_id);
    return !demo && message && data.agents.some((a) => a.id === event.agent_id && a.active)
      && messageResponses(message, data).some((r) => r.agent_id === event.agent_id && r.retry);
  };
  const retryButton = (event: ChatEvent) => retry(event) && <button type="button" onClick={() => void perform(async () => {
    await api(`/messages/${event.message_id}/retry`, "POST", { agent_id: event.agent_id });
  })}>{tx("Yeniden dene")}</button>;
  return <div className="chat-event">
    <div className="event-line">
      <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        {first.kind === "run_failed" ? <path d="M10 2 19 18H1Z" /> : <circle cx="10" cy="10" r="8" />}
        <path d="M10 7v5m0 2v1" />
      </svg>
      <span className="event-summary" title={heading}>{heading}</span>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? tx("Gizle") : events.length > 1 ? tx("Göster") : tx("Ayrıntı")}</button>
      {events.length === 1 && retryButton(first)}
    </div>
    {open && <div className="event-details">{events.map((event) => <div key={event.id}>
      <time>{new Date(event.created_at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" })}</time>{" "}
      {event.kind !== "system" && `${senderName({ sender_agent_id: event.agent_id }, data.agents)}: `}{event.text}
      {events.length > 1 && retryButton(event)}
    </div>)}</div>}
  </div>;
}
export function ChatPanel({
  data,
  loading,
  target,
  onTarget,
  collapsed,
  onCollapse,
  demo,
  disabled,
  perform,
  onTask,
  onTududi,
  onSettings,
  onSamples,
  floating,
  onDemoRead,
}: {
  floating: boolean;
  onDemoRead: (ids: string[]) => void;
  data: Snapshot;
  loading: boolean;
  target: string;
  onTarget: (target: string) => void;
  collapsed: boolean;
  onCollapse: (value: boolean) => void;
  demo: boolean;
  disabled: boolean;
  perform: Perform;
  onTask: (a: Agent) => void;
  onTududi: (a: Agent) => void;
  onSettings: (view:'usage'|'agents'|'links') => void;
  onSamples: (messages: Message[]) => void;
}) {
  const [tabs, setTabs] = useState<string[]>(["everyone"]),
    [text, setText] = useState(()=>{try{return JSON.parse(sessionStorage.getItem("po-sohbet-taslaklari") || "{}")[target] || "";}catch{return "";}}),
    [caret, setCaret] = useState(0),
    [choice, setChoice] = useState(0);
  const [localRead, setLocalRead] = useState(new Set<string>()),
    [sending, setSending] = useState(false);
  const [sessionView,setSessionView] = useState(() => new URLSearchParams(window.location.search).has('oturum'));
  useEffect(()=>{const linked=new URLSearchParams(window.location.search).get('oturum');setSessionView(!!linked && target===`agent:${linked}`);},[target]);
  const [newMessages, setNewMessages] = useState(0), [sendNote, setSendNote] = useState("");
  const input = useRef<HTMLTextAreaElement>(null),
    compose = useRef<HTMLFormElement>(null),
    log = useRef<HTMLDivElement>(null),
    nearBottom = useRef(true),
    scrollTarget = useRef(""),
    seenItems = useRef(new Set<string>()),
    pendingReads = useRef(new Set<string>()),
    drafts = useRef(new Map<string,string>((()=>{try{return Object.entries(JSON.parse(sessionStorage.getItem("po-sohbet-taslaklari") || "{}")) as [string,string][];}catch{return [];}})())),
    lastTarget = useRef(target);
  const previousDemo=useRef(demo);
  useEffect(()=>{
    if(demo || previousDemo.current)return;
    const save=(event?:Event)=>{drafts.current.set(lastTarget.current,text);try {sessionStorage.setItem('po-sohbet-taslaklari',JSON.stringify(Object.fromEntries(drafts.current)));sessionStorage.setItem('po-taslak-alici',lastTarget.current);}catch {event?.preventDefault();}};
    save();window.addEventListener('ofis-taslak-sakla',save);return()=>window.removeEventListener('ofis-taslak-sakla',save);
  },[text,target,demo]);
  useEffect(()=>{
    const element=compose.current;if(!element)return;
    const observer=new ResizeObserver(()=>document.body.style.setProperty('--po-compose-height',`${element.offsetHeight}px`));
    observer.observe(element);return()=>{observer.disconnect();document.body.style.removeProperty('--po-compose-height');};
  },[]);
  const messages = [...data.messages].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
  const shown = messages.filter((m) => inConversation(m, target)),
    unread = unreadMessages(messages, localRead);
  const timeline = chatTimeline(data, target);
  const itemIds = timeline.flatMap((item) => item.type === "message" ? [item.message.id] : item.events.map((e) => e.id));
  const recipient = recipientFor(target, data),
    agent = data.agents.find(
      (a) =>
        recipient.recipient_type === "agent" && a.id === recipient.recipient_id,
    ),
    department = data.departments.find(
      (d) =>
        recipient.recipient_type === "department" &&
        d.id === recipient.recipient_id,
    );
  const suggestions = mentionSuggestions(text, caret, data.agents);
  const activeRuns = (data.runtime?.runs || []).filter((r) => ["running", "queued"].includes(r.state)
    && r.conversation_type === recipient.recipient_type && r.conversation_id === recipient.recipient_id);
  const scrollDown = () => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
    nearBottom.current = true; setNewMessages(0);
  };
  const stop = () => void perform(async () => { await api("/conversations/stop", "POST", recipient); });
  useEffect(() => {
    setLocalRead(new Set());
    if(demo)drafts.current.clear();
    if(demo)setText("");
    else if(previousDemo.current){
      try{drafts.current=new Map(Object.entries(JSON.parse(sessionStorage.getItem('po-sohbet-taslaklari') || '{}')));setText(drafts.current.get(target) || '');}catch{setText('');}
    }
    previousDemo.current=demo;
  }, [demo]);
  useEffect(() => {
    setTabs((old) => [
      ...new Set([
        ...old.filter(
          (t) =>
            t === "everyone" ||
            recipientFor(t, data).recipient_type !== "everyone",
        ),
        target,
      ]),
    ]);
    if (lastTarget.current !== target) {
      drafts.current.set(lastTarget.current, text);
      setText(drafts.current.get(target) || "");
      lastTarget.current = target;
      setCaret(0);
    }
  }, [
    target,
    data.agents.map((a) => a.id).join("|"),
    data.departments.map((d) => d.id).join("|"),
  ]);
  useLayoutEffect(() => {
    if (collapsed || !log.current) return;
    const changed = scrollTarget.current !== target;
    const added = itemIds.filter((id) => !seenItems.current.has(id)).length;
    if (changed || nearBottom.current) scrollDown();
    else if (added) setNewMessages((old) => old + added);
    if (changed) setSendNote("");
    scrollTarget.current = target;
    seenItems.current = new Set(itemIds);
  }, [itemIds.join("|"), target, collapsed, activeRuns.map((r) => `${r.id}:${r.output}`).join("|")]);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el || collapsed) return;
    const measure = () => {
      el.style.height = "auto";
      el.style.height = `${Math.min(180, Math.max(40, el.scrollHeight))}px`;
      if (nearBottom.current && log.current) log.current.scrollTop = log.current.scrollHeight;
    };
    let width = -1;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      measure();
    });
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [text, collapsed, floating]);
  useLayoutEffect(() => {
    const el = compose.current;
    if (!el) return;
    const measure = () => el.closest<HTMLElement>(".floating-chat")?.style.setProperty("--compose-height", `${el.offsetHeight}px`);
    const observer = new ResizeObserver(measure); observer.observe(el); measure();
    return () => observer.disconnect();
  }, [collapsed]);
  useEffect(() => {
    if (collapsed) return;
    const ids = unread
      .filter(
        (m) => inConversation(m, target) && !pendingReads.current.has(m.id),
      )
      .map((m) => m.id);
    if (!ids.length) return;
    if (demo) {
      setLocalRead((old) => new Set([...old, ...ids]));
      onDemoRead(ids);
      return;
    }
    ids.forEach((id) => pendingReads.current.add(id));
    void perform(async () => {
      try {
        for (const id of ids) await api(`/messages/${id}/read`, "POST");
      } finally {
        ids.forEach((id) => pendingReads.current.delete(id));
      }
    },undefined,true);
  }, [
    shown.map((m) => `${m.id}:${m.read_by?.includes("owner")}`).join("|"),
    target,
    collapsed,
    demo,
  ]);
  const label = (t: string) => {
    const r = recipientFor(t, data);
    return r.recipient_type === "everyone"
      ? tx("Genel")
      : r.recipient_type === "agent"
        ? data.agents.find((a) => a.id === r.recipient_id)?.name || tx("Ajan")
        : data.departments.find((d) => d.id === r.recipient_id)?.name ||
          tx("Bölüm");
  };
  const send = async () => {
    if (!text.trim() || sending || disabled) return;
    const value = text.trim(),
      to = recipientFor(target, data);
    const greeter = department ? department.responsible_agent_id : data.runtime?.settings.greeterAgentId;
    const hasMention = data.agents.some((a) => (!department || a.department_id === department.id)
      && (value.includes(`@${a.name}`) || value.includes(`@${a.id}`)));
    setSendNote(!demo && !agent && !hasMention && !data.agents.some((a) => a.id === greeter && a.active)
      ? tx("Cevap almak için @ ile bir ajan seçin.") : "");
    nearBottom.current = true;
    setSending(true);
    try {
      if (demo) {
        const now = Date.now(),
          user: Message = {
            id: `demo-user-${now}`,
            sender_agent_id: null,
            sender_type: "user",
            ...to,
            text: value,
            created_at: new Date(now).toISOString(),
            read_at: null,
          };
        const responder =
          agent ||
          data.agents.find(
            (a) => !department || a.department_id === department.id,
          );
        onSamples([
          user,
          ...(responder
            ? [
                {
                  ...user,
                  id: `demo-reply-${now}`,
                  sender_type: "agent" as const,
                  sender_agent_id: responder.id,
                  text: tx("Bu bir deneme cevabı. Mesajını aldım; birlikte inceleyebiliriz."),
                  created_at: new Date(now + 1).toISOString(),
                },
              ]
            : []),
        ]);
        setText("");
        drafts.current.delete(target);
      } else
        await perform(async () => {
          await api("/messages", "POST", { ...to, text: value });
          setText("");
          drafts.current.delete(target);
        });
    } finally {
      setSending(false);
    }
  };
  const choose = (a: Agent) => {
    const value = insertMention(text, caret, a.name);
    drafts.current.set(`agent:${a.id}`, value);
    onTarget(`agent:${a.id}`);
    setText(value);
    setCaret(value.length);
    setChoice(0);
    input.current?.focus();
  };
  const total = unread.length;
  if (collapsed)
    return (
      <>
      {!demo && activeRuns.length > 0 && <button className="chat-launcher-stop" onClick={stop}>{tx("Durdur")}</button>}
      <button
        className="chat-launcher"
        onClick={() => onCollapse(false)}
        aria-label={tx("Sohbeti aç{0}", [total ? tx(", {0} okunmamış mesaj", [total]) : ""])}
      >
        ◌ <span>{tx("Sohbet")}</span>
        {total > 0 && <b>{total}</b>}
      </button>
      </>
    );
  return (
    <section className="floating-chat" aria-label={tx("Ofis sohbeti")}>
      <div className={`conversation-heading${agent ? ' has-agent' : ''}`}>
        {agent && <Avatar appearance={agent.appearance} size={32} />}
        <div className="conversation-name">
          <h2
            title={agent ? agent.name : department ? department.name : tx("Genel")}
          >
            {agent ? agent.name : department ? department.name : tx("Genel")}
          </h2>
          {agent && (
            <small
              title={`${agent.title} · ${tx(statusLabels[agent.status])} · ${agent.current_job || tx("Henüz bir iş bildirilmedi.")}`}
            >
              <i className={`tiny-status ${agent.status}`} />
              {agent.title} · {tx(statusLabels[agent.status])}
            </small>
          )}
        </div>
        {agent ? (
          <div className="chat-shortcuts">
            <button onClick={() => onTask(agent)} disabled={demo || disabled}>
              {tx("Görev ver")}
            </button>
            <button onClick={()=>setSessionView(v=>!v)}>{sessionView ? tx("Sohbet") : tx("Oturum")}</button>
            <button onClick={() => onTududi(agent)} disabled={demo || disabled}>
              {tx("Görevler")}
            </button>
            <TududiLogin agent={agent} perform={perform} disabled={demo || disabled} />
          </div>
        ) : (
          <div
            className="conversation-members"
            aria-label={tx("{0} katılımcı", [data.agents.filter((a) => !department || a.department_id === department.id).length])}
          >
            {data.agents
              .filter((a) => !department || a.department_id === department.id)
              .slice(0, 4)
              .map((a) => (
                <span key={a.id} title={a.name}>
                  <Avatar appearance={a.appearance} size={26} />
                </span>
              ))}
            <small>
              {
                data.agents.filter(
                  (a) => !department || a.department_id === department.id,
                ).length
              }{" "}
              {tx("kişi")}
            </small>
          </div>
        )}
        {floating && (
          <button
            className="icon-button"
            aria-label={tx("Sohbeti küçült")}
            onClick={() => onCollapse(true)}
          >
            −
          </button>
        )}
        {!demo && activeRuns.length > 0 && <button className="chat-stop" disabled={disabled} onClick={stop}>{tx("Durdur")}</button>}
      </div>
      {floating && (
        <div className="chat-tabs" role="tablist" aria-label={tx("Sohbetler")}>
          {tabs.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={t === target}
              onClick={() => onTarget(t)}
            >
              {label(t)}
            </button>
          ))}
        </div>
      )}
      {sessionView && agent ? <SessionPanel agent={agent} data={data} perform={perform} disabled={demo || disabled} /> : <>
      <div
        ref={log}
        className="chat-messages"
        role="log"
        aria-label={tx("Yazışmalar")}
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          nearBottom.current = el.scrollHeight - el.clientHeight - el.scrollTop < 48;
          if (nearBottom.current) setNewMessages(0);
        }}
      >
        {timeline.length ? timeline.map((item, index) => {
          const previous = timeline[index - 1];
          const date = item.type === "message" ? item.message.created_at : item.events[0].created_at;
          const previousDate = previous && (previous.type === "message" ? previous.message.created_at : previous.events.at(-1)!.created_at);
          const m = item.type === "message" ? item.message : null;
          const author = data.agents.find((a) => a.id === m?.sender_agent_id);
          const grouped = m && previous?.type === "message" && sameSender(previous.message, m);
          return <Fragment key={m?.id || (item.type === "events" ? item.events[0].id : index)}>
            {(!previousDate || dayKey(previousDate) !== dayKey(date)) && <div className="chat-day">{dayLabel(date)}</div>}
            {item.type === "events" ? <EventRow events={item.events} data={data} demo={demo} perform={perform} /> : m &&
            <div className={`message ${isIncoming(m) ? "" : "mine"} ${grouped ? "grouped" : ""}`}>
              {!grouped && <div className={`message-author ${isIncoming(m) && !author ? "deleted-author" : ""}`}>
                {isIncoming(m) && author && <Avatar appearance={author.appearance} size={24} />}
                <span className="message-sender" title={isIncoming(m) ? senderName(m, data.agents) : tx("Siz")}>{isIncoming(m) ? senderName(m, data.agents) : tx("Siz")}</span>
                <time>{new Date(m.created_at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" })}</time>
              </div>}
              <div className="message-bubble"><MessageBody text={m.text} markdown={isIncoming(m)} /></div>
              {(m.artifact_ids || []).map((id) => { const artifact = data.runtime?.artifacts.find((a) => a.id === id); return artifact ? <OutputCard key={id} artifact={artifact} perform={perform} /> : null; })}
              {m.sender_type === "user" && !demo && <div className="message-status">
                {messageResponses(m, data).map((response, i) => <div key={i}>{response.text}{response.saveRun && <button onClick={()=>void perform(async()=>{await api(`/runs/${response.saveRun}/save-continue`,"POST",{});})}>{tx("Değişiklikleri kaydet ve devam et")}</button>}{response.setting && <button onClick={()=>onSettings(response.setting!)}>{response.setting === 'usage' ? tx("Kullanım ayarını aç") : response.setting === 'agents' ? tx("Ajan ayarını aç") : tx("Bağlantıları aç")}</button>}{response.retry && <button onClick={() => void perform(async () => { await api(`/messages/${m.id}/retry`, "POST", { agent_id: response.agent_id }); })}>{tx("Yeniden dene")}</button>}</div>)}
                {m.response_note && <span>{m.response_note}{m.response_note.startsWith(tx("Başarısız")) && <button onClick={() => void perform(async () => { await api(`/messages/${m.id}/retry`, "POST"); })}>{tx("Yeniden dene")}</button>}</span>}

              </div>}
              {!isIncoming(m) && <small className="message-receipt">{m.read_by?.some((id) => id !== "owner") ? tx("Okundu") : tx("İletildi")}</small>}
            </div>
            }
          </Fragment>;
        }) : <div className="chat-welcome" role="status">{loading ? tx("Sohbet yükleniyor…") : tx("Henüz mesaj yok. Bir mesaj yazın.")}</div>}
        {!demo &&
          (data.runtime?.runs || [])
            .filter(
              (r) =>
                r.state === "running" &&
                r.conversation_type === recipient.recipient_type &&
                r.conversation_id === recipient.recipient_id,
            )
            .map((r) => (
              <div className="chat-progress" key={r.id}>
                <strong>
                  {data.agents.find((a) => a.id === r.agent_id)?.name} {tx("yazıyor…")}
                </strong>
                <p>{r.output.slice(-6000) || tx("İşi inceliyor…")}</p>
                <details className="chat-tools">
                  <summary>{tx("Araç kullanımı ·")} {r.calls}</summary>
                  {(data.runtime?.activity || [])
                    .filter((l) => l.run_id === r.id)
                    .slice(0, 10)
                    .map((l) => (
                      <details key={l.id}>
                        <summary>
                          {tx(toolSummary(l.text))}
                        </summary>
                        <p>{l.text}</p>
                      </details>
                    ))}
                </details>
              </div>
            ))}
      </div>
      {newMessages > 0 && <button className="new-messages" type="button" onClick={scrollDown}>{newMessages} {tx("yeni mesaj ↓")}</button>}
      <form
        ref={compose}
        className="chat-compose"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <div className="compose-field" data-focus-container>
        <div className="recipient-picker">
        <label htmlFor="chat-target" className="recipient-caption">{tx("Kime:")}</label>
        <label className="sr-only" htmlFor="chat-target">
          {tx("Mesajın alıcısı")}
        </label>
        <select
          id="chat-target"
          value={target}
          onChange={(e) => onTarget(e.target.value)}
          aria-label={tx("Mesajın alıcısı")}
          title={tx("Kime: {0}", [target === "everyone" ? tx("Herkes") : label(target)])}
        >
          <option value="everyone">{tx("Herkes")}</option>
          {data.departments.map((d) => (
            <option key={d.id} value={`department:${d.id}`}>
              {d.name} {tx("bölümüne")}
            </option>
          ))}
          {data.agents.map((a) => (
            <option key={a.id} value={`agent:${a.id}`}>
              {a.name}
            </option>
          ))}
        </select>
        </div>
          <label className="sr-only" htmlFor="chat-text">
            {tx("Mesajınız")}
          </label>
          <textarea
            id="chat-text"
            ref={input}
            rows={1}
            placeholder={tx("Mesaj yazın… @ ile ajan seçin")}
            value={text}
            maxLength={10000}
            disabled={loading || disabled || sending}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
              setChoice(0);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            aria-controls={suggestions.length ? "mention-options" : undefined}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (
                suggestions.length &&
                ["ArrowDown", "ArrowUp"].includes(e.key)
              ) {
                e.preventDefault();
                setChoice(
                  (old) =>
                    (old +
                      (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) %
                    suggestions.length,
                );
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (suggestions.length)
                  choose(suggestions[choice % suggestions.length]);
                else void send();
              }
            }}
          />
          <button
            className="send-button"
            aria-label={tx("Mesajı gönder")}
            disabled={loading || disabled || sending || !text.trim()}
          >
            ↑
          </button>
        </div>
        {suggestions.length > 0 && (
          <div
            className="mention-list"
            id="mention-options"
            role="listbox"
            aria-label={tx("Ajan önerileri")}
          >
            {suggestions.map((a, i) => (
              <button
                key={a.id}
                type="button"
                role="option"
                aria-selected={choice % suggestions.length === i}
                onClick={() => choose(a)}
              >
                <Avatar appearance={a.appearance} size={28} />
                <span>
                  {a.name}
                  <small>{a.title}</small>
                </span>
              </button>
            ))}
          </div>
        )}
        {sendNote && <p className="chat-help" role="status">{sendNote}</p>}
      </form>
      </>}
    </section>
  );
}
