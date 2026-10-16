import { FactoryResetPanel } from './FactoryResetPanel';
import type { ResetView } from '../shared/factory-reset';
import { LanguageButton } from "./LanguageButton";
import { t as tx, locale, useLanguage, setLanguage } from "./i18n";
import { DirectorTerminal } from "./DirectorTerminal";
import { toolGroups,toolGroupLabels } from "../shared/director";
import { createPortal } from 'react-dom';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
  type CSSProperties,
} from "react";
import type {
  Agent,
  Department,
  Snapshot,
  TududiData,
  Task,
} from "../shared/types";
import {
  statusLabels,
  statuses,
  hairStyles,
  hairLabels,
  type Appearance,
} from "../shared/types";
import { api, ApiError } from "./api";
import { Avatar } from "./pixel/OfficeCanvas";
import { SchedulesPanel } from "./SchedulesPanel";
import { ThemeButton } from "./ThemeButton";
import { OfficeView } from "./OfficeView";
import { CharacterGallery } from "./pixel/CharacterGallery";
import { demoSnapshot } from "./demo";
import { inConversation, unreadMessages } from "./chat/model";
import { ScrollList } from "./chat/ScrollList";
import { storedNumber, savePreference } from "./preferences";
import {
  Approvals,
  Links,
  Usage,
  RuntimeSettings,
  AgentWork,
} from "./RuntimePanel";
import { SessionPanel, TududiLogin } from "./SessionPanel";
import { NotebookPanel } from "./NotebookPanel";
import { defaultPolicy, defaultSettings } from "../shared/runtime";
import "./runtime.css";
type View =
  | "office"
  | "agents"
  | "departments"
  | "tududi"
  | "rules"
  | "events"
  | "templates"
  | "skills"
  | "schedules"
  | "usage"
  | "links"
  | "approvals"
  | "notebook";
const upcoming = [
  {
    id: "templates" as const,
    get label() { return tx("Hazır ajan şablonları"); },
    icon: "people",
    get description() { return tx("Bir rol seçerek ekibinize yeni bir ajan ekleyin."); },
    get items() { return [
      tx("Araştırmacı, tasarımcı ve yazılım uzmanı rolleri"),
      tx("Kendi talimatlarınıza göre düzenleme"),
      tx("Projeler arasında yeniden kullanma"),
    ]; },
  },
  {
    id: "skills" as const,
    get label() { return tx("Beceriler"); },
    icon: "book",
    get description() { return tx("Ekibinize yeni yetenekler tanımlayın ve paylaştırın."); },
    get items() { return [
      tx("Bir beceriyi birden çok ajana verme"),
      tx("Kaynak okuma, rapor yazma ve içerik hazırlama"),
      tx("Ekibinizin yeteneklerini birlikte görme"),
    ]; },
  },
  {
    id: "usage" as const,
    get label() { return tx("Kullanım ve kota"); },
    icon: "grid",
    get description() { return tx("Ekibinizin kullanımını ve çalışma sınırlarını takip edin."); },
    get items() { return [
      tx("Ajan ve proje bazında kullanım özeti"),
      tx("Çalışma sınırları belirleme"),
      tx("Sınıra yaklaşınca bildirim alma"),
    ]; },
  },
];
type Perform = (action: () => Promise<void>, success?: string) => Promise<void>;
const navigation: { id: View; label: string; icon: string }[] = [
  { id: "office", get label() { return tx("Ofis"); }, icon: "office" },
  { id: "agents", get label() { return tx("Ajanlar"); }, icon: "people" },
  { id: "departments", get label() { return tx("Bölümler"); }, icon: "grid" },
  { id: "schedules", get label() { return tx("Zamanlanmış görevler"); }, icon: "clock" },
  { id: "tududi", get label() { return tx("Görevler ve notlar"); }, icon: "check" },
  { id: "approvals", get label() { return tx("Onay kutusu"); }, icon: "inbox" },
  { id: "rules", get label() { return tx("Şirket kuralları"); }, icon: "book" },
  { id: "links", get label() { return tx("Bağlantılar"); }, icon: "link" },
  { id: "usage", get label() { return tx("Kullanım ve kota"); }, icon: "chart" },
  { id: "notebook", get label() { return tx("Özetler ve ortak defter"); }, icon: "book" },
  { id: "events", get label() { return tx("Olaylar"); }, icon: "clock" },
];
const empty: Snapshot = {
  departments: [],
  agents: [],
  messages: [],
  events: [],
  handoffs: [],
  rules: "",
};
const date = (value: string) =>
  new Date(value).toLocaleString(locale(), {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    office: (
      <>
        <path d="M3 21V7h18v14M7 7V3h10v4M2 21h20M8 11h2m4 0h2M8 15h2m4 0h2M10 21v-3h4v3" />
      </>
    ),
    people: (
      <>
        <circle cx="9" cy="7" r="3" />
        <path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-4-5" />
      </>
    ),
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    check: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <path d="m7 12 3 3 7-7" />
      </>
    ),
    book: (
      <>
        <path d="M12 5c-3-3-7-2-10-1v16c3-1 7-2 10 1 3-3 7-2 10-1V4c-3-1-7-2-10 1v16" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 6v6l4 2" />
      </>
    ),
    sidebar: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></>,
    inbox: <><path d="M4 4h16l2 12v4H2v-4L4 4ZM2 16h6l2 3h4l2-3h6" /><path d="M8 9h8" /></>,
    link: <><path d="m9 15 6-6M8 13l-3 3a3 3 0 0 0 4 4l4-4M11 8l4-4a3 3 0 0 1 4 4l-3 3" /></>,
    chart: <><path d="M3 3v18h18M7 16v-4m5 4V6m5 10V9" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    send: (
      <>
        <path d="m3 3 19 9-19 9 4-9-4-9ZM7 12h15" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    arrow: <path d="m9 5 7 7-7 7" />,
    play: <path d="m8 4 12 8-12 8V4Z" />,
    exit: (
      <>
        <path d="M9 4H4v16h5M13 12h8m-4-4 4 4-4 4" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.office}
    </svg>
  );
}
function Modal({
  title,
  children,
  onClose,
  sheet = false,
}: {
  sheet?: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const old = document.activeElement as HTMLElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const box = ref.current!;
    const first = box.querySelector<HTMLElement>(
      "input,button,select,textarea",
    );
    first?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
      if (event.key === "Tab") {
        const all = [
          ...box.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]",
          ),
        ];
        if (event.shiftKey && document.activeElement === all[0]) {
          event.preventDefault();
          all.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === all.at(-1)) {
          event.preventDefault();
          all[0]?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      document.body.style.overflow = overflow;
      old?.focus();
    };
  }, []);
  return (
    <div
      className={`modal-shade ${sheet ? "sheet-shade" : ""}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal ${sheet ? "agent-sheet" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label={tx("Pencereyi kapat")}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
function Status({ agent }: { agent: Agent }) {
  return (
    <span className={`status status-${agent.status}`}>
      <i />
      {tx(statusLabels[agent.status])}
    </span>
  );
}
function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name="office" size={30} />
      </div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}
function Heading({
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
      </div>
      {children}
    </div>
  );
}
function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="login-screen">
      <header className="login-header">
        <div className="brand">
          <span className="brand-pixel" aria-hidden="true">▦</span>
          <span>{tx("Piksel Ofis")}</span>
        </div>
        <ThemeButton />
      </header>
      <section className="login-form">
        <h2>{tx("İçeri buyurun.")}</h2>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await api("/login", "POST", { password });
              setPassword("");
              onLogin();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            {tx("Sahip şifresi")}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy ? tx("Giriş yapılıyor…") : tx("Ofisi aç")}
            <Icon name="arrow" />
          </button>
        </form>
      </section>
    </main>
  );
}
export default function App() {
  const language = useLanguage();
  const [newVersion,setNewVersion]=useState(false);
  const checkVersion=async()=>{const result=await api<{build_id?:string}>("/session");if(result.build_id && result.build_id!==import.meta.env.OFIS_BUILD_ID)setNewVersion(true);};
  const [auth, setAuth] = useState<boolean | null>(null);
  const [languageReady, setLanguageReady] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const [snapshotReady, setSnapshotReady] = useState(false);
  const [view, setView] = useState<View>("office");
  const [requestedReset,setRequestedReset]=useState<ResetView|null>(null);
  useEffect(()=>{
    const open=(event:Event)=>{setRequestedReset((event as CustomEvent<ResetView>).detail);setView('agents');};
    window.addEventListener('office:factory-reset-open',open);
    return ()=>window.removeEventListener('office:factory-reset-open',open);
  },[]);
  const [moreNav, setMoreNav] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(
    () => storedNumber("po-menu-dar", 0, 0, 1) === 1,
  );
  const [chatTarget, setChatTarget] = useState(()=>{try{return sessionStorage.getItem("po-taslak-alici") || "everyone";}catch{return "everyone";}});
  const [demoRead, setDemoRead] = useState(new Set<string>());
  const [groupsOpen, setGroupsOpen] = useState(true);
  const [directOpen, setDirectOpen] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [taskAgent, setTaskAgent] = useState<Agent | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskCommands,setTaskCommands]=useState<string[]>([]);
  const [taskEffort,setTaskEffort]=useState("");
  useEffect(()=>{setTaskCommands([]);setTaskEffort("");},[taskAgent?.id]);
  const [demo, setDemo] = useState(false);
  const [tick, setTick] = useState(0);
  const [notice, setNotice] = useState("");
  const [dismissedChains, setDismissedChains] = useState<string[]>(() => {
    try { const ids=JSON.parse(localStorage.getItem('po-kapatilan-uyarilar') || '[]'); return Array.isArray(ids) ? ids.filter(id=>typeof id==='string') : []; } catch { return []; }
  });
  useEffect(()=>savePreference('po-kapatilan-uyarilar',JSON.stringify(dismissedChains)),[dismissedChains]);
  const [error, setError] = useState("");
  useEffect(() => { setError(""); setNotice(""); }, [language]);
  useEffect(() => { if (!error) return; const timer=setTimeout(()=>setError(""),8000); return()=>clearTimeout(timer); },[error]);
  const chainKey=(snapshot.runtime?.stoppedChains || []).filter(c=>!dismissedChains.includes(c.id)).map(c=>c.id).join(',');
  useEffect(()=>{if(!chainKey)return;const timer=setTimeout(()=>{setDismissedChains(ids=>[...new Set([...ids,...chainKey.split(',')])]);for(const id of chainKey.split(','))void api(`/notices/${id}/dismiss`,'POST',{}).catch(()=>{});},8000);return()=>clearTimeout(timer);},[chainKey]);
  useEffect(()=>{if(!snapshotReady)return;const id=new URLSearchParams(window.location.search).get('oturum');if(id){setSelected(id);setChatTarget(`agent:${id}`);}},[snapshotReady]);
  const [busy, setBusy] = useState(0);
  const [connection, setConnection] = useState(false);
  const refresh = async () => {
    try {
      const next = await api<Snapshot>("/snapshot");
      if (next.runtime?.settings.language) setLanguage(next.runtime.settings.language);
      setSnapshot(next);
      setSnapshotReady(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuth(false);
      else throw e;
    }
  };
  useEffect(() => {
    void api<{language: "tr" | "en" | null}>("/language").then(value => { if (value.language) setLanguage(value.language); }).catch(() => {}).finally(() => setLanguageReady(true));
    checkVersion()
      .then(() => setAuth(true))
      .catch((e) => {
        setAuth(false);
        if (!(e instanceof ApiError && e.status === 401))
          setError(tx("Ofise bağlanılamadı. Sayfayı yenileyin."));
      });
  }, []);
  useEffect(() => {
    if (!auth) { setSnapshotReady(false); return; }
    let alive = true;
    let loading = false;
    let queued = false;
    const update = async () => {
      if (loading) {
        queued = true;
        return;
      }
      loading = true;
      try {
        const data = await api<Snapshot>("/snapshot");
        if (alive) { if (data.runtime?.settings.language) setLanguage(data.runtime.settings.language); setSnapshot(data); setSnapshotReady(true); }
      } catch (e) {
        if (alive) {
          if (e instanceof ApiError && e.status === 401) setAuth(false);
          else setError((e as Error).message);
        }
      } finally {
        loading = false;
        if (alive && queued) {
          queued = false;
          void update();
        }
      }
    };
    void update();
    const stream = new EventSource("/api/live");
    stream.addEventListener("ready", () => {
      setConnection(true);
      void checkVersion().catch(()=>{});
      void update();
    });
    stream.addEventListener("update", () => {
      window.dispatchEvent(new Event('office:live-update'));
      void update();
    });
    stream.onerror = () => {
      setConnection(false);
    };
    const poll = setInterval(() => {
      if (stream.readyState !== EventSource.OPEN) void update();
    }, 20000);
    return () => {
      alive = false;
      stream.close();
      clearInterval(poll);
      setConnection(false);
    };
  }, [auth]);
  useEffect(() => {
    if (!demo) {
      setTick(0);
      return;
    }
    const timer = setInterval(() => {
      if (!document.hidden) setTick((t) => t + 1);
    }, 5000);
    return () => clearInterval(timer);
  }, [demo]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const perform: Perform = async (action, success, background=false) => {
    if (demo) {
      setError(tx("Değişiklik yapmak için önce deneme modunu kapatın."));
      return;
    }
    if(!background)setBusy((n) => n + 1);
    setError("");
    try {
      await action();
      await refresh();
      if (success) setNotice(success);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuth(false);
      setError((e as Error).message);
    } finally {
      if(!background)setBusy((n) => n - 1);
    }
  };
  const logout = async () => {
    setBusy((n) => n + 1);
    try {
      await api("/logout", "POST");
      setAuth(false);
      setSnapshot(empty);
      setSelected(null);
      setDemo(false);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy((n) => n - 1);
    }
  };
  const data = demo ? demoSnapshot(snapshot, tick) : snapshot;
  useEffect(() => setDemoRead(new Set()), [demo]);
  const unread = unreadMessages(data.messages, demoRead);
  const directAgents = data.agents.filter((a) => a.builtin !== "director");
  const pendingApprovals = data.runtime?.approvals.filter((a) => a.state === "pending").length || 0;
  const openChat = (target: string) => {
    if(data.agents.some(a=>a.builtin==='director' && target===`agent:${a.id}`)){if(demo){setError(tx("Terminali açmak için deneme modundan çıkın."));return;}window.dispatchEvent(new Event('office:director-open'));return;}
    setChatTarget(target);
    setSelected(target.startsWith("agent:") ? target.slice(6) : null);
    setView("office");
  };
  const unreadCount = (target: string) =>
    unread.filter((m) => inConversation(m, target)).length;
  const unreadBadge = (target: string) =>
    unreadCount(target) > 0 ? (
      <b className="unread-badge">{unreadCount(target)}</b>
    ) : null;

  if (auth === null || !languageReady)
    return <div className="loading-screen">{languageReady ? tx("Ofis açılıyor…") : tx("Piksel Ofis") + '…'}</div>;
  if (!auth)
    return (
      <Login
        onLogin={() => {
          setAuth(true);
          setError("");
        }}
      />
    );
  return (
    <div className={`app-shell ${railCollapsed ? "rail-collapsed" : ""}`}>
      {!demo && data.runtime?.director && <DirectorTerminal data={data} disabled={!!busy} onApprovals={()=>setView('approvals')} onChanged={refresh} />}
      <aside className="rail" aria-label={tx("Şirket menüsü")}>
        <div className="rail-brand">
          <a
            className="brand"
            href="#office"
            onClick={() => setView("office")}
            aria-label={tx("Piksel Ofis ana ekran")}
          >
            <span className="brand-pixel" aria-hidden="true">▦</span>
            <span className="brand-name">
              {tx("Piksel")}<span className="brand-second">{tx("Ofis")}</span>
            </span>
          </a>
          <button
            className="rail-toggle"
            aria-label={railCollapsed ? tx("Menüyü genişlet") : tx("Menüyü daralt")}
            title={railCollapsed ? tx("Menüyü genişlet") : tx("Menüyü daralt")}
            onClick={() => {
              setRailCollapsed(!railCollapsed);
              savePreference("po-menu-dar", railCollapsed ? 0 : 1);
            }}
          >
            <Icon name="sidebar" size={20} />
          </button>
        </div>
        <nav aria-label={tx("Ana gezinme")}>
          <button className="nav-item" disabled={demo} aria-label={tx("Genel Müdür terminalini aç")} title={pendingApprovals ? tx("Genel Müdür · {0} bekleyen onay", [pendingApprovals]) : tx("Genel Müdür · Ctrl + Shift + G")} onClick={()=>window.dispatchEvent(new Event('office:director-open'))}><Icon name="office" size={18} /><span className="nav-label">{tx("Genel Müdür")}</span>{pendingApprovals > 0 && <b className="unread-badge" aria-label={tx("{0} bekleyen onay", [pendingApprovals])}>{pendingApprovals}</b>}</button>
          {navigation.map((item) => (
            <button
              key={item.id}
              aria-label={item.label}
              title={item.label}
              className={`${view === item.id ? "nav-item active" : "nav-item"} ${item.id === "rules" ? "nav-second-group" : ""}`}
              onClick={() => setView(item.id)}
              aria-current={view === item.id ? "page" : undefined}
            >
              <Icon name={item.icon} size={18} />
              <span className="nav-label">{item.label}</span>
              {item.id === "approvals" && pendingApprovals > 0 && (
                <b className="unread-badge">{pendingApprovals}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="rail-chats">
        <section className="rail-groups" data-open={groupsOpen} style={{ "--list-count": data.departments.length + 1 } as CSSProperties}>
          <button
            className="rail-section-toggle"
            aria-label={tx("Grup sohbetleri")}
            aria-expanded={groupsOpen}
            aria-controls="group-chats"
            onClick={() => setGroupsOpen(!groupsOpen)}
            title={tx("Grup sohbetleri")}
          >
            <span>{tx("Grup sohbetleri")}</span>
            {!groupsOpen && <small>{data.departments.length + 1}</small>}
          </button>
          {groupsOpen && (
            <ScrollList id="group-chats" label={tx("Grup sohbetleri")}>
              <button
                className={`nav-item chat-nav ${view === "office" && chatTarget === "everyone" ? "chosen" : ""}`}
                aria-label={tx("Genel sohbet")}
                title={tx("Genel sohbet")}
                onClick={() => openChat("everyone")}
              >
                <span className="group-mark">◌</span>
                <span className="nav-label">{tx("Genel")}</span>
                {unreadBadge("everyone")}
              </button>
              {data.departments.map((d) => (
                <button
                  key={d.id}
                  className={`nav-item chat-nav ${view === "office" && chatTarget === `department:${d.id}` ? "chosen" : ""}`}
                  aria-label={tx("{0} grup sohbeti", [d.name])}
                  title={tx("{0} grup sohbeti", [d.name])}
                  onClick={() => openChat(`department:${d.id}`)}
                >
                  <span
                    className="group-mark"
                    style={{ "--group-color": d.color } as CSSProperties}
                  >
                    <i />
                  </span>
                  <span className="nav-label">{d.name}</span>
                  {unreadBadge(`department:${d.id}`)}
                </button>
              ))}
            </ScrollList>
          )}
        </section>
        <section className="rail-direct" data-open={directOpen}>
          <button
            className="rail-section-toggle"
            aria-label={tx("Birebir sohbetler")}
            aria-expanded={directOpen}
            aria-controls="direct-chats"
            onClick={() => setDirectOpen(!directOpen)}
            title={tx("Birebir sohbetler")}
          >
            <span>{tx("Birebir sohbetler")}</span>
            {!directOpen && <small>{directAgents.length}</small>}
          </button>
          {directOpen && (
            <ScrollList id="direct-chats" label={tx("Birebir sohbetler")}>
              {directAgents.map((a) => (
                <button
                  key={a.id}
                  className={`nav-item agent-row chat-nav ${view === "office" && chatTarget === `agent:${a.id}` ? "chosen" : ""}`}
                  aria-label={tx("{0} sohbetini aç, {1}{2}", [a.name, tx(statusLabels[a.status]), unreadCount(`agent:${a.id}`) ? tx(", {0} okunmamış mesaj", [unreadCount(`agent:${a.id}`)]) : ""])}
                  title={`${a.name} — ${a.title}, ${tx(statusLabels[a.status])}`}
                  onClick={() => openChat(`agent:${a.id}`)}
                >
                  <span className="rail-avatar">
                    <Avatar appearance={a.appearance} size={30} />
                    <i className={`tiny-status ${a.status}`} />
                  </span>
                  <span className="nav-label">{a.name}</span>
                  {unreadBadge(`agent:${a.id}`)}
                </button>
              ))}
              {!directAgents.length && (
                <p className="rail-empty">{tx("Henüz ajan yok.")}</p>
              )}
            </ScrollList>
          )}
        </section>
        </div>
        <div className="rail-bottom">
          <span
            className={`connection ${connection ? "connected" : ""}`}
            role="status"
            aria-label={connection ? tx("Ofis bağlı") : tx("Bağlantı bekleniyor")}
            title={connection ? tx("Ofis bağlı") : tx("Bağlantı bekleniyor")}
          >
            <i />
          </span>
          <span className="rail-owner" title={tx("Siz · Şirket sahibi")}>
            {tx("Siz")}
          </span>
          <LanguageButton disabled={busy > 0 || demo} onChanged={refresh} /><ThemeButton compact />
          <button
            className="icon-button owner-exit"
            aria-label={tx("Çıkış yap")}
            title={tx("Çıkış yap")}
            disabled={busy > 0}
            onClick={() => void logout()}
          >
            <Icon name="exit" size={18} />
          </button>
        </div>
      </aside>
      <div className="workspace">
        {Boolean(error || data.runtime?.protocolError || data.runtime?.pendingDeletions?.length || data.runtime?.stoppedChains?.some((c) => !dismissedChains.includes(c.id))) && (
        createPortal(<div className="global-error runtime-alerts">
        {data.runtime?.protocolError && !dismissedChains.includes(`protocol:${data.runtime.protocolError}`) && <div className="alert error" role="alert"><span>{data.runtime.protocolError}</span><button className="icon-button" aria-label={tx("Sürüm uyarısını kapat")} onClick={()=>setDismissedChains(ids=>[...ids,`protocol:${data.runtime!.protocolError}`])}><Icon name="close" size={17} /></button></div>}
        {data.runtime?.stoppedChains?.filter((c) => !dismissedChains.includes(c.id)).map((c) => (
          <div key={c.id} className="alert error" role="alert">
            <span>{c.reason}</span>
            <button className="icon-button" aria-label={tx("Zincir uyarısını kapat")}
              onClick={() => {setDismissedChains((ids) => [...ids, c.id]);void api(`/notices/${c.id}/dismiss`,'POST',{}).catch(()=>{});}}>
              <Icon name="close" size={17} />
            </button>
          </div>
        ))}
        {!!data.runtime?.pendingDeletions?.length && !dismissedChains.includes(`deletions:${data.runtime.pendingDeletions.map(d=>d.id).join(',')}`) && (
          <div className="alert error" role="status">
            <span>{data.runtime.pendingDeletions.map((d) => tx("{0}: Tududi hesabı silinmeyi bekliyor. {1}", [d.name, d.detail])).join(" ")}</span>
            <button className="icon-button" aria-label={tx("Hesap uyarısını kapat")} onClick={()=>setDismissedChains(ids=>[...ids,`deletions:${data.runtime!.pendingDeletions!.map(d=>d.id).join(',')}`])}><Icon name="close" size={17} /></button>
          </div>
        )}
        {error && (
          <div className="alert error" role="alert">
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label={tx("Uyarıyı kapat")}
              onClick={() => setError("")}
            >
              <Icon name="close" size={17} />
            </button>
          </div>
        )}
        </div>, document.body)
        )}
        {newVersion && createPortal(<div className="version-notice" role="status"><span>{tx("Yeni sürüm yayınlandı")}</span><span aria-hidden="true"> — </span><button className="secondary" onClick={()=>{if(!window.dispatchEvent(new Event("ofis-taslak-sakla",{cancelable:true}))){setError(tx("Taslak saklanamadı. Mesajınızı gönderin veya kopyalayın; sonra yenileyin."));return;}window.location.reload();}}>{tx("Yenile")}</button></div>,document.body)}
        {notice && (
          <div className="toast" role="status">
            <Icon name="check" />
            {notice}
          </div>
        )}
        <main
          className={view === "office" ? "office-page" : `management-page${view === "tududi" ? " tududi-page" : ""}`}
          aria-busy={busy > 0 || (!demo && !snapshotReady)}
        >
          {view === "office" ? (
            <OfficeView
              data={data}
              loading={!demo && !snapshotReady}
              selected={selected}
              onSelect={(id) => {
                setSelected(id);
                if (
                  data.runtime?.approvals.some(
                    (a) => a.agent_id === id && a.state === "pending",
                  )
                )
                  setView("approvals");
              }}
              onApprovals={() => setView("approvals")}
              onSettings={setView}
              target={chatTarget}
              onTarget={setChatTarget}
              onDemoRead={(ids) =>
                setDemoRead((old) => new Set([...old, ...ids]))
              }
              demo={demo}
              disabled={busy > 0}
              perform={perform}
              onDemo={() => {
                setDemo(!demo);
                if (demo && selected?.startsWith("demo-")) setSelected(null);
              }}
              onTask={(a) => {
                setTaskAgent(a);
                setTaskTitle("");
              }}
              onTududi={(a) => {
                setSelected(a.id);
                setView("tududi");
              }}
            />
          ) : view === "agents" ? (
            <Agents
              requestedReset={requestedReset}
              onResetOpened={()=>setRequestedReset(null)}
              data={data}
              perform={perform}
              disabled={demo || busy > 0}
              onTududi={(a) => {
                setSelected(a.id);
                setView("tududi");
              }}
            />
          ) : view === "departments" ? (
            <Departments
              data={data}
              perform={perform}
              disabled={demo || busy > 0}
            />
          ) : view === "tududi" ? (
            <TududiPage
              data={data}
              selected={selected}
              onSelect={setSelected}
              perform={perform}
              disabled={demo || busy > 0}
              demo={demo}
            />
          ) : view === "rules" ? (
            <>
              <Rules
                value={data.rules}
                perform={perform}
                disabled={demo || busy > 0}
              />
              <RuntimeSettings
                data={data}
                perform={perform}
                disabled={demo || busy > 0}
              />
            </>
          ) : view === "approvals" ? (
            <Approvals
              data={data}
              perform={perform}
              disabled={demo || busy > 0}
            />
          ) : view === "links" ? (
            <Links data={data} perform={perform} disabled={demo || busy > 0} />
          ) : view === "usage" ? (
            <Usage data={data} perform={perform} disabled={demo || busy > 0} />
          ) : view === "notebook" ? (
            <NotebookPanel data={data} perform={perform} disabled={demo || busy > 0} />
          ) : view === "schedules" ? (
            <SchedulesPanel data={data} perform={perform} disabled={demo || busy > 0} />
          ) : view === "events" ? (
            <Events data={data} perform={perform} disabled={!!busy || demo} />
          ) : (
            <UpcomingPage view={view} />
          )}
        </main>
      </div>
      <nav className="tabbar" aria-label={tx("Telefon gezinmesi")}>
        {navigation
          .filter((n) =>
            ["office", "agents", "tududi", "events"].includes(n.id),
          )
          .map((item) => (
            <button
              key={item.id}
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => setView(item.id)}
            >
              <Icon name={item.icon} />
              <span>{item.id === "tududi" ? tx("Görevler") : item.label}</span>
            </button>
          ))}
        <button onClick={() => setMoreNav(true)}>
          <Icon name="grid" />
          <span>{tx("Diğer")}</span>
        </button>
      </nav>
      {moreNav && (
        <Modal title={tx("Diğer ekranlar")} onClose={() => setMoreNav(false)}>
          <div className="more-navigation"><LanguageButton disabled={busy > 0 || demo} onChanged={refresh} />
            <ThemeButton />
            <button
              className="secondary owner-exit"
              disabled={busy > 0}
              onClick={() => void logout()}
            >
              {tx("Çıkış yap")}
            </button>
            {[
              ...navigation.filter((n) =>
                ["departments", "rules", "approvals", "links", "usage", "notebook", "schedules"].includes(n.id),
              ),
              ...upcoming.filter((item) => item.id !== "usage"),
            ].map((item) => (
              <button
                className="secondary"
                key={item.id}
                aria-label={item.label}
                onClick={() => {
                  setView(item.id);
                  setMoreNav(false);
                }}
              >
                <Icon name={item.icon} />
                {item.label}
              </button>
            ))}
          </div>
        </Modal>
      )}
      {taskAgent && (
        <Modal
          title={tx("{0} için görev", [taskAgent.name])}
          onClose={() => setTaskAgent(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                await api("/handoffs", "POST", {
                  to_agent_id: taskAgent.id,
                  title: taskTitle,
                  description: "",
                  secenekler:{acceptance:taskCommands,...(taskEffort?{effort:taskEffort}: {})},
                });
                setTaskAgent(null);
              }, tx("Görev devri kaydedildi."));
            }}
          >
            <label>
              {tx("Görevin başlığı")}
              <input
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                required
                maxLength={200}
              />
            </label>
            <label>{tx("Bu iş için düşünme düzeyi")}<select value={taskEffort} onChange={e=>setTaskEffort(e.target.value)}><option value="">{tx("Ajanın kendi ayarı")}</option><option value="low">{tx("Hafif")}</option><option value="medium">{tx("Orta")}</option><option value="high">{tx("Yüksek")}</option><option value="xhigh">{tx("Çok yüksek")}</option><option value="max">{tx("En yüksek")}</option></select></label>
            {taskAgent.policy?.permission==='folders' && (data.runtime?.commands || []).some(c=>c.agent_ids.includes(taskAgent.id) && !c.approval) && <fieldset><legend>{tx("İş bitince geçmesi gereken kontroller")}</legend>{(data.runtime?.commands || []).filter(c=>c.agent_ids.includes(taskAgent.id) && !c.approval).map(c=><label className="radio-label" key={c.id}><input type="checkbox" checked={taskCommands.includes(c.id)} onChange={e=>setTaskCommands(e.target.checked?[...taskCommands,c.id]:taskCommands.filter(id=>id!==c.id))} />{c.name}</label>)}</fieldset>}
            <p className="muted">
              {tx("Tududi hesabı bekliyorsa görev saklanır; daha sonra aktarabilirsiniz.")}
            </p>
            <button className="primary wide" disabled={busy > 0}>
              {tx("Görev ver")}
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
function UpcomingPage({ view }: { view: View }) {
  const item = upcoming.find((i) => i.id === view)!;
  return (
    <>
      <Heading
        eyebrow={tx("YAKINDA GELECEK")}
        title={item.label}
        description={item.description}
      />
      <section className="upcoming-card">
        <span className="upcoming-icon">
          <Icon name={item.icon} size={38} />
        </span>
        <span className="badge">{tx("Hazırlanıyor")}</span>
        <h2>{tx("Ekibinize yeni bir çalışma alanı")}</h2>
        <p>{tx("Bu ekran henüz kullanıma açılmadı. Planlanan özellikler:")}</p>
        <ul>
          {item.items.map((text) => (
            <li key={text}>
              <Icon name="check" size={18} />
              {text}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
function blankAgent(department_id: string, settings=defaultSettings) {
  return {
    tool_groups:undefined as import("../shared/director").ToolGroup[] | undefined,
    username: "",
    session_mode: "work" as const,
    watch_tasks: false,
    watch_due: false,
    name: "",
    title: "",
    department_id,
    prompt: "",
    runner: (settings.defaultRunner || "codex") as Agent["runner"],
    policy: { ...defaultPolicy, ...(settings.defaultRunner==='claude'?{permission:'chat' as const}: {}) },
    model: settings.defaultModel,
    effort: settings.defaultEffort,
    appearance: {
      pants: "#354655",
      glasses: false,
      tie: false,
      headphones: false,
      skin: "#e5b88f",
      hair: "#393645",
      shirt: "#498f87",
      style: "kisa" as Appearance["style"],
    },
    desk_x: 0,
    desk_y: 0,
    status: "bosta" as Agent["status"],
    current_job: "",
    active: true,
  };
}
function agentInput(a: Agent) {
  const {
    id,
    created_at,
    tududi_email,
    tududi_state,
    tududi_user_id,
    workbook_uid,
    builtin,
    ...input
  } = a;
  return input;
}
function Agents({
  requestedReset,
  onResetOpened,
  data,
  perform,
  disabled,
  onTududi,
}: {
  data: Snapshot;
  perform: Perform;
  disabled: boolean;
  onTududi: (agent: Agent) => void;
  requestedReset:ResetView|null;
  onResetOpened:()=>void;
}) {
  const [editing, setEditing] = useState<Agent | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<Agent | null>(null);
  const [account, setAccount] = useState("keep");
  const [deleteProfile,setDeleteProfile] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [query, setQuery] = useState("");
  const [department, setDepartment] = useState("");
  const [details, setDetails] = useState<Agent | null>(null);
  const [reset,setReset]=useState<ResetView|null>(null);
  const [resetRunning,setResetRunning]=useState(false);
  useEffect(()=>{if(requestedReset){setReset(requestedReset);onResetOpened();}},[requestedReset,onResetOpened]);
  useEffect(()=>{let alive=true;void api<ResetView|null>('/factory-reset/current').then(value=>{if(alive && value)setReset(value);}).catch(()=>{});return ()=>{alive=false;};},[]);
  const previewReset=(agent_id?:string)=>void perform(async()=>{
    const current=await api<ResetView|null>('/factory-reset/current');
    setReset(current || await api<ResetView>('/factory-reset/preview','POST',agent_id?{agent_id}:{}));
    setDetails(null);
  });
  const shown = data.agents.filter(
    (a) =>
      (!department || a.department_id === department) &&
      `${a.name} ${a.title}`
        .toLocaleLowerCase(locale())
        .includes(query.toLocaleLowerCase(locale())),
  );
  return (
    <>
      <Heading
        eyebrow={tx("ŞİRKETİNİZİN İNSANLARI")}
        title={tx("Ajanlarınız")}
        description={tx("Her ajana bir rol, bir talimat ve bir masa verin.")}
      >
        <button
          className="primary"
          onClick={() => setEditing(null)}
          disabled={disabled || !data.departments.length}
        >
          <Icon name="plus" size={18} />
          {tx("Ajan ekle")}
        </button>
        <button className="danger-button" disabled={disabled || !data.agents.length} onClick={()=>previewReset()}>{tx('Fabrika ayarlarına dön')}</button>
      </Heading>
      {!data.departments.length && (
        <div className="hint">
          {tx("Ajan eklemek için önce Bölümler ekranından bir bölüm açın.")}
        </div>
      )}
      <div className="agent-toolbar">
        <label className="search-field">
          {tx("Ajan ara")}
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tx("Ad veya unvan")}
          />
        </label>
        <div className="department-chips" aria-label={tx("Bölüm süzgeci")}>
          <button
            className={`chip ${!department ? "selected" : ""}`}
            aria-pressed={!department}
            onClick={() => setDepartment("")}
          >
            {tx("Tümü")} <b>{data.agents.length}</b>
          </button>
          {data.departments.map((d) => (
            <button
              key={d.id}
              aria-pressed={department === d.id}
              className={`chip ${department === d.id ? "selected" : ""}`}
              onClick={() => setDepartment(d.id)}
            >
              {d.name}
            </button>
          ))}
        </div>
      </div>
      {!data.agents.length ? (
        <Empty title={tx("Ekibiniz burada büyüyecek")}>
          {tx("Bir bölüm açın, ardından ilk ajanınızı ekleyin.")}
        </Empty>
      ) : !shown.length ? (
        <Empty title={tx("Aramanıza uygun ajan bulunamadı")}>
          {tx("Aramayı veya seçtiğiniz bölümü değiştirin.")}
        </Empty>
      ) : (
        <div className="agents-table-wrap">
          <table className="agents-table">
            <thead>
              <tr>
                <th>{tx("Ajan")}</th>
                <th>{tx("Bölüm")}</th>
                <th>{tx("Çalıştırıcı / model")}</th>
                <th>{tx("Tududi hesabı")}</th>
                <th>{tx("Durum")}</th>
                <th>{tx("İşlemler")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((a) => (
                <tr key={a.id}>
                  <td data-label={tx("Ajan")}>
                    <div className="card-person">
                      <span className="avatar-square">
                        <Avatar appearance={a.appearance} size={48} />
                      </span>
                      <div>
                        <h2>{a.name}</h2>
                        <p>{a.title}</p>
                      </div>
                    </div>
                  </td>
                  <td data-label={tx("Bölüm")}>
                    <span className="card-department">
                      <i
                        style={{
                          background: data.departments.find(
                            (d) => d.id === a.department_id,
                          )?.color,
                        }}
                      />
                      {
                        data.departments.find((d) => d.id === a.department_id)
                          ?.name
                      }
                    </span>
                  </td>
                  <td data-label={tx("Çalıştırıcı")}>
                    <b>{a.runner === "claude" ? "Claude" : "Codex"}</b>
                    <small className="model-name">{a.model}</small>
                  </td>
                  <td data-label="Tududi">
                    <span
                      className={`badge ${a.tududi_state === "ready" ? "ready" : "honey"}`}
                    >
                      {a.tududi_state === "ready" ? tx("Hazır") : tx("Hesap bekliyor")}
                    </span>
                    {a.tududi_state==="pending" && <button className="text-button" disabled={disabled} onClick={()=>void perform(async()=>{await api(`/agents/${a.id}/retry`,"POST",{});})}>{tx("Hesabı yeniden kur")}</button>}
                  </td>
                  <td data-label={tx("Durum")}>
                    <Status agent={a} />
                  </td>
                  <td data-label={tx("İşlemler")}>
                    <div className="card-actions">
                      <button
                        className="text-button"
                        onClick={() => onTududi(a)}
                        disabled={disabled}
                      >
                        {tx("Görevler")}
                      </button>
                      <TududiLogin agent={a} perform={perform} disabled={disabled} />
                      <button
                        className="secondary"
                        onClick={() => setEditing(a)}
                        disabled={disabled}
                      >
                        {tx("Düzenle")}
                      </button>
                      <button
                        className="icon-button"
                        aria-label={tx("{0} için diğer işlemler", [a.name])}
                        onClick={() => setDetails(a)}
                        disabled={disabled}
                      >
                        •••
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {details && (
        <Modal
          title={tx("{0} · Diğer işlemler", [details.name])}
          onClose={() => setDetails(null)}
        >
          <p>
            {tx("Bu ajanın çalışmalarını, teslim ettiği dosyaları ve hafıza notunu buradan izleyebilirsiniz.")}
          </p>
          <p>{details.tududi_email}</p>
          <TududiLogin agent={details} perform={perform} disabled={disabled} />
          <button className="danger-button" disabled={disabled} onClick={()=>previewReset(details.id)}>{tx('Bu ajanı sıfırla')}</button>
          <AgentWork
            agent={data.agents.find((a) => a.id === details.id) || details}
            data={data}
            perform={perform}
            disabled={disabled}
          />
          <div className="other-actions">
            {data.runtime?.availability?.[details.runner] === false && (
              <p role="status">{details.runner === "claude" ? tx("Claude girişi yapılmamış") : tx("Codex girişi yapılmamış")}</p>
            )}
            {details.tududi_state === "pending" && (
              <>
              <p role="status">{data.events.find((e) => e.agent_id === details.id && e.kind === "tududi_pending")?.text || tx("Tududi hesabı bekliyor. Hesabı yeniden kuryebilirsiniz.")}</p>
              <button
                className="secondary"
                disabled={disabled}
                onClick={() =>
                  void perform(async () => {
                    await api(`/agents/${details.id}/retry`, "POST");
                  })
                }
              >
                {tx("Hesabı yeniden kur")}
              </button>
              </>
            )}
            <button
              className="secondary"
              disabled={disabled}
              onClick={() =>
                void perform(async () => {
                  await api(`/agents/${details.id}`, "PUT", {
                    ...agentInput(details),
                    active: !details.active,
                    status: details.active ? "kapali" : "bosta",
                  });
                  setDetails(null);
                })
              }
            >
              {details.active ? tx("Pasif yap") : tx("Etkinleştir")}
            </button>
            <button
              className="secondary"
              disabled={disabled}
              onClick={() =>
                void perform(async () => {
                  const r = await api<{ prompt: string }>(
                    `/agents/${details.id}/prompt`,
                  );
                  setDetails(null);
                  setPrompt(r.prompt);
                })
              }
            >
              {tx("Tam talimatı gör")}
            </button>
            <button
              className="danger-button"
              disabled={disabled || details.builtin==='director'}
              onClick={() => {
                setDeleting(details);
                setDetails(null);
                setAccount("keep");
              }}
            >
              {tx("Sil")}
            </button>
          </div>
        </Modal>
      )}
      {editing !== undefined && (
        <AgentForm
          agent={editing}
          departments={data.departments}
          models={data.runtime?.models}
          availability={data.runtime?.availability} claudeLoginCommand={data.runtime?.claudeLoginCommand}
          settings={data.runtime?.settings}
          perform={perform}
          disabled={disabled}
          onClose={() => setEditing(undefined)}
        />
      )}{" "}
      {deleting && (
        <Modal
          title={tx("{0} silinsin mi?", [deleting.name])}
          onClose={() => setDeleting(null)}
        >
          <p>{tx("Ajan 24 saat çöp kutusunda kalır; Olaylar ekranından geri alabilirsiniz. Süre dolunca Tududi hesabına ne yapılsın?")}</p>
          <label className="radio-label">
            <input
              type="radio"
              name="account"
              checked={account === "keep"}
              onChange={() => setAccount("keep")}
            />
            {tx("Hesabı bırak; görevler ve notlar kalsın.")}
          </label>
          <label className="radio-label">
            <input
              type="radio"
              name="account"
              checked={account === "delete"}
              onChange={() => setAccount("delete")}
            />
            {tx("Tududi hesabını, görevlerini ve notlarını da sil.")}
          </label>
          <label className="radio-label"><input type="checkbox" checked={deleteProfile} onChange={e=>setDeleteProfile(e.target.checked)} />{tx("Kalıcı konuşma dosyalarını da sil.")}</label>
          {account === "keep" && (
            <p className="muted">
              {tx("Bırakılan hesap bu panelden yönetilemez; Tududi yöneticisi yönetebilir.")}
            </p>
          )}
          <div className="modal-actions">
            <button className="secondary" onClick={() => setDeleting(null)}>
              {tx("Vazgeç")}
            </button>
            <button
              className="danger-button"
              disabled={disabled}
              onClick={() =>
                void perform(async () => {
                  await api(
                    `/agents/${deleting.id}?account=${account}&profile=${deleteProfile ? "delete" : "keep"}&trash=1`,
                    "DELETE",
                  );
                  setDeleting(null);
                }, tx("Ajan silindi."))
              }
            >
              {tx("Ajanı sil")}
            </button>
          </div>
        </Modal>
      )}
      {reset && <Modal title={tx('Fabrika ayarlarına dön')} onClose={()=>{if(!resetRunning)setReset(null);}}>
        <FactoryResetPanel value={reset} onChange={setReset} perform={perform} disabled={disabled} onRunning={setResetRunning} onPreview={()=>previewReset(reset.agents.length===1?reset.agents[0].id:undefined)} />
      </Modal>}
      {prompt && (
        <Modal title={tx("Ajanın tam talimatı")} onClose={() => setPrompt("")}>
          <pre className="prompt-preview">{prompt}</pre>
        </Modal>
      )}
    </>
  );
}
function AgentForm({
  agent,
  departments,
  models,
  availability,
  claudeLoginCommand,
  settings=defaultSettings,
  perform,
  disabled,
  onClose,
}: {
  agent: Agent | null;
  models?: { claude: string[]; codex: string[] };
  availability?: {claude:boolean;codex:boolean};
  claudeLoginCommand?: string;
  settings?: import("../shared/runtime").RuntimeSettings;
  departments: Department[];
  perform: Perform;
  disabled: boolean;
  onClose: () => void;
}) {
  const [form, setForm] = useState(
    agent
      ? { ...agentInput(agent), policy: agent.policy || defaultPolicy }
      : blankAgent(departments[0]?.id || "",settings),
  );
  const patch = (key: string, value: unknown) =>
    setForm((f) => ({ ...f, [key]: value }));
  return (
    <Modal
      title={agent ? tx("Ajanı düzenle") : tx("Yeni ajan")}
      onClose={onClose}
      sheet
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void perform(
            async () => {
              await api(
                agent ? `/agents/${agent.id}` : "/agents",
                agent ? "PUT" : "POST",
                form,
              );
              onClose();
            },
            agent ? tx("Ajan güncellendi.") : tx("Ajan eklendi."),
          );
        }}
      >
        <h3 className="form-section-title">{tx("Kimlik")}</h3>
        <div className="form-grid">
          <label>
            {tx("Ad")}
            <input
              value={form.name}
              onChange={(e) => {const name=e.target.value;setForm(f=>({...f,name,...(!agent && (!f.username || f.username === f.name.normalize("NFKD").replace(/\p{Diacritic}/gu,"").toLowerCase().replace(/ı/g,"i").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")) ? {username:name.normalize("NFKD").replace(/\p{Diacritic}/gu,"").toLowerCase().replace(/ı/g,"i").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,40)} : {})}));}}
              required
              maxLength={80}
            />
          </label>
          <label>
            {tx("Unvan")}
            <input
              value={form.title}
              onChange={(e) => patch("title", e.target.value)}
              required
              maxLength={120}
            />
          </label>
        </div>
        <label>
          {tx("Bölüm")}
          <select
            value={form.department_id}
            onChange={(e) => patch("department_id", e.target.value)}
            required
          >
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label>{tx("Kullanıcı adı")}<input value={form.username || ''} onChange={e=>patch('username',e.target.value)} pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={40} required /></label>
        <p className="field-help">{tx("Tududi e-postası:")} {form.username || 'kullanici-adi'}@{settings.emailDomain}</p>
        <label>{tx("Konuşma biçimi")}<select value={form.session_mode || 'work'} disabled={agent?.builtin==='director'} onChange={e=>patch('session_mode',e.target.value)}><option value="work">{tx("İş başına oturum")}</option><option value="persistent">{tx("Kalıcı oturum")}</option><option value="single">{tx("Tek seferlik")}</option></select></label>
        <label className="radio-label"><input type="checkbox" disabled={agent?.builtin==='director'} checked={!!form.watch_tasks} onChange={e=>patch('watch_tasks',e.target.checked)} />{tx("Tududi’de yeni veya değişen görev ajanı çalıştırsın")}</label>
        <label className="radio-label"><input type="checkbox" disabled={agent?.builtin==='director'} checked={!!form.watch_due} onChange={e=>patch('watch_due',e.target.checked)} />{tx("Vadesi gelen görev ajanı çalıştırsın")}</label>
        <div className="form-grid">{(['sessionTurnLimit','sessionTokenLimit'] as const).map(key=><label key={key}>{key==='sessionTurnLimit' ? tx("Oturum yenileme · tur sınırı") : tx("Oturum yenileme · son çalışmanın girdi sınırı")}<input type="number" min={1} max={key==='sessionTurnLimit' ? 10000 : 1000000000} placeholder={tx("Ofis ayarı: {0}", [settings[key]])} value={form.policy[key] ?? ''} onChange={e=>patch('policy',{...form.policy,[key]:e.target.value ? Number(e.target.value) : null})} /></label>)}</div>
        <p className="field-help">{tx("Boş bırakırsanız Ofis ayarı kullanılır. Sınır geçilince sonraki çalışmadan önce kısa özet kaydedilip oturum yenilenir.")}</p>
        <h3 className="form-section-title">{tx("Talimat")}</h3>
        <label>
          {tx("Ajana talimatınız")}
          <textarea
            rows={7}
            value={form.prompt}
            onChange={(e) => patch("prompt", e.target.value)}
            placeholder={tx("Ne yapmalı? Nasıl düşünmeli? Sonuçları nasıl sunmalı?")}
            maxLength={60000}
          />
        </label>
        <p className="field-help">
          {tx("Şirket kuralları bu talimatın başına otomatik eklenir.")}
        </p>
        <h3 className="form-section-title">{tx("Çalıştırıcı")}</h3>
        <div className="form-grid">
          <label>
            {tx("Çalıştırıcı")}
            <select
              value={form.runner}
              onChange={(e) => {
                patch("runner", e.target.value);
                patch("model",models?.[e.target.value as 'codex'|'claude']?.[0] || (e.target.value==='claude'?'sonnet':settings.defaultModel));
                if (e.target.value === "claude")
                  patch("policy", {
                    ...form.policy,
                    permission: "chat",
                    commands: false,
                    network: false,
                  });
              }}
            >
              <option value="codex" >Codex{availability?.codex===false ? tx(" · Giriş yapılmamış") : ""}</option>
              <option value="claude" >Claude{availability?.claude===false ? tx(" · Giriş yapılmamış") : ""}</option>
            </select>
          </label>
          <label>
            {tx("Model")}
            <input
              list="runner-models"
              value={form.model}
              onChange={(e) => patch("model", e.target.value)}
              placeholder={tx("Kullanacağınız modelin adı")}
              required
              maxLength={120}
            />
          </label>
        </div>
        <datalist id="runner-models">
          {(models?.[form.runner] || []).map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
        <p className="field-help">
          {tx("Önerilerden seçebilir veya başka bir model adı yazabilirsiniz.")}
        </p>
        {agent?.builtin==='director' ? <p className="field-help">{tx("Genel Müdürün sohbet ve iş düşünme düzeylerini Kullanım ve kota ekranından değiştirebilirsiniz.")}</p> : (<label>
          {tx("Düşünme düzeyi")}
          <select
            value={form.effort}
            onChange={(e) => patch("effort", e.target.value)}
          >
            <option value="low">{tx("Hafif")}</option>
            <option value="medium">{tx("Orta")}</option>
            <option value="high">{tx("Yüksek")}</option>
            <option value="xhigh">{tx("Çok yüksek")}</option>
            <option value="max">{tx("En yüksek")}</option>
          </select>
        </label>)}
        {form.runner==='claude' && claudeLoginCommand && <p className="field-help">{tx("Çalıştırıcıda ayrı Claude hesabına giriş komutu:")} <code>{claudeLoginCommand}</code></p>}
        {form.runner==='claude' && <p className="field-help">{tx("Claude desteği deneysel — gerçek hesapla sınanmadı. Düşünme düzeyi modele göre uygulanır. Ajanlar için ayrı bir hesap kullanın; kişisel hesabınızın klasörünü bağlamayın.")}</p>}
        <h3 className="form-section-title">{tx("Çalışma yetkisi ve sınırları")}</h3>
        {availability?.[form.runner]===false && <p role="status">{form.runner==='claude'?'Claude':'Codex'} {tx("girişi yapılmamış. Bu sağlayıcıyla çalışma başlatılamaz.")}</p>}
        <fieldset><legend>{tx("Kullanabileceği araçlar")}</legend>{toolGroups.map(group=><label key={group} className="radio-label"><input type="checkbox" checked={(form.tool_groups || toolGroups).includes(group)} onChange={e=>patch('tool_groups',e.target.checked?[...new Set([...(form.tool_groups || toolGroups),group])]:(form.tool_groups || toolGroups).filter(g=>g!==group))} />{tx(toolGroupLabels[group])}</label>)}{agent?.builtin==='director' && <p className="field-help">{tx("Yönetim araçları yalnız bu yerleşik ajana açıktır.")}</p>}</fieldset>
        <label>
          {tx("Yetki düzeyi")}
          <select
            value={form.policy.permission}
            onChange={(e) =>
              patch("policy", {
                ...form.policy,
                permission: e.target.value,
                commands:
                  e.target.value === "chat" ? false : form.policy.commands,
                network:
                  e.target.value === "chat" ? false : form.policy.network,
              })
            }
          >
            <option value="chat">{tx("Yalnız sohbet")}</option>
            <option value="workspace">{tx("Çalışma klasörü")}</option>
            <option value="folders">{tx("Klasör bağlantıları")}</option>
          </select>
        </label>
        <p className="field-help">
          {form.runner === "codex"
            ? tx("Codex, çalışma klasörü ve klasör bağlantıları düzeyinde dosyaları okumak için komut kullanır. Ağ yalıtımı denetimi geçmezse iş başlamaz. Yalnız sohbette komut kullanamaz.")
            : tx("Claude dosyaları yalnız izinli klasörlerde okur ve düzenler. Kimlik ve ayar dosyaları kapalıdır. Komut ve web araçları kapalıdır.")}
        </p>
        <label className="radio-label">
          <input type="checkbox" checked={form.policy.network} disabled={!form.policy.network}
            onChange={() => patch("policy", { ...form.policy, network: false })} />
          {tx("Ağ erişimi · güvenli bağlantı hazır olana kadar kapalı")}
        </label>
        <div className="form-grid">
          {(
            [
              ["timeoutMinutes", tx("Bir çalışma en çok kaç dakika"), 60],
              ["maxCalls", tx("Bir çalışmada en çok tur ve araç"), 500],
              ["dailyRuns", tx("Günlük çalışma sayısı"), 1000],
              ["dailyMinutes", tx("Günlük toplam dakika"), 1440],
              ["inputTokenBudget", tx("Bir çalışmanın ağırlıklı token bütçesi"), 100000000],
            ] as const
          ).map(([key, label, max]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                min={1}
                max={max}
                value={form.policy[key]}
                onChange={(e) =>
                  patch("policy", {
                    ...form.policy,
                    [key]: Number(e.target.value),
                  })
                }
              />
            </label>
          ))}
        </div>
        {agent?.builtin === 'director' && <p className="field-help">{tx("Genel Müdürün gerçek terminalinde süre sınırı yoktur. Token ve araç sınırları geçerlidir.")}</p>}
        <fieldset className="appearance">
          <legend>{tx("Görünüm")}</legend>
          <Avatar appearance={form.appearance} size={78} />
          <div className="appearance-options">
            {(["skin", "hair", "shirt", "pants"] as const).map((part, i) => (
              <label key={part}>
                {[tx("Ten"), tx("Saç"), tx("Üst kıyafet"), tx("Alt kıyafet")][i]}
                <input
                  type="color"
                  value={form.appearance[part] || "#354655"}
                  onChange={(e) =>
                    patch("appearance", {
                      ...form.appearance,
                      [part]: e.target.value,
                    })
                  }
                />
              </label>
            ))}
            <label>
              {tx("Saç biçimi")}
              <select
                aria-label={tx("Saç biçimi")}
                value={form.appearance.style}
                onChange={(e) =>
                  patch("appearance", {
                    ...form.appearance,
                    style: e.target.value as Appearance["style"],
                  })
                }
              >
                {hairStyles.map((style, i) => (
                  <option key={style} value={style}>
                    {tx(hairLabels[i])}
                  </option>
                ))}
              </select>
            </label>
            {(["glasses", "tie", "headphones"] as const).map((accessory, i) => (
              <label className="accessory-option" key={accessory}>
                <input
                  type="checkbox"
                  checked={form.appearance[accessory] || false}
                  onChange={(e) =>
                    patch("appearance", {
                      ...form.appearance,
                      [accessory]: e.target.checked,
                    })
                  }
                />
                {[tx("Gözlük"), tx("Kravat"), tx("Kulaklık")][i]}
              </label>
            ))}
          </div>
        </fieldset>
        <details className="appearance-gallery">
          <summary>{tx("Görünüm örnekleri")}</summary>
          <CharacterGallery />
        </details>
        <details className="advanced">
          <summary>{tx("Masa ve durum ayarları")}</summary>
          <p className="muted">
            {tx("Masa yeri 0 / 0 ise otomatik yerleşir. Her sırada dört masa bulunur.")}
          </p>
          <div className="form-grid">
            <label>
              {tx("Masa sütunu")}
              <input
                type="number"
                min={0}
                max={100}
                value={form.desk_x}
                onChange={(e) => patch("desk_x", Number(e.target.value))}
              />
            </label>
            <label>
              {tx("Masa sırası")}
              <input
                type="number"
                min={0}
                max={100}
                value={form.desk_y}
                onChange={(e) => patch("desk_y", Number(e.target.value))}
              />
            </label>
            <label>
              {tx("Durum")}
              <select
                value={form.status}
                onChange={(e) => patch("status", e.target.value)}
              >
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {tx(statusLabels[s])}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {tx("Şu anki iş")}
              <input
                value={form.current_job}
                onChange={(e) => patch("current_job", e.target.value)}
                maxLength={2000}
              />
            </label>
          </div>
        </details>
        <h3 className="form-section-title">{tx("Durum")}</h3>
        <label className="radio-label">
          <input
            type="checkbox"
            checked={form.active}
            disabled={agent?.builtin==='director'}
            onChange={(e) => patch("active", e.target.checked)}
          />
          {tx("Etkin: ofiste görünür ve iş alabilir")}
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            {tx("Vazgeç")}
          </button>
          <button className="primary" disabled={disabled}>
            {agent ? tx("Değişiklikleri kaydet") : tx("Ajanı ekle")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Departments({
  data,
  perform,
  disabled,
}: {
  data: Snapshot;
  perform: Perform;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState<Department | null | undefined>(
    undefined,
  );
  const [form, setForm] = useState({
    name: "",
    description: "",
    color: "#528b7e",
    sort_order: 0,
    responsible_agent_id: null as string | null,
  });
  const [deleting, setDeleting] = useState<Department | null>(null);
  const open = (d: Department | null) => {
    setForm(
      d
        ? {
            name: d.name,
            description: d.description,
            color: d.color,
            sort_order: d.sort_order,
            responsible_agent_id: d.responsible_agent_id || null,
          }
        : {
            name: "",
            description: "",
            color: "#528b7e",
            sort_order: data.departments.length,
            responsible_agent_id: null,
          },
    );
    setEditing(d);
  };
  const move = (index: number, delta: number) =>
    void perform(async () => {
      const ids = data.departments.map((d) => d.id);
      [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
      await api("/departments/order", "PUT", { ids });
    }, tx("Bölüm sırası değiştirildi."));
  return (
    <>
      <Heading
        eyebrow={tx("ŞİRKETİNİZİN YAPISI")}
        title={tx("Bölümler")}
        description={tx("Ekibinizi iş alanlarına ayırın. Her bölümün ofiste bir masa grubu olsun.")}
      >
        <button
          className="primary"
          disabled={disabled}
          onClick={() => open(null)}
        >
          <Icon name="plus" size={18} />
          {tx("Bölüm aç")}
        </button>
      </Heading>
      {data.departments.length ? (
        <div className="department-cards">
          {data.departments.map((d, i) => (
            <article
              className="department-card"
              key={d.id}
              style={{ borderLeftColor: d.color }}
            >
              <span className="department-number">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div>
                <h2>{d.name}</h2>
                <p>{d.description || tx("Açıklama eklenmedi.")}</p>
                <small>
                  {data.agents.filter((a) => a.department_id === d.id).length}{" "}
                  {tx("ajan")}
                </small>
              </div>
              <div className="department-actions">
                <button
                  className="secondary"
                  disabled={disabled || i === 0}
                  onClick={() => move(i, -1)}
                  aria-label={tx("{0} bölümünü yukarı taşı", [d.name])}
                >
                  ↑
                </button>
                <button
                  className="secondary"
                  disabled={disabled || i === data.departments.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label={tx("{0} bölümünü aşağı taşı", [d.name])}
                >
                  ↓
                </button>
                <button
                  className="secondary"
                  disabled={disabled}
                  onClick={() => open(d)}
                >
                  {tx("Düzenle")}
                </button>
                <button
                  className="text-button danger"
                  disabled={disabled}
                  onClick={() => setDeleting(d)}
                >
                  {tx("Sil")}
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty title={tx("Şirketinizin ilk bölümünü açın")}>
          {tx("Adını, amacını ve rengini siz belirleyin.")}
        </Empty>
      )}
      {editing !== undefined && (
        <Modal
          title={editing ? tx("Bölümü düzenle") : tx("Yeni bölüm")}
          onClose={() => setEditing(undefined)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                await api(
                  editing ? `/departments/${editing.id}` : "/departments",
                  editing ? "PUT" : "POST",
                  form,
                );
                setEditing(undefined);
              }, tx("Bölüm kaydedildi."));
            }}
          >
            <label>
              {tx("Bölüm adı")}
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              {tx("Açıklama")}
              <textarea
                rows={4}
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
                maxLength={2000}
              />
            </label>
            <label>
              {tx("Sorumlu ajan · anılmadan yazılana cevap verir")}
              <select value={form.responsible_agent_id || ""} onChange={(e) => setForm({ ...form, responsible_agent_id: e.target.value || null })}>
                <option value="">{tx("Seçilmemiş")}</option>
                {data.agents.filter((a) => a.department_id === editing?.id && a.active).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            <label>
              {tx("Bölüm rengi")}
              <input
                type="color"
                value={form.color}
                onChange={(e) => setForm({ ...form, color: e.target.value })}
              />
            </label>
            <div className="modal-actions">
              <button
                className="secondary"
                type="button"
                onClick={() => setEditing(undefined)}
              >
                {tx("Vazgeç")}
              </button>
              <button className="primary" disabled={disabled}>
                {tx("Kaydet")}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal title={tx("Bölümü sil")} onClose={() => setDeleting(null)}>
          {data.agents.some((a) => a.department_id === deleting.id) ? (
            <>
              <p>
                {tx("Bu bölümde ajan var. Önce ajanları başka bölüme taşıyın ya da silin.")}
              </p>
              <button className="secondary" onClick={() => setDeleting(null)}>
                {tx("Kapat")}
              </button>
            </>
          ) : (
            <>
              <p>{deleting.name} {tx("bölümü silinsin mi?")}</p>
              <div className="modal-actions">
                <button className="secondary" onClick={() => setDeleting(null)}>
                  {tx("Vazgeç")}
                </button>
                <button
                  className="danger-button"
                  disabled={disabled}
                  onClick={() =>
                    void perform(async () => {
                      await api(`/departments/${deleting.id}?trash=1`, "DELETE");
                      setDeleting(null);
                    }, tx("Bölüm silindi."))
                  }
                >
                  {tx("Bölümü sil")}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  );
}
const taskStates = () => [
  tx("Yapılacak"),
  tx("Devam ediyor"),
  tx("Tamamlandı"),
  tx("Arşivde"),
  tx("Bekliyor"),
];
function taskDescription(task: Task) {
  return (task.description || "")
    .replace(/\s*\[Piksel Ofis devri: [^\]]+\]/g, "")
    .trim();
}
function taskStatus(task: Task) {
  if (typeof task.status === "number") return task.status;
  return (
    (
      {
        not_started: 0,
        in_progress: 1,
        done: 2,
        completed: 2,
        archived: 3,
        waiting: 4,
      } as Record<string, number>
    )[task.status] ?? 0
  );
}
function TududiPage({
  data,
  selected,
  onSelect,
  perform,
  disabled,
  demo,
}: {
  data: Snapshot;
  selected: string | null;
  onSelect: (id: string) => void;
  perform: Perform;
  disabled: boolean;
  demo: boolean;
}) {
  const agent = data.agents.find((a) => a.id === selected) || data.agents[0];
  const board = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<Task | null>(null);
  const [remote, setRemote] = useState<TududiData | null>(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [kind, setKind] = useState<"task" | "note" | "project" | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [project, setProject] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let alive = true;
    setRemote(null);
    setDetail(null);
    setError("");
    if (!agent || demo || agent.tududi_state !== "ready") return;
    setLoading(true);
    api<TududiData>(`/agents/${agent.id}/tududi`)
      .then((r) => {
        if (alive) setRemote(r);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [agent?.id, agent?.tududi_state, version, demo]);
  // Fit the board below the real header height, including wrapped mobile actions.
  useLayoutEffect(() => {
    const el = board.current;
    if (!el) return;
    const fit = () => {
      const bottom = window.innerWidth <= 900 ? 76 : 16;
      const height = Math.max(160, Math.floor(window.innerHeight - el.getBoundingClientRect().top - bottom));
      el.style.setProperty("--task-board-height", `${height}px`);
    };
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    if (el.closest("main")) observer.observe(el.closest("main")!);
    window.addEventListener("resize", fit);
    fit();
    return () => { observer.disconnect(); window.removeEventListener("resize", fit); };
  }, [remote]);
  const taskCard = (task: Task) => (
    <article className="task-card" key={task.uid} onClick={(event) => {
      if (!(event.target as HTMLElement).closest("label,select,option")) setDetail(task);
    }}>
      <h4><button type="button" className="task-card-title" title={tx("Görev ayrıntısı: {0}", [task.name])}>{task.name}</button></h4>
      {taskDescription(task) && <p>{taskDescription(task)}</p>}
      <label>
        <span className="sr-only">{task.name} {tx("durumu")}</span>
        <select aria-label={tx("{0} durumu", [task.name])} value={taskStatus(task)} disabled={disabled}
          onChange={(event) => {
            const status = Number(event.target.value);
            void perform(async () => {
              await api(`/agents/${agent.id}/tasks/${encodeURIComponent(task.uid)}`, "PATCH", { status });
              setVersion((value) => value + 1);
            }, tx("Görev durumu değiştirildi."));
          }}>
          {taskStates().map((state, index) => <option value={index} key={state}>{state}</option>)}
        </select>
      </label>
    </article>
  );
  const open = (value: typeof kind) => {
    setTitle("");
    setContent("");
    setProject("");
    setKind(value);
  };
  const pending = data.handoffs.filter(
    (h) => h.to_agent_id === agent?.id && ["pending", "not_started"].includes(h.status),
  );
  return (
    <>
      <Heading
        eyebrow={tx("HER AJANIN KENDİ İŞ DEFTERİ")}
        title={tx("Görevler ve notlar")}
        description={tx("Ajanınızın Tududi hesabındaki işleri tek yerden takip edin.")}
      >
        <div className="button-row tududi-actions">
          <button className="secondary" disabled={loading || demo || !agent} onClick={() => setVersion((v) => v + 1)}>{tx("Yenile")}</button>
          {agent?.tududi_state === "ready" && <>
            <button className="secondary" disabled={disabled} onClick={() => open("project")}>{tx("Proje ekle")}</button>
            <button className="secondary" disabled={disabled} onClick={() => open("note")}>{tx("Not ekle")}</button>
            <button className="primary" disabled={disabled} onClick={() => open("task")}><Icon name="plus" size={16} />{tx("Görev ekle")}</button>
          </>}
        </div>
      </Heading>
      <div className="tududi-toolbar">
        <label>
          {tx("Ajan")}
          <select value={agent?.id || ""} onChange={(e) => onSelect(e.target.value)}>
            {data.agents.map((a) => <option key={a.id} value={a.id}>{a.name} — {a.title}</option>)}
          </select>
        </label>
        {agent && <div className="tududi-panel-entry">
          <TududiLogin agent={agent} perform={perform} disabled={demo || disabled} prominent />
        </div>}
        {agent && <p className="field-help">{tx("Bu ekran özet gösterir; tam Tududi paneli yeni sekmede açılır.")}</p>}
      </div>
      {!agent ? (
        <Empty title={tx("Önce bir ajan ekleyin")}>
          {tx("Her ajan için ayrı bir Tududi hesabı açılır.")}
        </Empty>
      ) : demo ? (
        <Empty title={tx("Denemede gerçek görevlere bağlanılmaz")}>
          {tx("Gerçek görevleri görmek için deneme modunu kapatın.")}
        </Empty>
      ) : agent.tududi_state === "pending" ? (
        <div className="hint">
          <h3>{tx("Tududi hesabı bekliyor")}</h3>
          <p>
            {data.events.find((e) => e.agent_id === agent.id && e.kind === "tududi_pending")?.text || tx("Bağlantıyı ve yönetici ayarlarını kontrol edin. Ajanınız kaydedildi.")}
          </p>
          <button
            className="primary"
            disabled={disabled}
            onClick={() =>
              void perform(async () => {
                await api(`/agents/${agent.id}/retry`, "POST");
                setVersion((v) => v + 1);
              })
            }
          >
            {tx("Hesabı yeniden kur")}
          </button>
        </div>
      ) : error ? (
        <div className="alert error" role="alert">
          {error}
        </div>
      ) : loading ? (
        <div className="loading-screen">{tx("İş defteri alınıyor…")}</div>
      ) : (
        remote && (
          <>
            <section className="projects-strip">
              <h2>
                {tx("Projeler")} <span>{remote.projects.length}</span>
              </h2>
              {remote.projects.length ? (
                <div>
                  {remote.projects.map((p) => (
                    <article key={p.uid}>
                      <Icon name="grid" size={17} />
                      <strong>{p.name}</strong>
                      {p.description && <p>{p.description}</p>}
                    </article>
                  ))}
                </div>
              ) : (
                <p>
                  {tx("Henüz proje yok. Görev ve notları proje açmadan da ekleyebilirsiniz.")}
                </p>
              )}
            </section>
            <section className="tasks-section">
              <h2>
                {tx("Görevler")} <span>{remote.tasks.length}</span>
              </h2>
              <div className="task-columns" ref={board}>
                {[0, 1, 4, 2]
                  .map((index) => ({ label: taskStates()[index], index }))
                  .map(({ label, index }) => (
                    <div key={label} className="task-column">
                      <h3>
                        <i className={`task-dot task-${index}`} />
                        {label}
                        <span>
                          {
                            remote.tasks.filter((t) => taskStatus(t) === index)
                              .length
                          }
                        </span>
                      </h3>
                      <div className="task-column-body" tabIndex={0} role="region" aria-label={label}>
                        {remote.tasks.filter((task) => taskStatus(task) === index).map(taskCard)}
                        {!remote.tasks.some((task) => taskStatus(task) === index) && (
                          <p className="column-empty">{tx("Burada henüz görev yok.")}</p>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
              <details className="archived-tasks">
                <summary>
                  {tx("Arşivde ·")}{" "}
                  {remote.tasks.filter((t) => taskStatus(t) === 3).length} {tx("görev")}
                </summary>
                {remote.tasks.filter((task) => taskStatus(task) === 3).map(taskCard)}
                {!remote.tasks.some((t) => taskStatus(t) === 3) && (
                  <p className="column-empty">{tx("Arşivde görev yok.")}</p>
                )}
              </details>
            </section>
            <section className="notes-section">
              <h2>
                {tx("Notlar")} <span>{remote.notes.length}</span>
              </h2>
              {remote.notes.length ? (
                <div className="notes-grid">
                  {remote.notes.map((n) => (
                    <details className="note" key={n.uid}>
                      <summary>{n.title}</summary>
                      <p className="field-help">{tx("Son doğrulama:")} {n.verified_at ? new Date(n.verified_at).toLocaleDateString(locale()) : tx("Henüz doğrulanmadı")}{n.stale ? tx(" · Eski olabilir") : ''}{n.invalid ? tx(" · Yanlış, ajan kullanamaz") : ''}</p>
                      <p>{n.content}</p>
                      <div className="runtime-actions">
                        <button className="secondary" disabled={disabled || demo} onClick={()=>void perform(async()=>{await api(`/agents/${agent.id}/notes/${n.uid}/mark`,'PUT',{locked:!n.locked,invalid:!!n.invalid});setVersion(v=>v+1);})}>{n.locked ? tx("Kilidi kaldır") : tx("Kilitle")}</button>
                        <button className="secondary" disabled={disabled || demo} onClick={()=>void perform(async()=>{await api(`/agents/${agent.id}/notes/${n.uid}/mark`,'PUT',{locked:!!n.locked,invalid:!n.invalid});setVersion(v=>v+1);})}>{n.invalid ? tx("Yanlış işaretini kaldır") : tx("Yanlış işaretle")}</button>
                        <button className="secondary" disabled={disabled || demo} onClick={()=>void perform(async()=>{await api(`/agents/${agent.id}/notes/${n.uid}/mark`,'PUT',{locked:!!n.locked,invalid:false,verified:true});setVersion(v=>v+1);})}>{tx("Bugün doğruladım")}</button>
                      </div>
                    </details>
                  ))}
                </div>
              ) : (
                <p>{tx("Henüz not eklenmedi.")}</p>
              )}
            </section>
          </>
        )
      )}
      {pending.length > 0 && (
        <section className="pending-handoffs">
          <h2>{tx("Bekleyen ve başlatılamayan devirler")}</h2>
          {pending.map((h) => (
            <article key={h.id}>
              <div>
                <h3>{h.title}</h3>
                <p>{h.status === "not_started" ? tx("Başlatılamadı: {0}", [h.note]) : h.description || tx("Tududi görevi henüz açılmadı.")}</p>
              </div>
              <button
                className="secondary"
                disabled={disabled}
                onClick={() =>
                  void perform(async () => {
                    await api(`/handoffs/${h.id}/retry`, "POST");
                    setVersion((v) => v + 1);
                  })
                }
              >
                {tx("Yeniden dene")}
              </button>
            </article>
          ))}
        </section>
      )}
      {detail && <Modal title={tx("Görev ayrıntısı")} onClose={() => setDetail(null)}>
        <div className="task-detail">
          <h3>{detail.name}</h3>
          <p>{taskDescription(detail) || tx("Açıklama yok.")}</p>
          <p className="field-help">{taskStates()[taskStatus(detail)]}</p>
        </div>
      </Modal>}
      {kind && agent && (
        <Modal
          title={
            kind === "task"
              ? tx("Yeni görev")
              : kind === "note"
                ? tx("Yeni not")
                : tx("Yeni proje")
          }
          onClose={() => setKind(null)}
        >
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void perform(async () => {
                const body =
                  kind === "project"
                    ? { name: title }
                    : kind === "note"
                      ? {
                          title,
                          content,
                          ...(project ? { project_uid: project } : {}),
                        }
                      : {
                          name: title,
                          description: content,
                          ...(project ? { project_uid: project } : {}),
                        };
                await api(
                  `/agents/${agent.id}/${kind === "project" ? "projects" : kind === "note" ? "notes" : "tasks"}`,
                  "POST",
                  body,
                );
                setKind(null);
                setVersion((v) => v + 1);
              }, tx("İş defterine eklendi."));
            }}
          >
            <label>
              {kind === "project" ? tx("Proje adı") : tx("Başlık")}
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                required
              />
            </label>
            {kind !== "project" && (
              <>
                <label>
                  {kind === "note" ? tx("Notun içeriği") : tx("Açıklama")}
                  <textarea
                    rows={6}
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    maxLength={kind === "note" ? 60000 : 20000}
                    required={kind === "note"}
                  />
                </label>
                <label>
                  {tx("Proje")}
                  <select
                    value={project}
                    onChange={(e) => setProject(e.target.value)}
                  >
                    <option value="">{tx("Projesiz")}</option>
                    {remote?.projects.map((p) => (
                      <option key={p.uid} value={p.uid}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <div className="modal-actions">
              <button
                className="secondary"
                type="button"
                onClick={() => setKind(null)}
              >
                {tx("Vazgeç")}
              </button>
              <button className="primary" disabled={disabled}>
                {tx("Ekle")}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
function Rules({
  value,
  perform,
  disabled,
}: {
  value: string;
  perform: Perform;
  disabled: boolean;
}) {
  const [text, setText] = useState(value);
  const [original, setOriginal] = useState(value);
  const dirty = text !== original;
  useEffect(() => {
    if (!dirty) {
      setText(value);
      setOriginal(value);
    }
  }, [value]);
  return (
    <>
      <Heading
        eyebrow={tx("ORTAK ÇALIŞMA ANLAYIŞINIZ")}
        title={tx("Şirket kuralları")}
        description={tx("Bütün ajanlarınızın uymasını istediğiniz ortak talimatları yazın.")}
      />
      <div className="rules-layout">
        <section className="rules-card">
          <div className="rules-intro">
            <Icon name="book" size={25} />
            <div>
              <h2>{tx("Herkes için aynı başlangıç")}</h2>
              <p>
                {tx("Bu metin, her ajanın kendi talimatının başına eklenir. İş yapma biçiminizi, sınırlarınızı ve beklentilerinizi burada anlatın.")}
              </p>
            </div>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                await api("/rules", "PUT", { text });
                setOriginal(text);
              }, tx("Şirket kuralları kaydedildi."));
            }}
          >
            <label>
              {tx("Ortak talimat")}
              <textarea
                rows={15}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={tx("Örneğin: Sonuçlarını sade Türkçe yaz. Önerilerini kaynakları ve tarihleriyle açıkla. Bir karar gerektiğinde bana danış.")}
                maxLength={60000}
                disabled={disabled}
              />
            </label>
            <div className="rules-bottom">
              <span>
                {text.length.toLocaleString(locale())} {tx("karakter")}
                {dirty ? tx(" · Kaydedilmemiş değişiklikler") : ""}
              </span>
              <button className="primary" disabled={disabled || !dirty}>
                {tx("Kuralları kaydet")}
              </button>
            </div>
          </form>
        </section>
        <aside className="rules-guide">
          <span className="eyebrow">{tx("TALİMAT SIRASI")}</span>
          <h2>{tx("Ajan neyi okur?")}</h2>
          <ol>
            <li>
              <b>1</b>
              <span>
                {tx("Şirket kuralları")}<small>{tx("Bütün ekip için ortak sınırlar.")}</small>
              </span>
            </li>
            <li>
              <b>2</b>
              <span>
                {tx("Ajanın talimatı")}<small>{tx("Rolü ve çalışma biçimi.")}</small>
              </span>
            </li>
            <li>
              <b>3</b>
              <span>
                {tx("Verdiğiniz görev")}<small>{tx("Bu işten beklediğiniz sonuç.")}</small>
              </span>
            </li>
          </ol>
        </aside>
      </div>
    </>
  );
}
function Events({ data,perform,disabled }: { data: Snapshot;perform:Perform;disabled:boolean }) {
  const [agent, setAgent] = useState("");
  const [department, setDepartment] = useState("");
  const events = data.events.filter(
    (e) =>
      (!agent || e.agent_id === agent) &&
      (!department || e.department_id === department),
  );
  return (
    <>
      <Heading
        eyebrow={tx("OFİSİN HAFIZASI")}
        title={tx("Olaylar")}
        description={tx("Kim ne yaptı, ne zaman yaptı? Ofisin son 500 gelişmesi burada.")}
      />
      <div className="event-filters">
        <label>
          {tx("Bölüm")}
          <select
            value={department}
            onChange={(e) => {
              setDepartment(e.target.value);
              setAgent("");
            }}
          >
            <option value="">{tx("Tüm bölümler")}</option>
            {data.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {tx("Ajan")}
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">{tx("Tüm ajanlar")}</option>
            {data.agents
              .filter((a) => !department || a.department_id === department)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
        <span>{events.length} {tx("olay")}</span>
      </div>
      {events.length ? (
        <ol className="event-timeline">
          {events.map((e) => (
            <li key={e.id}>
              <span className="timeline-icon">
                <Icon
                  name={
                    e.kind.includes("task")
                      ? "check"
                      : e.kind.includes("message")
                        ? "send"
                        : "clock"
                  }
                  size={17}
                />
              </span>
              <div>
                <p>{e.kind==='office_trash' ? e.text.replace(/ Geri al: .*$/,'') : e.text}</p>
                {e.kind==='office_trash' && /Geri al: ([a-f0-9-]{36})/.test(e.text) && Date.now()-Date.parse(e.created_at)<86400000 && !data.events.some(other=>other.kind==='office_restored' && other.text.startsWith(e.text.split(tx(" 24 saat"))[0])) && <button className="secondary" disabled={disabled} onClick={()=>void perform(async()=>{await api(`/trash/${e.text.match(/Geri al: ([a-f0-9-]{36})/)![1]}/restore`,'POST',{});},tx("Kayıt geri alındı."))}>{tx("Geri al")}</button>}
                <small>
                  {data.agents.find((a) => a.id === e.agent_id)?.name ||
                    tx("Şirket")}
                  {e.department_id
                    ? " · " +
                      (data.departments.find((d) => d.id === e.department_id)
                        ?.name || "")
                    : ""}
                </small>
              </div>
              <time>{date(e.created_at)}</time>
            </li>
          ))}
        </ol>
      ) : (
        <Empty title={tx("Bu seçimde olay yok")}>
          {tx("Yeni gelişmeler otomatik olarak burada görünür.")}
        </Empty>
      )}
    </>
  );
}
