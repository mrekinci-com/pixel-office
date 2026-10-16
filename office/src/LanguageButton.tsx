import { api } from './api';
import { useLanguage, setLanguage, t, type Language } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const choices: { value: Language; code: string; label: () => string }[] = [
  { value: 'tr', code: 'TR', label: () => t('Türkçe') },
  { value: 'en', code: 'EN', label: () => t('İngilizce') },
];

// Compact language picker for the sidebar footer; same look and menu behaviour as the theme button.
export function LanguageButton({ disabled = false, onChanged }: { disabled?: boolean; onChanged?: () => Promise<void> }) {
  const language = useLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const selected = choices.find(c => c.value === language) || choices[0];
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  async function change(value: Language) {
    setOpen(false); trigger.current?.focus();
    if (value === language) return;
    setBusy(true); setError('');
    try { await api('/language', 'PUT', { language: value }); setLanguage(value); await onChanged?.(); }
    catch { setError(t('Dil değiştirilemedi.')); }
    finally { setBusy(false); }
  }
  const box = trigger.current?.getBoundingClientRect();
  const height = 46 * choices.length + 12;
  const position = { position: 'fixed' as const, bottom: 'auto', left: Math.max(8, Math.min(innerWidth - 176, (box?.right || 176) - 168)), top: Math.max(8, (box?.bottom || 0) + height + 8 < innerHeight ? (box?.bottom || 0) + 6 : (box?.top || height) - height) };
  return <div className="theme-picker theme-compact language-picker" ref={root}
    onKeyDown={e => {
      if (e.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
      if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const n = buttons.length;
        buttons[e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n].focus();
      }
    }}>
    <button ref={trigger} className="secondary theme-button language-button" type="button"
      title={t('Dil: {0}', [selected.label()])}
      aria-label={t('Dil: {0}. Değiştir', [selected.label()])}
      aria-haspopup="menu" aria-expanded={open}
      disabled={disabled || busy}
      onClick={() => setOpen(!open)}>
      <span className="language-code" aria-hidden="true">{selected.code}</span>
    </button>
    {open && createPortal(<div ref={menu} className="theme-menu" style={position} role="menu" aria-label={t('Dil seçimi')}>
      {choices.map(c => <button key={c.value} type="button" role="menuitemradio" aria-checked={c.value === language} onClick={() => void change(c.value)}>
        <span className="language-code" aria-hidden="true">{c.code}</span>
        <span>{c.label()}</span><span aria-hidden="true">{c.value === language ? '✓' : ''}</span>
      </button>)}
    </div>, document.body)}
    {error && <span className="sr-only" role="alert">{error}</span>}
  </div>;
}
