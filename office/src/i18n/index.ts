import { useSyncExternalStore } from 'react';
import { localeFor, translate, type Language } from '../../shared/i18n/index';
export type { Language } from '../../shared/i18n/index';
const listeners = new Set<() => void>();
function initialLanguage(): Language {
  if (typeof window === 'undefined') return 'en';
  try { const saved = localStorage.getItem('po-language'); if (saved === 'tr' || saved === 'en') return saved; } catch { /* Session preference still works. */ }
  return 'en';
}
let language = initialLanguage();
export const getLanguage = () => language;
export const locale = () => localeFor(language);
export const t = (key: string, values?: readonly unknown[]) => translate(language, key, values);
function updateDocument() { if (typeof document !== 'undefined') { document.documentElement.lang = language; document.title = language === 'tr' ? 'Piksel Ofis — Sanal şirketiniz' : 'Pixel Office — Your virtual company'; } }
updateDocument();
export function setLanguage(value: Language) {
  const changed = value !== language;
  language = value;
  try { localStorage.setItem('po-language', value); } catch { /* Preference survives in this session. */ }
  updateDocument();
  if (changed) for (const listener of listeners) listener();
}
export function useLanguage() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getLanguage, () => 'en');
}
