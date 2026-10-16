import { t as tx } from "./i18n.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
export function profileSecrets(profile: string): string[] {
  const secrets = new Set<string>();
  const collect = (value: unknown) => {
    if (typeof value === "string" && value.length >= 8) secrets.add(value);
    else if (value && typeof value === "object")
      Object.values(value).forEach(collect);
  };
  for (const file of [
    join(profile, "codex", "auth.json"),
    join(profile, "claude", ".credentials.json"),
  ]) {
    if (existsSync(file)) {
      try { collect(JSON.parse(readFileSync(file, "utf8"))); }
      catch { throw new Error(tx("Hizmet hesabının kimlik dosyası okunamıyor. Yeniden giriş yapın.")); }
    }
  }
  return [...secrets];
}
