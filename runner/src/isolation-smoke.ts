import { t as tx } from "./i18n.js";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "../../office/shared/types.js";
import type { Lease, FolderLink } from "../../office/shared/runtime.js";
import { defaultPolicy } from "../../office/shared/runtime.js";
import { loadConfig, type RunnerConfig } from "./config.js";
import { prepare, isolate, verifyShell, codexSettings } from "./command.js";

export async function isolationSmoke(input: { agent: Agent; other: Agent; repo: string; home: string; workDir: string }) {
  if (input.agent.runner !== "codex")
    throw new Error(tx("Claude kabuk sunmaz; Codex ile gerçek yalıtım sondası ayrıca çalıştırılmalı."));
  const config = loadConfig();
  if (config.workDir !== input.workDir)
    throw new Error(tx("Betik ile çalışan servisin çalışma yolu aynı olmalı."));
  const lease = {
    run: { id: randomUUID() }, agent: input.agent,
    policy: { ...defaultPolicy, permission: "workspace" },
    links: [], key: "yalniz-yerel-sonda-icin", prompt: "",
  } as unknown as Lease;
  const p = prepare(lease, config);
  try {
    verifyShell(p.command, config, lease, p.profile);
    const paths = [join(input.home, ".ssh"), join(input.home, ".codex", "auth.json"),
      ...config.protectedRoots,
      join(input.repo, "docker-compose.yml"), join(config.workDir, "ofis", input.other.id), join(config.workDir, ".auth")];
    if (paths.some((path) => !existsSync(path)))
      throw new Error(tx("Yalıtım sondasının bir kaynak yolu ana makinede yok; olmayan bir dosyanın gizlendiği kanıtlanamaz. Eksik kaynakları kontrol edin."));
    // Only existence and socket permissions are inspected; no service is contacted.
    const script = `import os,socket,errno\npaths=${JSON.stringify(paths)}\nassert all(not os.path.exists(p) and not os.access(p,os.R_OK) for p in paths), "Korunan alan görünüyor"\ntry:\n open("/etc/ofis-yazma-sondasi-${randomUUID()}","x").close()\n raise SystemExit("Kutu dışına yazılabiliyor")\nexcept OSError as e:\n assert e.errno in (errno.EACCES,errno.EPERM,errno.EROFS), "Yazma reddi doğrulanamadı"\nfor family in [socket.AF_INET,socket.AF_INET6]:\n try:\n  socket.socket(family,socket.SOCK_STREAM)\n  raise SystemExit("Ağ soketi açılabiliyor")\n except OSError as e:\n  assert e.errno in (errno.EPERM,errno.EACCES)\nprint("OFIS_ISOLATION_OK")`;
    const settings = codexSettings(p.command);
    const command = isolate({ ...p.command, args: ["sandbox", ...settings, "-P", "ofis",
      "-C", p.work, "--", "/usr/bin/python3", "-c", script] }, config, lease, p.profile);
    const result = spawnSync(command.bin, command.args, { cwd: command.cwd, env: command.env,
      encoding: "utf8", timeout: 20000, maxBuffer: 20000 });
    if (result.status !== 0 || result.stdout.trim() !== "OFIS_ISOLATION_OK")
      throw new Error(tx("Gerçek dosya/ağ yalıtımı sondası başarısız; kabuk erişimini kullanmayın. Model çıktısı bu sonucu kanıtlamaz."));
    // Ensure the canary really exists on the host; a missing source isn't evidence of hiding it.
    if (!existsSync(join(input.repo, "docker-compose.yml"))) throw new Error(tx("Depo sondası için kaynak dosya yok."));
  } finally { rmSync(p.profile, { recursive: true, force: true }); }
}

// Probe approved writes using the agent command builder and real mounts, without a model call.
export function approvedWriteSmoke(input:{agent:Agent;workDir:string;folder:FolderLink},config:RunnerConfig=loadConfig()) {
  if(config.workDir!==input.workDir || input.folder.access!=='write' || !input.folder.approved_write || !input.folder.agent_ids.includes(input.agent.id))throw new Error(tx("Yazma sondası bağlantısı geçersiz."));
  const lease={run:{id:randomUUID()},agent:input.agent,policy:{...defaultPolicy,...input.agent.policy,permission:'folders'},links:[input.folder],key:'yalniz-yerel-sonda-icin',prompt:''} as unknown as Lease;
  const p=prepare(lease,config),target=join(input.folder.path,'ofis-red-sondasi-'+randomUUID());
  const script=`import errno\ntry:\n open(${JSON.stringify(target)},"x").close()\n raise SystemExit("Onaysız yazma mümkün")\nexcept OSError as e:\n assert e.errno in (errno.EPERM,errno.EACCES,errno.EROFS), "İşletim sistemi yazma reddi doğrulanamadı"\nprint("OFIS_WRITE_DENIED")`;
  try {
    let args=['/usr/bin/python3','-c',script],bin='/usr/bin/python3';
    if(input.agent.runner==='codex') {
      const settings=codexSettings(p.command);
      bin=p.command.bin;args=['sandbox',...settings,'-P','ofis','-C',p.work,'--',...args];
    } else args=['-c',script];
    const command=isolate({...p.command,bin,args},config,lease,p.profile);
    const result=spawnSync(command.bin,command.args,{cwd:command.cwd,env:command.env,encoding:'utf8',timeout:20000,maxBuffer:20000});
    if(result.status!==0 || result.stdout.trim()!=='OFIS_WRITE_DENIED' || existsSync(target))throw new Error(tx("Onaysız yazmanın işletim sistemi tarafından reddedildiği kanıtlanamadı."));
  } finally {rmSync(target,{force:true});rmSync(p.profile,{recursive:true,force:true});}
}
