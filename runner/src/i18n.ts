import { AsyncLocalStorage } from 'node:async_hooks';
import { translate, type Language } from '../../office/shared/i18n/index.js';
const context = new AsyncLocalStorage<Language>();
export function runnerLanguage(): Language { return context.getStore() || (process.env.OFIS_LANGUAGE === 'en' ? 'en' : 'tr'); }
export const t = (key: string, values?: readonly unknown[]) => translate(runnerLanguage(), key, values);
export function withLanguage<T>(language: Language, action: () => T): T { return context.run(language, action); }
export function setRunnerLanguage(language: Language) { context.enterWith(language); }
