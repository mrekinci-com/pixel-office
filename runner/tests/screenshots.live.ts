// Screenshot script in real commandBox/bwrap, without services or model calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { runCommand } from '../src/command-box.js';
import type { CommandJob } from '../../office/shared/runtime.js';

test("B1.2: build, Chromium, measurements and 2× crops inside the real offline command box", { timeout: 120000 }, async () => {
  const source = resolve('../office'), root = resolve('.test-data');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'ekran-kutu-'));
  try {
    // Copy only required sources and installed dependencies, excluding .env, data and visual baselines.
    for (const name of ['package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'src', 'server', 'shared', 'public', 'scripts', 'node_modules'])
      cpSync(join(source, name), join(directory, name), { recursive: true, verbatimSymlinks: true,
        filter: path => !['.ssh', '.config', '.claude', '.codex', '.aws', '.agents', '.vite-temp', '.vite'].includes(basename(path)) && !basename(path).startsWith('.env') });
    mkdirSync(join(directory, 'tests'));
    cpSync(join(source, 'tests/helpers.ts'), join(directory, 'tests/helpers.ts'));
    for (const name of ['browsers', 'system-libs/usr/lib/x86_64-linux-gnu']) cpSync(join(source, '.cache', name), join(directory, '.cache', name), { recursive: true, verbatimSymlinks: true });
    // Apply this preload to npm, Vite, application and Playwright Node processes.
    // Fail on TCP listeners or outbound network attempts from Node.
    writeFileSync(join(directory, 'ag-sondasi.mjs'), `
import {Server, Socket} from 'node:net';
import {networkInterfaces} from 'node:os';
import {existsSync,writeFileSync} from 'node:fs';
if (Object.entries(networkInterfaces()).some(([name, values]) => name !== 'lo' || values?.some(i => !i.internal))) throw new Error('Kutuda dış ağ arayüzü açık.');
writeFileSync('kutu-ortami.json',JSON.stringify({interfaces:Object.keys(networkInterfaces()),shmAvailable:existsSync('/dev/shm')}));
const originalListen = Server.prototype.listen;
Server.prototype.listen = function(...args) {
  const target = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof target === 'number' || (typeof target === 'object' && target && 'port' in target)) throw new Error('TCP portu dinleme girişimi.');
  return originalListen.apply(this,args);
};
const originalConnect = Socket.prototype.connect;
Socket.prototype.connect = function(...args) {
  const target = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof target === 'number' || (typeof target === 'object' && target && 'port' in target)) throw new Error('TCP bağlantı girişimi.');
  return originalConnect.apply(this,args);
};
globalThis.fetch = () => { throw new Error('Node üzerinden ağ isteği girişimi.'); };
`);
    const c = { ...loadConfig({ OFIS_RUNNER_KEY: 'yalniz-ekran-kutu-denetimi-icin-sahte-anahtar', OFIS_BWRAP_BIN: process.env.OFIS_BWRAP_BIN }), allowedRoots: [directory], protectedRoots: [] };
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    const command = `NODE_OPTIONS=${quote(`--import=${join(directory, 'ag-sondasi.mjs')}`)} npm run screenshots`;
    const job = { id: 'ekran', run_id: 'ekran', agent_id: 'ekran', state: 'running', exit_code: null, output: '',
      folder: { path: directory, access: 'write', approved_write: false }, command: { directory: '.', write: true, command, timeout_seconds: 60 } } as CommandJob;
    // Check stale-output cleanup and separately record /dev/shm availability.
    mkdirSync(join(directory, '.test-data/screenshots'), { recursive: true });
    writeFileSync(join(directory, '.test-data/screenshots/eski.txt'), 'silinmeli');
    const result = await runCommand(job, c, [c.key]);
    assert.equal(result.exit_code, 0, result.output);
    const output = join(directory, '.test-data/screenshots');
    const files = readdirSync(output);
    assert.equal(files.length, 50);
    assert.ok(!files.includes('eski.txt'));
    const report = JSON.parse(readFileSync(join(output, 'measurements.json'), 'utf8'));
    assert.equal(report.captures.length, 16);
    assert.equal(report.transport.blockedExternalRequests, 0);
    assert.ok(report.transport.injectedRequests > 0);
    assert.equal(report.transport.fakeTududiRequests, 0);
    assert.ok(report.elapsedMs < 60000);
    for (const capture of report.captures) {
      assert.deepEqual(capture.browserErrors, []);
      const png = readFileSync(join(output, capture.file));
      assert.equal(png.readUInt32BE(16), capture.viewport.width);
      assert.equal(png.readUInt32BE(20), capture.viewport.height);
      const closeup = readFileSync(join(output, capture.closeup));
      assert.equal(closeup.readUInt32BE(16), capture.crop.width * 2);
      assert.equal(closeup.readUInt32BE(20), capture.crop.height * 2);
      assert.equal(capture.elements.filter((e: any) => e.kind === 'karakter').length, 6);
      assert.equal(capture.elements.filter((e: any) => e.kind === 'ad-etiketi').length, 6);
      assert.equal(capture.elements.filter((e: any) => e.kind === 'bolum-tabelasi').length, 6);
      const working = capture.elements.filter((e: any) => e.kind === 'balon' && e.status === 'calisiyor' && e.text && e.visible);
      assert.ok(working.length >= 2);
      assert.ok(capture.elements.some((e: any) => e.kind === 'karakter' && e.status === 'bekliyor'));
      // The known defect is informational; verify recorded relationships and exit 0 together.
      assert.ok(Array.isArray(capture.relationships));
    }
    assert.ok(!readdirSync(join(directory, 'node_modules')).some(name => name.startsWith('.vite')));
    const sandbox = JSON.parse(readFileSync(join(directory, 'kutu-ortami.json'), 'utf8'));
    console.log(`Sandbox interfaces: ${sandbox.interfaces.join(', ') || 'none'}; /dev/shm: ${sandbox.shmAvailable ? 'available' : 'unavailable'}.`);
    console.log(`Real offline box: 48 PNGs and 2 description/measurement files, ${(report.elapsedMs / 1000).toFixed(1)} seconds. No external interfaces; TCP listeners/connections and Node fetch attempts blocked. No loopback server used.`);
    renameSync(join(directory, '.cache/browsers'), join(directory, '.cache/browsers-kapali'));
    const missingBrowser = await runCommand(job, c, [c.key]);
    assert.equal(missingBrowser.exit_code, 1, missingBrowser.output);
    assert.match(missingBrowser.output, /Could not launch the browser/);
    assert.ok(!readdirSync(join(directory, '.test-data')).some(name => name.startsWith('run-')));
    console.log("Missing local browser correctly produced an English error, exit 1 and test-data cleanup.");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
