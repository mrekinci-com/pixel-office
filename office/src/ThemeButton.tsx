import { t as tx } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Theme = "light" | "dark" | "system";
const choices: { value: Theme; label: string; icon: "sun" | "moon" | "monitor" }[] = [
  { value: "light", get label() { return tx("Aydınlık"); }, icon: "sun" },
  { value: "dark", get label() { return tx("Koyu"); }, icon: "moon" },
  { value: "system", get label() { return tx("Sisteme uy"); }, icon: "monitor" },
];
function ThemeIcon({ name }: { name: "sun" | "moon" | "monitor" }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "sun" ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></> :
      name === "moon" ? <path d="M12 4H8V8H4V16H8V20H20V16H12V12H8V8H12Z" fill="currentColor" stroke="none" shapeRendering="crispEdges" /> :
        <><rect x="3" y="3" width="18" height="14" rx="2" /><path d="M12 17v4m-4 0h8" /></>}
  </svg>;
}
const currentTheme = (): Theme => {
  const value = document.documentElement.dataset.theme;
  return value === "light" || value === "dark" ? value : "system";
};

export function ThemeButton({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useState(currentTheme);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const selected = choices.find((c) => c.value === theme)!;
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const choose = (value: Theme) => {
    if (value === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = value;
    try { localStorage.setItem("po-tema", value); } catch { /* Keep the session preference. */ }
    setTheme(value);
    setOpen(false);
    trigger.current?.focus();
  };
  const box = trigger.current?.getBoundingClientRect();
  const position = { position: "fixed" as const, bottom: "auto", left: Math.max(8, Math.min(innerWidth - 176, (box?.right || 176) - 168)), top: Math.max(8, (box?.bottom || 0) + 140 < innerHeight ? (box?.bottom || 0) + 6 : (box?.top || 148) - 138) };
  return (
    <div className={`theme-picker ${compact ? "theme-compact" : ""}`} ref={root}
      onKeyDown={(e) => {
        if (e.key === "Escape") { setOpen(false); trigger.current?.focus(); }
        if (open && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[e.key === "Home" ? 0 : e.key === "End" ? 2 : (index + (e.key === "ArrowDown" ? 1 : 2)) % 3].focus();
        }
      }}>
      <button ref={trigger} className="secondary theme-button" type="button"
        title={tx("Tema: {0}", [selected.label])}
        aria-label={tx("Tema: {0}. Değiştir", [selected.label])}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}>
        <span className="theme-icon" aria-hidden="true"><ThemeIcon name={selected.icon} /></span>
        {!compact && <><span>{selected.label}</span></>}
      </button>
      {open && createPortal(<div ref={menu} className="theme-menu" style={position} role="menu" aria-label={tx("Tema seçimi")}>
        {choices.map((c) => <button key={c.value} type="button" role="menuitemradio"
          aria-checked={c.value === theme} onClick={() => choose(c.value)}>
          <span className="theme-icon" aria-hidden="true"><ThemeIcon name={c.icon} /></span>
          <span>{c.label}</span><span aria-hidden="true">{c.value === theme ? "✓" : ""}</span>
        </button>)}
      </div>, document.body)}
    </div>
  );
}
