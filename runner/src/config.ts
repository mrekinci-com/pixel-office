import { claudeLoginDirectory } from "./auth.js";
import { t as tx } from "./i18n.js";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
export interface RunnerConfig {
  language?: import("../../office/shared/i18n/index.js").Language;
  smokeRoot?: string;
  smoke?: boolean;
  codexModels?: string[];
  claudeModels?: string[];
  url: string;
  key: string;
  workDir: string;
  allowedRoots: string[];
  protectedRoots: string[];
  concurrency: number;
  claude: string;
  codex: string;
  bwrap: string;
  claudeAuth?: string;
  codexAuth?: string;
  codexModel: string;
}
export function repositoryRoot(start = dirname(fileURLToPath(import.meta.url))): string {
  let root = resolve(start);
  while (root !== "/" && !(
    existsSync(resolve(root, "docker-compose.yml")) &&
    existsSync(resolve(root, "office/package.json")) &&
    existsSync(resolve(root, "runner/package.json"))
  )) root = dirname(root);
  if (root === "/") throw new Error(tx("Depo kökü bulunamadı. Çalıştırıcı bu depo içinden kurulmalı."));
  return root;
}
export function loadConfig(env = process.env): RunnerConfig {
  const url = env.OFIS_URL || "http://127.0.0.1:9400";
  if (!/^http:\/\/127\.0\.0\.1:(9400|9401)$/.test(url))
    throw new Error(tx("OFIS_URL yalnız yerel Ofis veya deneme Ofis adresi olabilir."));
  const key = env.OFIS_RUNNER_KEY || "";
  if (key.length < 32)
    throw new Error(tx("OFIS_RUNNER_KEY en az 32 karakter olmalı."));
  const concurrency = Number(env.OFIS_CONCURRENCY || 2);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new Error(tx("Eşzamanlılık 1–16 arasında olmalı."));
  const root = repositoryRoot();
  return {
    smoke: env.OFIS_SMOKE === "1",
    smokeRoot: env.OFIS_SMOKE === '1' && url==='http://127.0.0.1:9401' ? resolve(root,'runner/test-code') : undefined,
    codexModels: (env.OFIS_CODEX_MODELS || env.OFIS_CODEX_MODEL || "gpt-6.1-sol").split(",").filter(Boolean),
    claudeModels: (env.OFIS_CLAUDE_MODELS || "sonnet,opus,haiku").split(",").filter(Boolean),
    url,
    key,
    workDir: resolve(env.OFIS_WORK_DIR || "work"),
    allowedRoots: (env.OFIS_ALLOWED_ROOTS || "")
      .split(":")
      .filter(Boolean)
      .map((p) => resolve(p)),
    protectedRoots: [
      root,
      ...(env.OFIS_REPO_DIR ? [resolve(env.OFIS_REPO_DIR)] : []),
      ...(env.OFIS_PROTECTED_ROOTS || "")
        .split(":")
        .filter(Boolean)
        .map((p) => resolve(p)),
    ],
    concurrency,
    claude: env.OFIS_CLAUDE_BIN || "claude",
    codex: env.OFIS_CODEX_BIN || "codex",
    bwrap: env.OFIS_BWRAP_BIN || "bwrap",
    claudeAuth: env.OFIS_CLAUDE_AUTH_FILE || resolve(claudeLoginDirectory(resolve(env.OFIS_WORK_DIR || "work")),".credentials.json"),
    codexAuth: env.OFIS_CODEX_AUTH_FILE,
    codexModel: env.OFIS_CODEX_MODEL || "gpt-6.1-sol",
  };
}
export function filteredEnv(
  profile: string,
  env = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    HOME: profile,
    PATH: env.PATH || "/usr/bin:/bin",
    LANG: "C.UTF-8",
    TMPDIR: profile + "/tmp",
    XDG_CONFIG_HOME: profile + "/config",
    XDG_CACHE_HOME: profile + "/cache",
    CODEX_HOME: profile + "/codex",
    CLAUDE_CONFIG_DIR: profile + "/claude",
  };
  // Deliberately no passthrough for provider keys, proxy variables, hooks or loader options.
  return result;
}
