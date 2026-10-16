import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { filteredEnv, loadConfig, repositoryRoot, type RunnerConfig } from "../src/config.js";
import {
  validateFolder,
  documentPaths,
  readSafe,
  proposal,
  applyApproval,
  sha,
} from "../src/files.js";
import { prepare, isolate, verifyShell } from "../src/command.js";
import { parseEvent } from "../src/events.js";
import type { Lease, Approval } from "../../office/shared/runtime.js";
import { defaultPolicy } from "../../office/shared/runtime.js";
const root = resolve(".test-data");
mkdirSync(root, { recursive: true });
export function config(dir: string): RunnerConfig {
  return {
    url: "http://127.0.0.1:9400",
    key: "test-key-".repeat(8),
    workDir: join(dir, "work"),
    allowedRoots: [join(dir, "allowed")],
    protectedRoots: [],
    concurrency: 2,
    claude: "claude",
    codex: "codex",
    bwrap: "bwrap",
    codexModel: "gpt-6.1-sol",
  };
}
test("Release copies find the repository root without internal documents and reject incomplete layouts", () => {
  const dir = mkdtempSync(join(root, "package-"));
  try {
    const source = join(dir, "runner", "dist", "runner", "src");
    mkdirSync(source, { recursive: true });
    mkdirSync(join(dir, "office"));
    writeFileSync(join(dir, "docker-compose.yml"), "services: {}\n");
    writeFileSync(join(dir, "office", "package.json"), "{}");
    assert.notEqual(repositoryRoot(source), dir);
    assert.throws(() => repositoryRoot("/"), /Depo kökü bulunamadı/);
    writeFileSync(join(dir, "runner", "package.json"), "{}");
    assert.equal(repositoryRoot(source), dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("Additional protected roots load from environment and resist ancestor, descendant and link bypasses", () => {
  const dir = mkdtempSync(join(root, "protected-"));
  try {
    const protectedPath = join(dir, "allowed", "korunan"), second = join(dir, "diger");
    mkdirSync(join(protectedPath, "alt"), { recursive: true });
    mkdirSync(second);
    const loaded = loadConfig({ OFIS_RUNNER_KEY: "test-key-".repeat(8), OFIS_PROTECTED_ROOTS: `${protectedPath}:${second}` });
    assert.deepEqual(loaded.protectedRoots.slice(-2), [protectedPath, second]);
    const c = { ...config(dir), protectedRoots: loaded.protectedRoots.slice(-2) };
    for (const path of [protectedPath, join(protectedPath, "alt"), c.allowedRoots[0]]) {
      assert.throws(() => validateFolder(path, c), /korunan/);
    }
    symlinkSync(protectedPath, join(c.allowedRoots[0], "baglanti"));
    assert.throws(() => validateFolder(join(c.allowedRoots[0], "baglanti"), c), /korunan/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("Fixed address, filtered environment and system/private-setting/root boundaries", () => {
  const dir = mkdtempSync(join(root, "security-")),
    c = config(dir);
  try {
    const allowed = join(dir, "allowed");
    mkdirSync(allowed);
    assert.equal(validateFolder(allowed, c), allowed);
    for (const bad of [
      "/",
      "/etc",
      "/usr",
      resolve(".."),
      join(allowed, ".ssh"),
    ]) {
      if (bad.startsWith(allowed)) mkdirSync(bad);
      assert.throws(() => validateFolder(bad, c));
    }
    symlinkSync("/etc", join(allowed, "escape"));
    assert.throws(() => validateFolder(join(allowed, "escape"), c));
    assert.throws(() =>
      loadConfig({ OFIS_URL: "http://127.0.0.1:9292", OFIS_RUNNER_KEY: c.key }),
    );
    const env = filteredEnv(join(dir, "profile"), {
      PATH: "/usr/bin",
      OFIS_RUNNER_KEY: c.key,
      TUDUDI_ADMIN_PASSWORD: "secret",
      ANTHROPIC_API_KEY: "secret",
      NODE_OPTIONS: "--bad",
      OPENAI_API_KEY: "secret",
    });
    assert.equal(env.OFIS_RUNNER_KEY, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.ok(!JSON.stringify(env).includes("secret"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("Approved copies freeze content and reject destination conflicts/symlinks", () => {
  const dir = mkdtempSync(join(root, "copy-")),
    c = config(dir);
  try {
    mkdirSync(c.workDir);
    mkdirSync(c.allowedRoots[0]);
    writeFileSync(join(c.workDir, "a.txt"), "Yeni");
    writeFileSync(join(c.allowedRoots[0], "a.txt"), "Eski");
    const link = {
      id: randomUUID(),
      name: "Dosyalar",
      path: c.allowedRoots[0],
      access: "write" as const,
      approved_write: true,
      agent_ids: ["agent"],
      validation: "valid" as const,
      detail: "",
    };
    const files = proposal(c.workDir, link, ["a.txt"]);
    writeFileSync(join(c.workDir, "a.txt"), "Sonradan değişti");
    const approval: Approval = {
      id: randomUUID(),
      agent_id: "agent",
      run_id: randomUUID(),
      title: "Yaz",
      detail: "",
      type: "dosya",
      state: "applying",
      note: "",
      created_at: "",
      decided_at: null,
      link_id: link.id,
      files,
    };
    assert.ok(applyApproval(approval, link, c).includes("1 dosya"));
    assert.equal(readFileSync(join(link.path, "a.txt"), "utf8"), "Yeni");
    assert.throws(() => applyApproval(approval, link, c));
    symlinkSync(join(link.path, "a.txt"), join(c.workDir, "escape"));
    assert.throws(() => readSafe(c.workDir, "escape"));
    assert.throws(() => readSafe(c.workDir, "../allowed/a.txt"));
    assert.throws(() => readSafe(c.workDir, ".env"));
    const altered = {
      ...approval,
      files: [{ ...files[0], after_hash: sha(Buffer.from("Different")) }],
    };
    assert.throws(() => applyApproval(altered, link, c));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("Commands exclude personal settings; chat disables command tools; add-dir cannot make approved links writable", () => {
  const dir = mkdtempSync(join(root, "flags-")),
    c = config(dir);
  try {
    mkdirSync(c.allowedRoots[0]);
    const l = {
      run: { id: randomUUID() },
      agent: {
        id: randomUUID(),
        runner: "codex",
        model: "test",
        effort: "low",
      },
      policy: { ...defaultPolicy, permission: "chat" },
      links: [],
      key: "short-test-key",
      prompt: "Türkçe talimat",
    } as unknown as Lease;
    const codex = prepare(l, c).command;
    assert.ok(codex.args.includes("-p"));
    assert.equal(readFileSync(join(codex.env.CODEX_HOME!, "config.toml"), "utf8"), "");
    assert.ok(codex.args.includes("--ignore-rules"));
    assert.ok(codex.args.includes("features.shell_tool=false"));
    // codex exec rejects this flag (verified in a real run); select the profile via default_permissions.
    assert.ok(!codex.args.includes("--permission-profile"));
    assert.ok(codex.args.includes('default_permissions="ofis"'));
    const codexConfig = readFileSync(join(codex.env.CODEX_HOME!, "ofis-runtime.config.toml"), "utf8");
    assert.ok(codexConfig.includes('permissions=') && codexConfig.includes('network={enabled=false}') && codexConfig.includes('="deny"'));
    assert.ok(!codex.args.some((arg) => arg.startsWith("tools.view_image=")));
    assert.ok(codexConfig.includes('mcp_servers.ofis.default_tools_approval_mode="approve"'));
    assert.ok(codex.args.includes("suppress_unstable_features_warning=true"));
    assert.ok(!codex.args.includes("-s"));
    const shellEnv = codex.args.find((arg) => arg.startsWith("shell_environment_policy.set="))!;
    assert.ok(shellEnv.includes('PATH="/usr/bin:/bin"'));
    assert.ok(shellEnv.includes('LANG="C.UTF-8"'));
    l.policy.permission = "workspace";
    const workspace = prepare(l, c).command;
    assert.ok(workspace.args.includes("features.shell_tool=true"));
    const workspaceConfig = readFileSync(join(workspace.env.CODEX_HOME!, "ofis-runtime.config.toml"), "utf8");
    assert.ok(workspaceConfig.includes('permissions=') && workspaceConfig.includes('="write"') && workspaceConfig.includes('/gelen"="read"'));
    l.policy.permission = "chat";
    assert.ok(codex.args.includes('approval_policy="never"'));
    assert.equal(codex.env.OFIS_RUNNER_KEY, undefined);
    l.agent.runner = "claude";
    const claude = prepare(l, c).command;
    assert.ok(claude.args[1] && !claude.args[1].startsWith("-"));
    assert.ok(claude.args.includes("--restricted"));
    assert.ok(claude.args.includes("--strict-mcp-config"));
    assert.ok(claude.args.includes("--no-session-persistence"));
    assert.ok(!claude.args.includes("--bare"));
    assert.equal(claude.args[claude.args.indexOf("--tools") + 1], "");
    l.policy.commands = true;
    assert.throws(() => prepare(l, c));
    assert.deepEqual(
      parseEvent("codex", {
        type: "turn.completed",
        usage: { input_tokens: 1 },
      })[0].usage,
      { input_tokens: 1 },
    );
    assert.throws(() =>
      parseEvent("claude", { type: "result", is_error: true }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Isolation refusal prevents command launch; usage accepts only numeric fields", () => {
  const dir = mkdtempSync(join(root, "isolation-")),
    c = config(dir);
  try {
    const l = {
      run: { id: randomUUID() },
      agent: {
        id: randomUUID(),
        runner: "codex",
        model: "test",
        effort: "low",
      },
      policy: defaultPolicy,
      links: [],
      key: "short-test-key",
      prompt: "Türkçe talimat",
    } as unknown as Lease;
    const p = prepare(l, c);
    c.bwrap = "/usr/bin/false";
    p.command.bin = "/usr/bin/true";
    assert.throws(() => isolate(p.command, c, l, p.profile), /izolasyonu/);
    c.bwrap = "/usr/bin/true";
    const wrapped = isolate(p.command, c, l, p.profile);
    assert.ok(wrapped.args.includes(resolve("dist") + "/"));
    assert.ok(!wrapped.args.includes(resolve(".")));
    assert.ok(!wrapped.args.includes(resolve("..")));
    // A successful wrapper exit is not network evidence: missing probe output fails closed.
    assert.throws(() => verifyShell(p.command, c, l, p.profile), /ağ yalıtımı doğrulanamadı/);
    l.policy = { ...defaultPolicy, network: true };
    assert.throws(() => prepare(l, c), /Ağ erişimi/);
    assert.deepEqual(
      parseEvent("claude", {
        type: "result",
        result: "Bitti",
        usage: {
          input_tokens: 1,
          server_tool_use: { requests: 1 },
          service_tier: "standard",
        },
      })[0].usage,
      { input_tokens: 1 },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Credential refresh persists without settings; stale concurrent copies cannot overwrite newer credentials", async () => {
  const { cleanAuth, retainAuth, authCache } = await import("../src/auth.js");
  const { profileSecrets } = await import("../src/secrets.js");
  const dir = mkdtempSync(join(root, "auth-")),
    c = config(dir);
  try {
    const profile = join(dir, "profile");
    mkdirSync(join(profile, "codex"), { recursive: true });
    const initial = JSON.stringify({ OPENAI_API_KEY: "sahte-ilk-anahtar" });
    writeFileSync(
      join(profile, "codex", "auth.json"),
      JSON.stringify({
        OPENAI_API_KEY: "sahte-yeni-anahtar",
        hooks: { command: "yüklenmemeli" },
      }),
    );
    retainAuth(c.workDir, "codex", profile, initial);
    assert.deepEqual(
      JSON.parse(readFileSync(authCache(c.workDir, "codex"), "utf8")),
      { OPENAI_API_KEY: "sahte-yeni-anahtar" },
    );
    writeFileSync(join(profile, "codex", "auth.json"), initial);
    retainAuth(c.workDir, "codex", profile, initial);
    assert.equal(
      JSON.parse(readFileSync(authCache(c.workDir, "codex"), "utf8"))
        .OPENAI_API_KEY,
      "sahte-yeni-anahtar",
    );
    assert.ok(profileSecrets(profile).includes("sahte-ilk-anahtar"));
    assert.deepEqual(
      cleanAuth("claude", {
        claudeAiOauth: { accessToken: "sahte" },
        hooks: "yüklenmemeli",
      }),
      { claudeAiOauth: { accessToken: "sahte" } },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A2.3: streamed usage sums turns/cache and deduplicates Claude messages", async () => {
  const { UsageObserver } = await import('../src/events.js');
  const c = new UsageObserver();
  assert.deepEqual(c.observe('codex', { type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 10, output_tokens: 3 } }), { input_tokens: 12, cached_input_tokens: 10, output_tokens: 3 });
  assert.equal(c.observe('codex', { type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 5 } })!.input_tokens, 32);
  const a = new UsageObserver();
  a.observe('claude', { type: 'stream_event', event: { type: 'message_start', message: { id: 'a', usage: { input_tokens: 20, cache_read_input_tokens: 10 } } } });
  a.observe('claude', { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 5 } } });
  const duplicate = a.observe('claude', { type: 'assistant', message: { id: 'a', usage: { input_tokens: 20, cache_read_input_tokens: 10, output_tokens: 5 } } })!;
  assert.equal(duplicate.input_tokens, 20); assert.equal(duplicate.output_tokens, 5);
  const b = a.observe('claude', { type: 'assistant', message: { id: 'b', usage: { input_tokens: 30, output_tokens: 7 } } })!;
  assert.equal(b.input_tokens, 50); assert.equal(b.output_tokens, 12);
  assert.equal(a.observe('claude', { type: 'result', usage: b })!.input_tokens, 50);
});

test("A2.3: incoming file summaries, immutable bytes and symlink rejection", async () => {
  const { receiveFile, sha } = await import('../src/files.js');
  const { statSync } = await import('node:fs');
  const dir = mkdtempSync(join(root, "incoming-"));
  try {
    const bytes = Buffer.from('Sabit taslak');
    const file = { transfer_id: 'test', index: 0, path: 'gelen/Deniz-test/taslak.md', size: bytes.length, hash: sha(bytes) };
    receiveFile(dir, file, bytes.toString('base64'));
    assert.equal(readFileSync(join(dir, file.path), 'utf8'), 'Sabit taslak');
    assert.equal(statSync(join(dir, file.path)).mode & 0o777, 0o400);
    assert.throws(() => receiveFile(dir, file, Buffer.from('Değişti').toString('base64')), /özeti/);
    const { unlinkSync, symlinkSync } = await import('node:fs');
    unlinkSync(join(dir, file.path)); symlinkSync(join(dir, 'target'), join(dir, file.path));
    assert.throws(() => receiveFile(dir, file, bytes.toString('base64')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A3: provider resume flags, per-agent 0700 profiles and read-only directory maps",async()=>{
  const {statSync,readdirSync}=await import('node:fs');
  const {directoryMaps}=await import('../src/workspace.js');
  const dir=mkdtempSync(join(root,'persistent-')),c=config(dir);
  try {
    mkdirSync(c.allowedRoots[0]);writeFileSync(join(c.allowedRoots[0],'karar.ts'),'içerik okunmaz');
    const l={run:{id:randomUUID()},agent:{id:randomUUID(),runner:'codex',model:'test',effort:'low'},policy:defaultPolicy,links:[],key:'test-lease-key',prompt:'Yalnız yeni olay',session:{agent_id:'',generation:1,provider_id:randomUUID()}} as unknown as Lease;
    const one=prepare(l,c);assert.equal(statSync(one.profile).mode & 0o777,0o700);
    assert.ok(one.profile.includes(join('.oturum',l.agent.id,'1')));
    const args=one.command.args;assert.ok(args.includes('resume'));assert.ok(!args.includes('--ephemeral'));
    assert.ok(args.indexOf('-C')<args.indexOf('resume'));assert.ok(args.indexOf('-p')<args.indexOf('resume'));assert.equal(args.at(-2),l.session!.provider_id);assert.equal(args.at(-1),'-');assert.equal(one.command.stdin,l.prompt);
    writeFileSync(join(one.profile,'gecmis'),'kalıcı');l.run.id=randomUUID();const two=prepare(l,c);assert.equal(two.profile,one.profile);assert.equal(readFileSync(join(two.profile,'gecmis'),'utf8'),'kalıcı');
    c.bwrap='/usr/bin/true';const wrapped=isolate(two.command,c,l,two.profile);
    assert.ok(wrapped.args.includes(two.profile));assert.ok(!wrapped.args.includes(join(c.workDir,'.oturum')));
    l.agent.runner='claude';const claude=prepare(l,c);assert.ok(claude.command.args.includes('--resume'));assert.ok(!claude.command.args.includes('--no-session-persistence'));
    const link={id:randomUUID(),name:'Kaynak',path:c.allowedRoots[0],access:'read',agent_ids:[l.agent.id],approved_write:false,validation:'valid',detail:''} as const;
    l.links=[{...link,path:'/yok/korunan',agent_ids:[l.agent.id]}];
    for(const permission of ['chat','workspace'] as const){l.policy={...defaultPolicy,permission};directoryMaps(l,two.work);assert.deepEqual(readdirSync(join(two.work,'dizin-haritasi')),[]);}
    l.policy={...defaultPolicy,permission:'folders'};l.links=[{...link,agent_ids:[l.agent.id]}];directoryMaps(l,two.work);
    const map=join(two.work,'dizin-haritasi',link.id+'.txt');assert.ok(readFileSync(map,'utf8').includes('karar.ts'));assert.ok(!readFileSync(map,'utf8').includes('içerik okunmaz'));assert.equal(statSync(map).mode&0o777,0o400);
    l.agent.id=randomUUID();l.agent.runner='codex';assert.notEqual(prepare(l,c).profile,two.profile);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("A3: fixed command box is offline with read-only Node/dependencies; path/write escapes fail",async()=>{
  const {commandBox}=await import('../src/command-box.js');const {quota}=await import('../src/quota.js');
  const dir=mkdtempSync(join(root,'command-box-')),c=config(dir);
  try {
    mkdirSync(c.allowedRoots[0]);mkdirSync(join(c.allowedRoots[0],'node_modules'));
    const job={folder:{path:c.allowedRoots[0],access:'read',approved_write:false},command:{directory:'.',write:false,command:'npm test',timeout_seconds:1}} as unknown as import('../../office/shared/runtime.js').CommandJob;
    const cmd=commandBox(job,c);assert.ok(cmd.args.includes('--unshare-all'));assert.ok(!cmd.args.includes('--share-net'));assert.equal(cmd.env.npm_config_offline,'true');assert.equal(cmd.args.at(-1),'npm test');assert.equal('OFIS_RUNNER_KEY' in cmd.env,false);
    const at=cmd.args.indexOf(c.allowedRoots[0]);assert.equal(cmd.args[at-1],'--ro-bind');
    job.command.write=true;assert.throws(()=>commandBox(job,c));job.command.write=false;job.command.directory='../';assert.throws(()=>commandBox(job,c));
    assert.equal(quota('sıradan bir iş mesajı'),undefined);assert.ok(quota('usage limit reached retry after 60 seconds')!.until!>Date.now());
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("A3: smoke refuses unflagged live Office access and personal ports",async()=>{
  // @ts-expect-error No separate declaration is generated for the JavaScript driver.
  const {main}=await import('../scripts/smoke-real.mjs');
  await assert.rejects(()=>main(['--ofis-url','http://127.0.0.1:9400','--work-dir',resolve('work-test')]),/--canli/);
  await assert.rejects(()=>main(['--ofis-url','http://127.0.0.1:9292','--work-dir',resolve('work-test')]),/9400\/9401/);
  await assert.rejects(()=>main(['--work-dir','/etc']),/separate absolute/);
});

test("A3: test exception exposes only the 9401 data root, never repository code",()=>{
  const dir=mkdtempSync(join(root,'smoke-root-')),base=resolve('..'),allowed=join(dir,'kod');mkdirSync(allowed);
  const c={...config(dir),url:'http://127.0.0.1:9401',smoke:true,smokeRoot:allowed,allowedRoots:[allowed],protectedRoots:[base]};
  try{assert.equal(validateFolder(allowed,c),allowed);assert.throws(()=>validateFolder(base,c));c.url='http://127.0.0.1:9400';assert.throws(()=>validateFolder(allowed,c));}
  finally{rmSync(dir,{recursive:true,force:true});}
});

test("A3: command stop signal kills the separate fake box process",async()=>{
 const {runCommand}=await import('../src/command-box.js');const dir=mkdtempSync(join(root,'command-stop-')),c=config(dir);mkdirSync(c.allowedRoots[0]);
 try{c.bwrap=join(dir,'fake-bwrap.sh');writeFileSync(c.bwrap,'#!/bin/sh\nsleep 30\n',{mode:0o700});const controller=new AbortController();
   const job={folder:{path:c.allowedRoots[0],access:'read',approved_write:false},command:{directory:'.',write:false,command:'test',timeout_seconds:30}} as unknown as import('../../office/shared/runtime.js').CommandJob;
   const started=Date.now(),pending=runCommand(job,c,[],controller.signal);setTimeout(()=>controller.abort(),50);const result=await pending;assert.equal(result.exit_code,null);assert.match(result.output,/durdurdu/);assert.ok(Date.now()-started<3000);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("B2.3: document names validate only under allowed roots; no contents, hidden files or external links",()=>{
 mkdirSync(resolve('.test-data'),{recursive:true});const root=mkdtempSync(resolve('.test-data/b23-docs-'));try{
 const linked=join(root,'kod'),outside=join(root,'disari'),protectedDir=join(root,'korunan');mkdirSync(join(linked,'docs'),{recursive:true});mkdirSync(outside);mkdirSync(protectedDir);writeFileSync(join(linked,'docs','is.md'),'Yalnız belge içeriği');writeFileSync(join(linked,'.env'),'test-secret-only');writeFileSync(join(outside,'yok.md'),'Dışarıdaki belge');
 const runnerConfig={...config(root),allowedRoots:[linked],protectedRoots:[protectedDir]};assert.throws(()=>documentPaths(linked,runnerConfig),/gizli/);rmSync(join(linked,'.env'));
 symlinkSync(outside,join(linked,'disari'));assert.throws(()=>documentPaths(linked,runnerConfig),/dışına/);rmSync(join(linked,'disari'));symlinkSync(join(linked,'docs','is.md'),join(linked,'docs','bag.md'));
 const result=documentPaths(linked,runnerConfig);assert.deepEqual(result,{documents:['docs/is.md'],documents_truncated:false});assert.ok(!JSON.stringify(result).includes('belge içeriği'));assert.throws(()=>documentPaths(outside,runnerConfig));assert.throws(()=>documentPaths(protectedDir,runnerConfig));
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("B2.3.2: catalogs truncated at 1000 files leave later existing documents unknown",()=>{
 mkdirSync(resolve('.test-data'),{recursive:true});const root=mkdtempSync(resolve('.test-data/b232-docs-'));try{
 const linked=join(root,'kod');mkdirSync(linked);
 for(let i=0;i<1001;i++)writeFileSync(join(linked,`dosya-${String(i).padStart(4,'0')}.md`),'Yalnız test');
 const result=documentPaths(linked,{...config(root),allowedRoots:[linked]});
 assert.equal(result.documents.length,1000);assert.equal(result.documents_truncated,true);assert.ok(!result.documents.includes('dosya-1000.md'));
 assert.ok(existsSync(join(linked,'dosya-1000.md')));
 }finally{rmSync(root,{recursive:true,force:true});}
});
