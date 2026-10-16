import { test } from "node:test";
import { withLanguage } from "../src/i18n.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { prepare, isolate, codexSettings } from "../src/command.js";
import { documentPaths } from "../src/files.js";
import { directoryMaps } from "../src/workspace.js";
import { assertLaunchSize, guardLaunch, launchSize, LaunchSizeError, MAX_LAUNCH_STRING_BYTES, MAX_LAUNCH_TOTAL_BYTES } from "../src/launch-size.js";
import { defaultPolicy, type Lease, type FolderLink } from "../../office/shared/runtime.js";
import { promptFolders } from "../../office/shared/folder-prompt.js";
import type { RunnerConfig } from "../src/config.js";
import { interactiveCommand } from "../src/terminal-loop.js";
import { writeTerminalPolicy } from "../src/terminal-policy.js";
import { withoutPermissionDefinition } from "../src/terminal.js";

const root = resolve(".test-data"); mkdirSync(root, { recursive: true });
function fixture() {
  const dir = mkdtempSync(join(root, "e2big-"));
  const config: RunnerConfig = { url: "http://127.0.0.1:9401", key: "sahte-deneme-anahtari", workDir: join(dir, "work"), allowedRoots: [join(dir, "folders")], protectedRoots: [], concurrency: 2, codex: "codex", claude: "claude", bwrap: "/usr/bin/true", codexModel: "test" };
  mkdirSync(config.allowedRoots[0]);
  const lease = { run: { id: randomUUID(), summary: "Kısa iş" }, agent: { id: randomUUID(), runner: "codex", model: "test", effort: "low" }, policy: { ...defaultPolicy, permission: "folders" }, links: [], key: "sahte-is-anahtari", prompt: "Türkçe görev", session: { generation: 1, provider_id: null } } as unknown as Lease;
  return { dir, config, lease };
}

test("E2BIG: 5000 real files, two folders/commands and long instructions stay bounded via stdin/settings files", t => {
  const { dir, config, lease } = fixture();
  try {
    for (const [name, access] of [["kod", "write"], ["kaynak", "read"]] as const) {
      const path = join(config.allowedRoots[0], name); mkdirSync(path);
      if (name === "kod") for (let d = 0; d < 50; d++) {
        const sub = join(path, `bolum-${String(d).padStart(2, "0")}-${"uzun-klasor-".repeat(5)}`); mkdirSync(sub);
        for (let f = 0; f < 100; f++) writeFileSync(join(sub, `${String(f).padStart(3, "0")}-${"Türkçe-belge-".repeat(5)}.ts`), "Dosya içeriği okunmamalı.");
      } else writeFileSync(join(path, "rehber.md"), "Kaynak");
      lease.links.push({ id: randomUUID(), name, path, access, approved_write: false, validation: "valid", agent_ids: [lease.agent.id], detail: "", ...documentPaths(path, config) } satisfies FolderLink);
    }
    assert.equal(lease.links[0].documents!.length, 1000);
    assert.equal(lease.links[0].documents_truncated, true);
    lease.commands = ["Testler", "Ekran görüntüsü"].map(name => ({ id: randomUUID(), name, folder_id: lease.links[0].id, directory: ".", command: "npm test", timeout_seconds: 30, write: false, approval: false, agent_ids: [lease.agent.id] }));
    const longRules = "Uzun şirket talimatı, kuralları ve onay sınırlarını koru.\n".repeat(6000);
    const oldPrompt = `${longRules}\nKlasörler: ${JSON.stringify(lease.links)}`;
    const oldMcp = `mcp_servers.ofis.env.OFIS_AGENT_LINKS=${JSON.stringify(JSON.stringify(lease.links))}`;
    assert.ok(Buffer.byteLength(oldMcp) > 131072);
    const old = withLanguage("en", () => launchSize({ bin: config.codex, args: [oldPrompt, "-c", oldMcp], env: {} }));
    if (process.platform === "linux") assert.equal((spawnSync("/usr/bin/true", [oldMcp], { env: {} }).error as NodeJS.ErrnoException | undefined)?.code, "E2BIG");
    lease.prompt = `${longRules}\nKlasörler: ${JSON.stringify(promptFolders(lease.links))}`;
    for (const resume of [false, true]) {
      lease.session!.provider_id = resume ? randomUUID() : null;
      const prepared = prepare(lease, config);
      directoryMaps(lease, prepared.work);
      assert.equal(prepared.command.stdin, lease.prompt);
      assert.equal(prepared.command.args.at(-1), "-");
      assert.ok(!prepared.command.args.includes(lease.prompt));
      if (resume) assert.ok(prepared.command.args.indexOf("-p") < prepared.command.args.indexOf("resume"));
      const size = withLanguage("en", () => assertLaunchSize(prepared.command));
      const boxed = isolate(prepared.command, config, lease, prepared.profile);
      assertLaunchSize(boxed);
      assert.ok(size.largest.bytes < 4096);
      assert.ok(size.totalBytes < 16384);
      const path = join(prepared.command.env.CODEX_HOME!, "ofis-runtime.config.toml");
      assert.equal(statSync(path).mode & 0o777, 0o600);
      const parsed = spawnSync("/usr/bin/python3", ["-c", "import json,tomllib,sys; print(json.dumps(tomllib.loads(sys.stdin.read())))"], { input: readFileSync(path), encoding: "utf8" });
      assert.equal(parsed.status, 0, parsed.stderr);
      const settings = JSON.parse(parsed.stdout);
      assert.equal(settings.permissions.ofis.filesystem[lease.links[0].path], "write");
      assert.equal(settings.permissions.ofis.filesystem[lease.links[1].path], "read");
      assert.ok(Object.keys(settings.permissions.ofis.filesystem).length < 12);
      assert.ok(!readFileSync(path, "utf8").includes(lease.links[0].documents![0]));
      const mcp = JSON.parse(readFileSync(join(prepared.profile, "mcp.json"), "utf8")).mcpServers.ofis;
      assert.equal(mcp.env.OFIS_AGENT_LINKS, undefined);
      const links = JSON.parse(readFileSync(mcp.env.OFIS_AGENT_LINKS_FILE, "utf8"));
      assert.equal(links.length, 2); assert.equal(links[0].documents, undefined);
      assert.equal(links[0].approved_write, false); assert.equal(links[0].path, lease.links[0].path);
      assertLaunchSize({ bin: mcp.command, args: mcp.args, env: mcp.env });
      assert.ok(codexSettings(prepared.command).includes("ofis-runtime"));
      // Cross the real process boundary and verify complete stdin and UTF-8 contents.
      const hash = createHash("sha256").update(lease.prompt).digest("hex");
      const delivered = spawnSync(process.execPath, ["-e", "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>s+=v);process.stdin.on('end',()=>console.log(require('node:crypto').createHash('sha256').update(s).digest('hex')))", "--", ...prepared.command.args], { env: prepared.command.env, input: prepared.command.stdin, encoding: "utf8" });
      assert.equal(delivered.status, 0, delivered.stderr); assert.equal(delivered.stdout.trim(), hash);
      t.diagnostic(JSON.stringify({ resumed: resume, old, current: size, isolated: withLanguage("en", () => launchSize(boxed)), stdinBytes: Buffer.byteLength(lease.prompt), configBytes: statSync(path).size }));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("E2BIG guard: UTF-8, NUL, environment and total sizes; compact/recheck once without exposing content/secrets", () => {
  const command = { bin: "/usr/bin/true", args: ["ş"], env: { A: "ü", EMPTY: undefined } };
  const measured = launchSize(command);
  assert.equal(measured.argumentBytes, Buffer.byteLength(command.bin) + 1 + 3);
  assert.equal(measured.environmentBytes, 5);
  const secret = "gizli-deger-".repeat(12000);
  const huge = { ...command, args: ["-c", `developer_instructions=${JSON.stringify(secret)}`] };
  assert.throws(() => assertLaunchSize(huge), error => error instanceof LaunchSizeError && error.message.includes("Ajan başlatma verisi çok büyük: ayar (developer_instructions)") && !error.message.includes("gizli-deger"));
  assert.throws(() => guardLaunch({ ...command, env: { PATH: secret } }), /ortam değişkeni \(PATH\)/);
  let attempts = 0;
  const retried = guardLaunch(huge, original => { attempts++; return { ...original, args: ["-"] }; });
  assert.equal(attempts, 1); assert.equal(retried.launchWarnings?.length, 1); assertLaunchSize(retried);
  assert.throws(() => guardLaunch(huge, original => original), LaunchSizeError);
  const total = { ...command, args: Array.from({ length: 100 }, () => "x".repeat(20000)) };
  assert.ok(launchSize(total).largest.bytes < MAX_LAUNCH_STRING_BYTES);
  assert.ok(launchSize(total).totalBytes > MAX_LAUNCH_TOTAL_BYTES);
  assert.throws(() => assertLaunchSize(total), /toplam argüman ve ortam/);
});

test("E2BIG: oversized PATH safely deduplicates; actual command and MCP environments are remeasured", () => {
  const { dir, config, lease } = fixture(), previousPath = process.env.PATH;
  try {
    process.env.PATH = "/usr/bin:/bin:".repeat(12000);
    const prepared = prepare(lease, config);
    assert.equal(prepared.command.env.PATH, "/usr/bin:/bin:");
    assert.ok(prepared.command.launchWarnings?.some(message => message.includes("Ajan başlatma verisi çok büyük: ortam değişkeni (PATH)")));
    assertLaunchSize(prepared.command);
    const mcp = JSON.parse(readFileSync(join(prepared.profile, "mcp.json"), "utf8")).mcpServers.ofis;
    assertLaunchSize({ bin: mcp.command, args: mcp.args, env: mcp.env });
  } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; rmSync(dir, { recursive: true, force: true }); }
});

test("E2BIG: long terminal instructions use files; interactive input, resume and saved model choice persist", () => {
  const { dir, config, lease } = fixture();
  try {
    lease.agent.builtin = "director";
    lease.terminalInstructions = "Türkçe şirket kuralı ve onay sınırları.\n".repeat(6000);
    const first = prepare(lease, config, true);
    const userConfig = join(first.command.env.CODEX_HOME!, "config.toml");
    writeFileSync(userConfig, 'model="terminalde-secilen-model"\n');
    const prepared = prepare(lease, config, true);
    assert.equal(readFileSync(userConfig, "utf8"), 'model="terminalde-secilen-model"\n');
    assert.equal(prepared.command.stdin, undefined);
    assertLaunchSize(prepared.command);
    writeTerminalPolicy(prepared.command, prepared.profile);
    const runtime = readFileSync(join(prepared.command.env.CODEX_HOME!, "ofis-runtime.config.toml"), "utf8");
    assert.ok(runtime.includes(`developer_instructions=${JSON.stringify(lease.terminalInstructions)}`));
    assert.ok(!runtime.includes("permissions="));
    const fresh = interactiveCommand(withoutPermissionDefinition(prepared.command));
    assert.equal(fresh.args.at(-1), lease.prompt); assert.ok(fresh.args.includes("ofis-runtime"));
    assertLaunchSize(fresh);
    const id = randomUUID(), resumed = interactiveCommand(withoutPermissionDefinition(prepared.command), id);
    assert.equal(resumed.args[0], "resume"); assert.equal(resumed.args.at(-1), id); assert.equal(resumed.stdin, undefined);
    assertLaunchSize(resumed);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("E2BIG: local Codex exec/resume loads private settings and clears old base settings without model/network calls", t => {
  if ((spawnSync("codex", ["--version"], { encoding: "utf8" }).error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return t.skip("Codex kurulu değil.");
  const { dir, config, lease } = fixture();
  try {
    for (const resume of [false, true]) {
      lease.session!.provider_id = resume ? randomUUID() : null;
      const first = prepare(lease, config);
      writeFileSync(join(first.command.env.CODEX_HOME!, "config.toml"), "gecersiz TOML = [");
      const prepared = prepare(lease, config);
      assert.equal(readFileSync(join(prepared.command.env.CODEX_HOME!, "config.toml"), "utf8"), "");
      assert.ok(!prepared.command.args.includes("--ignore-user-config"));
      appendFileSync(join(prepared.command.env.CODEX_HOME!, "ofis-runtime.config.toml"), '\nmodel_provider="ofis_offline_missing_provider"\n');
      const result = spawnSync(prepared.command.bin, prepared.command.args, { env: prepared.command.env, cwd: prepared.work, input: prepared.command.stdin, encoding: "utf8", timeout: 5000, maxBuffer: 20000 });
      assert.ok(!result.error, result.error?.message);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /ofis_offline_missing_provider/);
      assert.ok(!/failed to parse|unknown field|unexpected argument/i.test(result.stderr), result.stderr);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
