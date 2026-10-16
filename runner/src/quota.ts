import { t as tx } from "./i18n.js";
export function quota(text: string): { reason: string; until: number | null } | undefined {
  if (!/(?:rate_limit|usage_limit|quota_exceeded|too many requests|rate limit|usage limit|limit reached|hit your limit|kullanım sınırı|hız sınırı)/i.test(text)) return;
  const retry = text.match(/retry[_ -]?after["':\s=]*(\d+)/i);
  const timestamp = text.match(/(?:reset|resets|retry at)["':\s=]*([^\n,}]+)/i);
  const date = timestamp ? Date.parse(timestamp[1].trim()) : NaN;
  return { reason: tx("Sağlayıcı kullanım veya hız sınırına ulaştı."), until: retry ? Date.now() + Math.min(Number(retry[1]), 604800) * 1000 : Number.isFinite(date) && date > Date.now() ? date : null };
}
