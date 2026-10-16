import { en } from './en.js';
import { tr } from './tr.js';
export type Language = 'tr' | 'en';
export type TranslationKey = keyof typeof en;
export const catalogs = { tr, en };
export function languageFrom(value?: string | null): Language {
  return /^tr(?:[-_.]|$)/i.test(value || '') ? 'tr' : 'en';
}
export function localeFor(language: Language) { return language === 'tr' ? 'tr-TR' : 'en-US'; }
export function translate(language: Language, key: string, values: readonly unknown[] = []): string {
  const catalog: Record<string, string> = catalogs[language];
  const text = catalog[key] ?? key;
  return text.replace(/\{(\d+)\}/g, (placeholder, index: string) => Number(index) < values.length ? String(values[Number(index)]) : placeholder);
}
