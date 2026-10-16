import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
export function cleanAuth(
  runner: "claude" | "codex",
  value: Record<string, unknown>,
) {
  if (runner === "claude") return { claudeAiOauth: value.claudeAiOauth };
  const fields = ["OPENAI_API_KEY", "tokens", "last_refresh", "auth_mode"];
  return Object.fromEntries(
    fields.filter((k) => k in value).map((k) => [k, value[k]]),
  );
}
export function authCache(work: string, runner: "claude" | "codex") {
  return join(work, ".auth", runner + ".json");
}
export function retainAuth(
  work: string,
  runner: "claude" | "codex",
  profile: string,
  initial: string,
) {
  if (!initial) return;
  const file =
    runner === "claude"
      ? join(profile, "claude", ".credentials.json")
      : join(profile, "codex", "auth.json");
  if (!existsSync(file)) return;
  const refreshed = JSON.stringify(
    cleanAuth(runner, JSON.parse(readFileSync(file, "utf8"))),
  );
  const target = authCache(work, runner);
  if (existsSync(target)) {
    const current = JSON.stringify(
      cleanAuth(runner, JSON.parse(readFileSync(target, "utf8"))),
    );
    if (current !== initial || refreshed === initial) return; // A concurrent run already refreshed it; don't restore an older copy.
  }
  mkdirSync(join(work, ".auth"), { recursive: true, mode: 0o700 });
  const tmp = target + "." + randomUUID();
  writeFileSync(tmp, refreshed, { mode: 0o600, flag: "wx" });
  renameSync(tmp, target);
}

export function hasAuth(work: string, runner: "claude" | "codex", configured?: string): boolean {
  try {
    const cached = authCache(work, runner);
    const file = existsSync(cached) ? cached : configured;
    if (!file) return false;
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (runner === "claude") return typeof value.claudeAiOauth?.accessToken === "string" && !!value.claudeAiOauth.accessToken;
    return !!value.OPENAI_API_KEY || !!value.tokens?.access_token;
  } catch { return false; }
}

export function claudeLoginDirectory(work:string) { return join(work,'.auth','claude-login'); }
export function claudeLoginCommand(work:string) {
  const quote=(text:string)=>"'"+text.replaceAll("'", "'\\''")+"'";
  const path=quote(claudeLoginDirectory(work));
  return `mkdir -p -- ${path} && chmod 700 -- ${path} && env -i PATH="$PATH" LANG=C.UTF-8 HOME=${path} CLAUDE_CONFIG_DIR=${path} claude`;
}
