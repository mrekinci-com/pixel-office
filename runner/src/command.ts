import { t as tx } from "./i18n.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  lstatSync,
  chmodSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { validTerminalId, writeTerminalJson } from "./terminal-state.js";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Lease } from "../../office/shared/runtime.js";
import { filteredEnv, type RunnerConfig } from "./config.js";
import { validateFolder } from "./files.js";
import { authCache, cleanAuth } from "./auth.js";
import { CLAUDE_NATIVE_TOOLS, writeClaudePolicy, verifyClaudePolicy } from "./claude-policy.js";
import { assertLaunchSize, guardLaunch } from "./launch-size.js";
export interface Command {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  launchWarnings?: string[];
}
const toml = (s: string) => JSON.stringify(s);
const compactPath = (path: string | undefined) => path ? [...new Set(path.split(":"))].join(":") : path;
// Load the same settings file for real runs and the security probe.
export function codexSettings(command: Command): string[] {
  const result: string[] = [];
  for (let i = 0; i < command.args.length; i++)
    if (["-c", "-p"].includes(command.args[i])) result.push(command.args[i], command.args[++i]);
  return result;
}
// Duplicate paths make TOML invalid and Codex rejects it; deduplicate paths.
function fsLinks(links: { path: string; access: string; approved_write: boolean }[], taken: string[]) {
  const seen = new Map<string, string>();
  for (const link of links) {
    if (taken.includes(link.path)) continue;
    const mode = link.access === "write" && !link.approved_write ? "write" : "read";
    if (seen.get(link.path) !== "write") seen.set(link.path, mode);
  }
  return [...seen].map(([path, mode]) => `,${toml(path)}=${toml(mode)}`).join("");
}
function runtimeRoot() {
  const compiled = import.meta.url.endsWith("/dist/runner/src/command.js");
  return fileURLToPath(
    new URL(compiled ? "../../" : "../dist/", import.meta.url),
  );
}
const controlDirs = [".codex", ".claude", ".agents", ".config"];
function privateDirectory(path: string) {
  let current='/';
  for(const piece of resolve(path).split('/').filter(Boolean)){
    current=join(current,piece);
    let stat;
    try { stat=lstatSync(current); }
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      mkdirSync(current,{mode:0o700});stat=lstatSync(current);
    }
    if(!stat.isDirectory() || stat.isSymbolicLink())throw new Error(tx("Oturum profil yolu kullanılamıyor."));
  }
}
function privateText(path: string, content: string) {
  try {
    const stat=lstatSync(path);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1)
      throw new Error(tx("Ajan ayar dosyası yolu kullanılamıyor."));
  } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; }
  const temporary=path+'.'+randomUUID();
  try { writeFileSync(temporary,content,{flag:'wx',mode:0o600}); renameSync(temporary,path); }
  finally { try { unlinkSync(temporary); } catch { /* Already renamed. */ } }
}
export function prepare(
  l: Lease,
  c: RunnerConfig,
  terminal = false,
): { command: Command; profile: string; work: string; initialAuth: string } {
  if (terminal && (l.agent.builtin !== "director" || !l.session)) throw new Error(tx("Terminal yalnız Genel Müdür oturumuna açıktır."));
  if (l.policy.network)
    throw new Error(tx("Ağ erişimi güvenli köprü kurulana kadar kapalıdır. Ağ iznini kapatın."));
  if (l.policy.commands && l.agent.runner === "claude")
    throw new Error(tx("Claude için komut çalıştırma açılamaz. Codex seçin."));
  const work = join(c.workDir, "ofis", l.agent.id),
    profile = terminal ? join(c.workDir, ".terminal", l.agent.id, String(l.session?.generation)) : l.session ? join(c.workDir, ".oturum", l.agent.id, String(l.session.generation)) : join(c.workDir, ".runtime", l.run.id);
  if (l.session && (!/^[a-f0-9-]{36}$/.test(l.agent.id) || !Number.isSafeInteger(l.session.generation) || l.session.generation < 1)) throw new Error(tx("Oturum yolu geçersiz."));
  privateDirectory(work);
  privateDirectory(profile);
  if (lstatSync(profile).isSymbolicLink() || realpathSync(profile) !== resolve(profile)) throw new Error(tx("Oturum profil yolu kullanılamıyor."));
  chmodSync(profile, 0o700);
  privateDirectory(join(work, "gelen"));
  privateDirectory(join(work, "dizin-haritasi"));
  for (const dir of controlDirs) {
    const path = join(work, dir);
    if (
      existsSync(path) &&
      (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())
    )
      throw new Error(tx("Çalışma klasöründeki özel ayar yolu kullanılamıyor."));
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  for (const dir of ["tmp", "config", "cache", "claude", "codex", "empty"])
    privateDirectory(join(profile, dir));
  // Only dedicated authentication is copied; personal settings/hook/plugin/skill directories never are.
  const cached = authCache(c.workDir, l.agent.runner);
  const existingTerminalAuth=l.agent.runner === "claude" ? join(profile,"claude",".credentials.json") : join(profile,"codex","auth.json");
  if(terminal && existsSync(existingTerminalAuth) && lstatSync(existingTerminalAuth).isSymbolicLink())throw new Error(tx("Terminal kimlik yolu kullanılamıyor."));
  const auth = terminal && existsSync(existingTerminalAuth) ? existingTerminalAuth : existsSync(cached)
    ? cached
    : l.agent.runner === "claude"
      ? c.claudeAuth
      : c.codexAuth;
  let initialAuth = "";
  if (auth) {
    let parsed: ReturnType<typeof cleanAuth>;
    try { parsed = cleanAuth(l.agent.runner, JSON.parse(readFileSync(auth, "utf8"))); }
    catch { throw new Error(tx("Hizmet hesabının kimlik dosyası okunamıyor. Ayrı model hesabına yeniden giriş yapın.")); }
    initialAuth = JSON.stringify(parsed);
    if (l.agent.runner === "codex") {
      const allowed = ["OPENAI_API_KEY", "tokens", "last_refresh", "auth_mode"];
      const clean = Object.fromEntries(
        allowed.filter((k) => k in parsed).map((k) => [k, parsed[k]]),
      );
      privateText(
        join(profile, "codex", "auth.json"),
        JSON.stringify(clean),
      );
    } else {
      privateText(
        join(profile, "claude", ".credentials.json"),
        JSON.stringify({ claudeAiOauth: parsed.claudeAiOauth }),
      );
    }
  }
  const env = filteredEnv(profile),
    mcp = join(runtimeRoot(), "runner", "src", "mcp.js");
  if (!existsSync(mcp)) throw new Error(tx("Çalıştırıcı önce derlenmeli."));
  const linksFile = join(profile, "mcp-links.json");
  privateText(linksFile, JSON.stringify(l.links.map(({ id, path, access, approved_write }) => ({ id, path, access, approved_write }))));
  env.OFIS_LANGUAGE = l.language || c.language || "tr";
  const mcpEnv: NodeJS.ProcessEnv = {
    OFIS_LANGUAGE: l.language || c.language || "tr",
    OFIS_URL: c.url,
    OFIS_AGENT_KEY: l.key,
    OFIS_AGENT_WORK: work,
    OFIS_AGENT_LINKS_FILE: linksFile,
    OFIS_AGENT_TOOLS: JSON.stringify(l.toolNames) || "",
    ...filteredEnv(profile),
  };
  const mcpLaunch = guardLaunch({ bin: process.execPath, args: [mcp], env: mcpEnv }, current => ({ ...current, env: { ...current.env, PATH: compactPath(current.env.PATH) } }));
  Object.assign(mcpEnv, mcpLaunch.env);
  const mcpConfig = join(profile, "mcp.json");
  privateText(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        ofis: { command: process.execPath, args: [mcp], env: mcpEnv },
      },
    }),
  );
  const links =
    l.policy.permission === "folders"
      ? l.links.map((link) => ({ ...link, path: validateFolder(link.path, c) }))
      : [];
  if (links.some((l) => l.validation !== "valid"))
    throw new Error(tx("Klasör bağlantısının doğrulanması bekleniyor."));
  const addDirs = links
    .filter((l) => l.access === "write" && !l.approved_write)
    .map((l) => l.path);
  let args: string[], bin: string;
  if (l.agent.runner === "claude") {
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1";
    env.DISABLE_AUTOUPDATER="1";
    writeClaudePolicy(profile,work,l,links,terminal);
    const native = l.policy.permission === "chat" ? "" : CLAUDE_NATIVE_TOOLS;
    args = [
      "--model", l.agent.model, "--effort", l.agent.effort,
      "--restricted", "--setting-sources", "",
      "--strict-mcp-config", "--mcp-config", mcpConfig,
      "--disable-slash-commands", "--no-chrome",
      "--permission-mode", "dontAsk", "--tools", native,
      "--allowedTools", native ? `${native},mcp__ofis__*` : "mcp__ofis__*",
      "--disallowedTools", JSON.parse(readFileSync(join(profile,"claude-policy","managed-settings.json"),"utf8")).permissions.deny.join(","),
    ];
    if (terminal) {
      if(l.terminalInstructions) {
        const instructions=join(profile,"claude-instructions.txt");
        privateText(instructions,l.terminalInstructions);
        // Present in the installed CLI's full option parser (help hides file variants).
        args.push("--append-system-prompt-file",instructions);
      }
      const idFile=join(profile,"claude","terminal-session.json");
      let id=l.session!.provider_id || randomUUID();
      if(existsSync(idFile)) {
        const stat=lstatSync(idFile);
        if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || stat.size>1000)throw new Error(tx("Claude konuşma kimliği okunamadı."));
        id=JSON.parse(readFileSync(idFile,"utf8")).provider_id;
        if(!validTerminalId(id))throw new Error(tx("Claude konuşma kimliği okunamadı."));
      } else writeTerminalJson(idFile,{provider_id:id});
      args.push("--session-id", id);
      args.push(l.prompt);
    } else {
      args.push("--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-prompts", "none");
      if(l.session?.provider_id)args.push("--resume",l.session.provider_id);
      else if(l.session)args.push("--session-id",randomUUID());
      else args.push("--no-session-persistence");
    }
    // Additional directories are managed policy, so /add-dir cannot grant a
    // readable alias of the CLI profile. Personal settings are never loaded.
    bin = c.claude;
  } else {
    args = [
      "exec",
      "--json",
      "--strict-config",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "-m",
      l.agent.model,
      "-c",
      `model_reasoning_effort=${toml(l.agent.effort)}`,
      "-C",
      work,
      "-c",
      'approval_policy="never"',
      "-c",
      'web_search="disabled"',
      "-c",
      "features.shell_snapshot=false",
      "-c",
      "features.skill_search=false",
      "-c",
      "features.skill_mcp_dependency_install=false",
      "-c",
      "features.skip_host_skill_discovery=true",
      "-c",
      "features.plugins=false",
      "-c",
      "features.remote_plugin=false",
      "-c",
      "features.workspace_dependencies=false",
      "-c",
      "features.browser_use=false",
      "-c",
      "features.computer_use=false",
      "-c",
      "features.image_generation=false",
      "-c",
      "features.memories=false",
      "-c",
      "features.goals=false",
      "-c",
      "features.multi_agent=false",
      "-c",
      "features.apps=false",
      "-c",
      "features.hooks=false",
      "-c",
      "features.unified_exec=false",
      "-c",
      `features.shell_tool=${l.policy.permission !== "chat"}`,
      "-c",
      "suppress_unstable_features_warning=true",
      "-c",
      "project_doc_max_bytes=0",
      "-c",
      "check_for_update_on_startup=false",
      "-c",
      "project_doc_fallback_filenames=[]",
      "-c",
      `projects={${toml(work)}={trust_level="untrusted"}}`,
      "-c",
      'shell_environment_policy.inherit="none"',
      "-c",
      `shell_environment_policy.set={PATH="/usr/bin:/bin",HOME=${toml(profile)},LANG="C.UTF-8",TMPDIR=${toml(join(profile, "tmp"))}}`,
      "-c", 'default_permissions="ofis"',
      "-c", `permissions={ofis={extends=":workspace",filesystem={":minimal"="read",${toml(work)}=${toml(l.policy.permission === "chat" ? "read" : "write")},${toml(profile)}="deny",${toml(join(work, "gelen"))}="read",${toml(join(work, "dizin-haritasi"))}="read"${fsLinks(links, [work, profile, join(work, "gelen"), join(work, "dizin-haritasi")])}},network={enabled=false}}}`,
      "-c",
      `mcp_servers.ofis.command=${toml(process.execPath)}`,
      "-c",
      `mcp_servers.ofis.args=[${toml(mcp)}]`,
      "-c",
      "mcp_servers.ofis.required=true",
      "-c",
      // Office tools enforce agent identity on the server; Codex needs no extra approval prompt.
      'mcp_servers.ofis.default_tools_approval_mode="approve"',
    ];
    for (const [key, value] of Object.entries(mcpEnv))
      if (value !== undefined) args.push("-c", `mcp_servers.ofis.env.${key}=${toml(value)}`);
    if(terminal && l.terminalInstructions)args.push('-c',`developer_instructions=${toml(l.terminalInstructions)}`);
    // Codex 0.159.1 ignores the -p file with --ignore-user-config. For normal
    // runs, reset the base file in private CODEX_HOME and load only our
    // generated profile; never copy personal settings.
    // Preserve persistent terminal preferences such as /model.
    if (!terminal) {
      const baseConfig = join(profile, "codex", "config.toml");
      if (existsSync(baseConfig) && lstatSync(baseConfig).isSymbolicLink()) throw new Error(tx("Ajan ayar dosyası yolu kullanılamıyor."));
      privateText(baseConfig, "");
      args.splice(args.indexOf("--ignore-user-config"), 1);
    }
    // Keep the terminal permission definition for managed requirements.toml
    // in arguments; load other long settings from files in both paths.
    const configName = "ofis-runtime";
    const configPath = join(profile, "codex", `${configName}.config.toml`);
    const configLines: string[] = [];
    const moveSettings = (all = false) => {
      for (let i = 0; i < args.length; i++) {
        if (args[i] !== "-c") continue;
        const value = args[i + 1];
        if ((all && !terminal) || value.startsWith("mcp_servers.") || value.startsWith("developer_instructions=") || (!terminal && value.startsWith("permissions="))) {
          configLines.push(value); args.splice(i, 2); i--;
        }
      }
      // Do not trust old contents or permissions in a persistent session profile.
      if (existsSync(configPath) && lstatSync(configPath).isSymbolicLink()) throw new Error(tx("Ajan ayar dosyası yolu kullanılamıyor."));
      privateText(configPath, configLines.join("\n") + "\n");
    };
    moveSettings();
    args.splice(1, 0, "-p", configName);
    for (const path of addDirs) args.push("--add-dir", path);
    if (l.session) {
      args.splice(args.indexOf("--ephemeral"), 1);
      if (l.session.provider_id) {
        const at = args.indexOf("-C"); args.splice(at, 2);
        const parentDirs: string[] = [];
        for (let i = 0; i < args.length; i++) if (["--add-dir", "-p"].includes(args[i])) { parentDirs.push(...args.splice(i, 2)); i--; }
        args = ["exec", "-C", work, ...parentDirs, "resume", ...args.slice(1), l.session.provider_id];
      }
    }
    args.push(terminal ? l.prompt : "-");
    bin = c.codex;
    const command: Command = { bin, args, cwd: work, env, launchWarnings: mcpLaunch.launchWarnings, ...(!terminal ? { stdin: l.prompt } : {}) };
    return { command: guardLaunch(command, (current) => {
      // Move any remaining oversized -c setting into the file as well.
      moveSettings(true);
      return { ...current, args, env: { ...current.env, PATH: compactPath(current.env.PATH) } };
    }), profile, work, initialAuth };
  }
  return { command: guardLaunch({ bin, args, cwd: work, env, launchWarnings: mcpLaunch.launchWarnings, ...(!terminal ? {stdin:l.prompt}: {}) }, current => ({ ...current, env: { ...current.env, PATH: compactPath(current.env.PATH) } })), profile, work, initialAuth };
}
function executable(bin: string, env: NodeJS.ProcessEnv): string {
  if (bin.includes("/")) return realpathSync(bin);
  const match = (env.PATH || "")
    .split(":")
    .map((root) => join(root, bin))
    .find(existsSync);
  if (!match) throw new Error(bin === "bwrap" ? tx("bwrap yalıtım aracı kurulu değil.") : tx("Gerekli komut satırı kurulu değil."));
  return realpathSync(match);
}
export function isolate(
  command: Command,
  c: RunnerConfig,
  l: Lease,
  profile: string,
): Command {
  assertLaunchSize(command);
  const wrapper = executable(c.bwrap, command.env),
    bin = executable(command.bin, command.env);
  // Fail closed if namespaces are denied. No unsandboxed production fallback.
  const probe = spawnSync(
    wrapper,
    [
      "--unshare-user",
      "--unshare-pid",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      "/lib",
      "/lib",
      "--ro-bind",
      "/lib64",
      "/lib64",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--",
      "/usr/bin/true",
    ],
    { env: command.env, timeout: 3000, encoding: "utf8", maxBuffer: 20000 },
  );
  if (probe.status !== 0)
    throw new Error(
      tx("Dosya sistemi izolasyonu kullanılamıyor; güvenlik için çalışma başlatılmadı.\n") + (probe.stderr || "").slice(-5000),
    );
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  ];
  const mount = (flag: string, path: string) => {
    if (existsSync(path)) args.push(flag, path, path);
  };
  for (const path of [
    "/usr",
    "/bin",
    "/lib",
    "/lib64",
    "/etc/ssl",
    "/etc/ca-certificates",
    "/etc/resolv.conf",
    "/etc/hosts",
    "/etc/nsswitch.conf",
    "/etc/passwd",
    "/etc/group",
  ])
    mount("--ro-bind", path);
  // The executable package and Node installation, not their parent home directories.
  const nodeRoot = resolve(dirname(process.execPath), "..");
  if (!nodeRoot.startsWith("/usr")) mount("--ro-bind", process.execPath);
  const packageRoot = dirname(bin).includes("/bin")
    ? resolve(dirname(bin), "..")
    : dirname(bin);
  if (!packageRoot.startsWith("/usr") && packageRoot !== nodeRoot)
    mount("--ro-bind", packageRoot);
  if (l.agent.runner === "codex" && bin.endsWith("/bin/codex.js")) {
    try {
      const platformPackage = `@openai/codex-linux-${process.arch === "x64" ? "x64" : "arm64"}/package.json`;
      mount("--ro-bind", dirname(createRequire(bin).resolve(platformPackage)));
    } catch {
      /* Older installations keep the native binary inside their own vendor directory. */
    }
  }
  mount("--ro-bind", runtimeRoot());
  const terminalPolicy=join(profile,'terminal-policy');
  if(l.agent.builtin==='director' && existsSync(join(terminalPolicy,'requirements.toml'))) {
    if(lstatSync(terminalPolicy).isSymbolicLink() || realpathSync(terminalPolicy)!==resolve(terminalPolicy))throw new Error(tx("Terminal izin yolu kullanılamıyor."));
    args.push('--ro-bind',terminalPolicy,'/etc/codex');
  }
  const claudePolicyDir=join(profile,'claude-policy');
  if(l.agent.runner==='claude') {
    verifyClaudePolicy(command,profile);
    args.push('--ro-bind',claudePolicyDir,'/etc/claude-code');
  }
  // runtime home must be writable for auth refresh/cache; work is the only user document mount.
  mount("--bind", profile);
  // Keep the policy's source alias read-only too, after the writable home bind.
  if(l.agent.builtin==='director' && existsSync(join(terminalPolicy,'requirements.toml')))
    mount('--ro-bind',terminalPolicy);
  if(l.agent.runner==='claude') {
    mount('--ro-bind',claudePolicyDir);
    mount('--ro-bind',join(profile,'claude-files.json'));
    mount('--ro-bind',join(profile,'mcp.json'));
    mount('--ro-bind',join(profile,'mcp-links.json'));
    mount('--ro-bind',join(profile,'claude-instructions.txt'));
  }
  // Give Codex's nested sandbox the verified outer bwrap executable on PATH.
  // This is a file-only read-only mount; no additional host directory is exposed.
  const sandboxBin='/opt/ofis-sandbox/bin';
  if(l.agent.runner==='codex')args.push('--ro-bind',wrapper,join(sandboxBin,'bwrap'));
  mount(l.policy.permission === "chat" ? "--ro-bind" : "--bind", command.cwd);
  mount("--ro-bind", join(command.cwd, "gelen"));
  mount("--ro-bind", join(command.cwd, "dizin-haritasi"));
  for (const dir of controlDirs)
    args.push("--ro-bind", join(profile, "empty"), join(command.cwd, dir));
  if (l.policy.permission === "folders")
    for (const link of l.links)
      mount(
        link.access === "write" && !link.approved_write
          ? "--bind"
          : "--ro-bind",
        validateFolder(link.path, c),
      );
  args.push("--chdir", command.cwd, "--", bin, ...command.args);
  return guardLaunch({ ...command, bin: wrapper, args,env:l.agent.runner==='codex'?{...command.env,PATH:`${sandboxBin}:${command.env.PATH || '/usr/bin:/bin'}`}:command.env });
}

// The actual CLI sandbox is probed inside the same outer bwrap mounts before enabling shell.
// No request is sent to personal services: socket creation itself must be denied.
export function verifyShell(command: Command, c: RunnerConfig, l: Lease, profile: string) {
  if (l.agent.runner !== "codex" || l.policy.permission === "chat") return;
  const settings = codexSettings(command);
  const script = `import socket,errno,os
for family,kind in [(socket.AF_INET,socket.SOCK_STREAM),(socket.AF_INET6,socket.SOCK_STREAM),(socket.AF_INET,socket.SOCK_DGRAM)]:
 try:
  socket.socket(family,kind)
  raise SystemExit(2)
 except OSError as e:
  if e.errno not in (errno.EPERM,errno.EACCES): raise SystemExit(3)
for path in ${JSON.stringify([join(profile, "codex", "auth.json"), join(profile, "mcp.json"), join(profile, "claude", ".credentials.json")])}:
 try:
  fd=os.open(path,os.O_RDONLY)
  os.close(fd)
  raise SystemExit(4)
 except OSError as e:
  if e.errno not in (errno.EPERM,errno.EACCES,errno.ENOENT): raise SystemExit(5)
print("OFIS_NETWORK_DENIED")`;
  const probe = isolate({ ...command, args: [
    "sandbox", ...settings, "-P", "ofis", "-C", command.cwd,
    "--", "/usr/bin/python3", "-c", script,
  ] }, c, l, profile);
  const result = spawnSync(probe.bin, probe.args, {
    cwd: probe.cwd, env: probe.env, timeout: 10000, maxBuffer: 20000, encoding: "utf8",
  });
  if (result.status !== 0 || result.stdout.trim() !== "OFIS_NETWORK_DENIED")
    throw new Error(tx("Codex kabuğunun ağ yalıtımı doğrulanamadı veya kimlik dosyası okunabiliyor; güvenlik için çalışma başlatılmadı. bwrap ve Codex kum havuzunu kontrol edin.\n") + (result.stderr || "").slice(-5000));
}
