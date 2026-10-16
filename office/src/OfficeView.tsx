import { t as tx } from "./i18n";
import { api } from "./api";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { Agent, Snapshot, Message } from "../shared/types";
import type { MovementMode } from "./pixel/motion";
import { OFFICE_MAPS } from "./pixel/world";
import { OfficeCanvas } from "./pixel/OfficeCanvas";
import { ChatPanel, type Perform } from "./chat/ChatPanel";
import { storedNumber, savePreference } from "./preferences";

export function OfficeView({
  data,
  loading,
  selected,
  onSelect,
  onApprovals,
  target,
  onTarget,
  onDemoRead,
  demo,
  onDemo,
  disabled,
  perform,
  onTask,
  onTududi,
  onSettings,
}: {
  data: Snapshot;
  loading: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onApprovals: () => void;
  target: string;
  onTarget: (target: string) => void;
  onDemoRead: (ids: string[]) => void;
  demo: boolean;
  onDemo: () => void;
  disabled: boolean;
  perform: Perform;
  onTask: (a: Agent) => void;
  onTududi: (a: Agent) => void;
  onSettings: (view:'usage'|'agents'|'links') => void;
}) {
  const [mobile, setMobile] = useState(
    () => matchMedia("(max-width: 900px)").matches,
  );
  const [mobileTab, setMobileTab] = useState(() => {if(new URLSearchParams(window.location.search).has('oturum'))return 'chat';try{const recipient=sessionStorage.getItem('po-taslak-alici') || 'everyone';if(JSON.parse(sessionStorage.getItem('po-sohbet-taslaklari') || '{}')[recipient])return 'chat';}catch{/* Storage may be unavailable. */}return 'office';});
  const [expanded, setExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const expandedChatPreference=()=>storedNumber("po-buyuk-sohbet-kucuk",1,0,1)===1;
  const [split, setSplit] = useState(() =>
    storedNumber("po-sohbet-oran", 36, 20, 65),
  );
  const [samples, setSamples] = useState<Message[]>([]);
  const [showNames, setShowNames] = useState(() => { try { return localStorage.getItem("po-adlari-goster") !== "false"; } catch { return true; } });
  const [movement, setMovement] = useState<MovementMode>(() => { try { const value = localStorage.getItem("po-hareket"); return value === "canli" || value === "durgun" ? value : "sakin"; } catch { return "sakin"; } });
  const [moreOpen, setMoreOpen] = useState(false);
  const more = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const outside = (e: PointerEvent) => { if (!more.current?.contains(e.target as Node)) setMoreOpen(false); };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); setMoreOpen(false); more.current?.querySelector("button")?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    more.current?.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); more.current?.removeEventListener("keydown", escape); };
  }, [moreOpen]);
  const pendingApprovals = data.runtime?.approvals.filter((a) => a.state === "pending").length || 0;
  const hasWork = !demo && data.runtime?.runs.some((r) => ["running", "queued"].includes(r.state));
  const queueBlock = !demo && (data.runtime?.queueBlocks?.find(b=>b.agent_id===selected) || data.runtime?.queueBlocks?.[0]);
  const runnerProblem = demo ? "" : data.runtime?.protocolError ? tx("Sürüm uyumsuz")
    : data.runtime?.paused ? tx("Çalışmalar durduruldu") : data.runtime?.connecting ? tx("Bağlanıyor…")
      : !data.runtime?.connected ? tx("Bağlı değil") : "";
  const runnerTitle = demo ? tx("Deneme modu gerçek çalışma başlatmaz.") : data.runtime?.protocolError
    || (data.runtime?.paused ? tx("Çalışmalar durduruldu") : data.runtime?.connecting ? tx("Çalıştırıcı bağlanıyor…")
      : data.runtime?.connected ? tx("Çalıştırıcı bağlı") : tx("Çalıştırıcı bağlı değil"));
  useEffect(() => setSamples([]), [demo]);
  useEffect(() => {
    const mq = matchMedia("(max-width: 900px)");
    const change = () => setMobile(mq.matches);
    mq.addEventListener("change", change);
    return () => mq.removeEventListener("change", change);
  }, []);
  const officeData = {
    ...data,
    messages: [...data.messages, ...(demo ? samples : [])],
  };
  const layout = useRef<HTMLDivElement>(null);
  const userSplit = useRef((() => { try { return localStorage.getItem("po-sohbet-oran") !== null; } catch { return false; } })());
  useEffect(() => {
    const element = layout.current!;
    // Preserve a saved or manually selected ratio. On short screens, the initial
    // chat width fills the short edge of the balanced layout.
    const measure = () => {
      if (userSplit.current || element.clientWidth <= 0 || element.clientHeight <= 66) return;
      const available = element.clientWidth - 8;
      const sceneWidth = (element.clientHeight - 66) * OFFICE_MAPS.balanced.cols / OFFICE_MAPS.balanced.rows + 18;
      setSplit(Math.max(20, Math.min(36, (available - sceneWidth) / available * 100)));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    return () => observer.disconnect();
  }, []);
  const chatSlot = useRef<HTMLDivElement>(null);
  const floatSlot = useRef<HTMLDivElement>(null);
  const [chatHost] = useState(() => document.createElement("div"));
  useEffect(() => {
    const focused = document.activeElement as HTMLElement | null;
    const restore = focused && chatHost.contains(focused);
    (expanded ? floatSlot.current : chatSlot.current)?.appendChild(chatHost);
    if (restore) focused.focus({ preventScroll: true });
  }, [expanded, chatHost]);
  const nativeFull = useRef(false);
  const chatCollapsed = useRef(collapsed);
  const lastEscape = useRef(-1000);
  chatCollapsed.current = collapsed;
  const changeTarget = (t: string) => {
    onTarget(t);
    onSelect(t.startsWith("agent:") ? t.slice(6) : null);
    setCollapsed(false);
    setMobileTab("chat");
  };
  useEffect(() => {
    if (selected) onTarget(`agent:${selected}`);
  }, [selected]);
  useEffect(() => {
    if (target !== "everyone") setMobileTab("chat");
    setCollapsed(false);
    if (
      target !== "everyone" &&
      !data.agents.some((a) => target === `agent:${a.id}`) &&
      !data.departments.some((d) => target === `department:${d.id}`)
    ) {
      onTarget("everyone");
      onSelect(null);
    }
  }, [
    target,
    data.agents.map((a) => a.id).join("|"),
    data.departments.map((d) => d.id).join("|"),
  ]);
  const shrink = () => {
    setExpanded(false);
    setCollapsed(false);
    if (document.fullscreenElement)
      void document.exitFullscreen().catch(() => {});
  };
  const enlarge = () => {
    setCollapsed(expandedChatPreference());
    setExpanded(true);
    if (document.documentElement.requestFullscreen)
      void document.documentElement
        .requestFullscreen()
        .then(() => {
          nativeFull.current = true;
        })
        .catch(() => {});
  };
  useEffect(() => {
    if (!expanded) return;
    document.body.classList.add("office-is-expanded");
    return () => document.body.classList.remove("office-is-expanded");
  }, [expanded]);
  useEffect(() => {
    const changed = () => {
      if (nativeFull.current && !document.fullscreenElement) {
        nativeFull.current = false;
        if (performance.now() - lastEscape.current > 350) {
          if (!chatCollapsed.current) setCollapsed(true);
          else shrink();
        }
      }
    };
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector('[role="dialog"]'))
        return;
      e.preventDefault();
      lastEscape.current = performance.now();
      if (!collapsed) setCollapsed(true);
      else shrink();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [collapsed, expanded]);
  useEffect(
    () => () => {
      if (nativeFull.current && document.fullscreenElement)
        void document.exitFullscreen().catch(() => {});
    },
    [],
  );
  const resize = (clientX: number) => {
    const box = layout.current!.getBoundingClientRect();
    const usable = box.width - 8;
    const px = Math.max(
      328,
      Math.min(usable * 0.65, usable - 300, clientX - box.left),
    );
    const next = (px / usable) * 100;
    userSplit.current = true;
    setSplit(next);
    savePreference("po-sohbet-oran", next);
  };
  return (
    <div
      ref={layout}
      className={`office-layout ${expanded ? "is-expanded" : ""} mobile-${mobileTab}`}
      style={{ "--chat-split": `${split}%` } as CSSProperties}
    >
      <div
        className="office-mobile-tabs"
        role="tablist"
        aria-label={tx("Ofis bölmeleri")}
      >
        <button
          role="tab"
          aria-selected={mobileTab === "chat"}
          onClick={() => setMobileTab("chat")}
        >
          {tx("Sohbet")}
        </button>
        <button
          role="tab"
          aria-selected={mobileTab === "office"}
          onClick={() => setMobileTab("office")}
        >
          {tx("Ofis")}
        </button>
      </div>
      <div
        ref={chatSlot}
        className="chat-slot"
        hidden={!expanded && mobile && mobileTab !== "chat"}
      />
      <div
        className="office-divider"
        role="separator"
        tabIndex={0}
        aria-label={tx("Sohbet bölmesinin genişliği")}
        aria-orientation="vertical"
        aria-valuemin={20}
        aria-valuemax={65}
        aria-valuenow={Math.round(split)}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          resize(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) resize(e.clientX);
        }}
        onKeyDown={(e) => {
          if (["ArrowLeft", "ArrowRight", "Home"].includes(e.key)) {
            e.preventDefault();
            const next =
              e.key === "Home"
                ? 36
                : Math.max(
                    20,
                    Math.min(65, split + (e.key === "ArrowLeft" ? -2 : 2)),
                  );
            userSplit.current = true;
            setSplit(next);
            savePreference("po-sohbet-oran", next);
          }
        }}
      />
      <section
        className={`office-scene ${expanded ? "office-expanded" : ""}`}
        aria-label={tx("Canlı ofis")}
        hidden={!expanded && mobile && mobileTab !== "office"}
      >
        <div className="scene-heading">
          <h1 className="office-name" title={tx("Piksel Ofis")}>{tx("Piksel Ofis")}</h1>
          <div className="runner-strip">
            <span className="office-status-pill office-status-text">{data.agents.some(a=>a.status==='calisiyor') ? tx("{0} ajan çalışıyor", [data.agents.filter(a=>a.status==='calisiyor').length]) : tx("Ofis beklemede")}</span>
            <span className={`runner-status ${runnerProblem ? "problem" : ""}`} title={runnerTitle} aria-label={runnerTitle} role="status">
              <i aria-hidden="true" />{runnerProblem && <span>{runnerProblem}</span>}
            </span>
            {!demo && data.runtime?.director && <button className="secondary" role="switch" aria-label={tx("Genel Müdür otomatik modu")} aria-checked={data.runtime.director.auto} disabled={disabled} onClick={()=>void perform(async()=>{await api('/director/auto','POST',{enabled:!data.runtime!.director!.auto});})}>{tx("Oto")} {data.runtime.director.auto?tx("açık"):tx("kapalı")}</button>}
            {pendingApprovals > 0 && <button className="secondary approval-badge" onClick={onApprovals}>{tx("Onay ·")} {pendingApprovals}</button>}
            {hasWork && <button className="secondary stop-all" aria-label={tx("Tümünü durdur")} disabled={disabled} onClick={() => void perform(async () => {
              await api("/runtime/stop", "POST");
            })}><span className="full-label">{tx("Tümünü durdur")}</span><span className="short-label">{tx("Durdur")}</span></button>}
          </div>
          <div className="office-more" ref={more}>
            <button className="secondary" aria-label={tx("Ofis işlemleri")} aria-expanded={moreOpen} aria-controls="office-actions" onClick={() => setMoreOpen(!moreOpen)}>⋯</button>
            {moreOpen && <div className="office-actions" id="office-actions">
              <button role="switch" aria-checked={showNames} onClick={() => { const value = !showNames; setShowNames(value); savePreference("po-adlari-goster", String(value)); }}>{tx("Adları göster")} <span aria-hidden="true">{showNames ? "✓" : "—"}</span></button>
              {([['sakin', 'sakin'], ['canli', tx("canlı")], ['durgun', 'durgun']] as const).map(([value, label]) => <button key={value} role="radio" aria-checked={movement === value} onClick={() => { setMovement(value); savePreference("po-hareket", value); }}>{tx("Hareket:")} {label}<span aria-hidden="true">{movement === value ? '✓' : ''}</span></button>)}
              <button onClick={() => { setMoreOpen(false); onDemo(); }}>{demo ? tx("Bitir") : tx("Deneme modu")}</button>
              {!demo && data.runtime?.paused && <button disabled={disabled} onClick={() => void perform(async () => {
                await api("/runtime/resume", "POST"); setMoreOpen(false);
              })}>{tx("Devam et")}</button>}
            </div>}
          </div>
          <button
            className="secondary expand-button"
            aria-label={expanded ? tx("Küçült") : tx("Büyüt")}
            title={expanded ? tx("Küçült") : tx("Büyüt")}
            onClick={expanded ? shrink : enlarge}
          >
            <span className="action-label">{expanded ? tx("Küçült") : tx("Büyüt")}</span>{" "}
            <span aria-hidden="true">{expanded ? "↙" : "↗"}</span>
          </button>
        </div>
        {queueBlock && <p className="office-queue-status" role="status">{queueBlock.reason}<button className="secondary" onClick={()=>onSettings(queueBlock.setting)}>{queueBlock.setting === "usage" ? tx("Kullanım ayarını aç") : queueBlock.setting === "agents" ? tx("Ajan ayarını aç") : tx("Bağlantıları aç")}</button></p>}
        <div className="office-stage">
          <OfficeCanvas
            directorTerminalEnabled={!demo}
            directorAuto={data.runtime?.director?.auto}
            directorQuestions={data.runtime?.director?.owner_questions || 0}
            workChains={Array.from(new Set((data.runtime?.runs || []).filter(r=>r.state === "running").map(r=>r.chain_id))).map(id=>({id,agents:[...new Set((data.runtime?.runs || []).filter(r=>r.chain_id===id).map(r=>r.agent_id))]}))}
            movement={movement}
            showNames={showNames}
            departments={data.departments}
            agents={data.agents}
            scheduledAgents={(data.runtime?.runs || []).filter(r=>r.state==="running" && r.scheduled_task_id).map(r=>r.agent_id)}
            queuedAgents={(data.runtime?.runs || []).filter((r) => r.state === "queued").map((r) => r.agent_id)}
            messages={officeData.messages}
            events={data.events}
            selected={selected}
            onSelect={(id) => changeTarget(`agent:${id}`)}
            onDepartment={(id) => changeTarget(`department:${id}`)}
          />
          <div ref={floatSlot} className="float-slot" />
        </div>
      </section>
      {createPortal(
        <ChatPanel
          onSettings={onSettings}
          data={officeData}
          loading={loading}
          onSamples={(messages) => setSamples((old) => [...old, ...messages])}
          target={target}
          onTarget={changeTarget}
          collapsed={expanded ? collapsed : mobile && mobileTab !== "chat"}
          onCollapse={value=>{setCollapsed(value);if(expanded)savePreference("po-buyuk-sohbet-kucuk",value?1:0);}}
          floating={expanded}
          onDemoRead={onDemoRead}
          demo={demo}
          disabled={disabled}
          perform={perform}
          onTask={onTask}
          onTududi={(a) => {
            shrink();
            onTududi(a);
          }}
        />,
        chatHost,
      )}
    </div>
  );
}
