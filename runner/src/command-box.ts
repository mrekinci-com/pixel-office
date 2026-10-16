import { t as tx } from "./i18n.js";
import { spawn } from 'node:child_process';
import { existsSync, realpathSync, lstatSync,readdirSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import type { CommandJob } from '../../office/shared/runtime.js';
import type { RunnerConfig } from './config.js';
import { validateFolder } from './files.js';
import { redact } from './diagnostics.js';
export function commandBox(job: CommandJob, c: RunnerConfig) {
  const root = validateFolder(job.folder.path, c), cwd = resolve(root, job.command.directory);
  const rel = relative(root, cwd);
  if (rel.startsWith('..') || rel.startsWith('/') || !existsSync(cwd) || realpathSync(cwd) !== cwd || lstatSync(cwd).isSymbolicLink()) throw new Error(tx("Komut klasörü bağlantının altında olmalı."));
  if (job.command.write && (job.folder.access !== 'write' || job.folder.approved_write)) throw new Error(tx("Komutun yazma yetkisi yok."));
  const args = ['--die-with-parent', '--new-session', '--unshare-all', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'];
  for (const p of ['/usr', '/bin', '/lib', '/lib64']) if (existsSync(p)) args.push('--ro-bind', p, p);
  // Mount a custom Node installation only as a runtime, without exposing the user home.
  if (!process.execPath.startsWith('/usr/') && !process.execPath.startsWith('/bin/')) args.push('--ro-bind', resolve(dirname(process.execPath),'..'), resolve(dirname(process.execPath),'..'));
  args.push(job.command.write ? '--bind' : '--ro-bind', root, root);
  // Keep node_modules read-only even inside writable folders.
  const dependencies:string[]=[];let directories=0;
  const findDependencies=(dir:string)=>{if(++directories>2000)throw new Error(tx("Komut klasörü çok geniş; daha küçük bir bağlantı seçin."));for(const entry of readdirSync(dir,{withFileTypes:true})){if(!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.'))continue;const p=join(dir,entry.name);if(entry.name==='node_modules')dependencies.push(p);else findDependencies(p);}};
  findDependencies(root);for(const p of dependencies)args.push('--ro-bind',p,p);
  args.push('--chdir', cwd, '--', '/bin/sh', '-c', job.command.command);
  return { bin: c.bwrap, args, cwd, env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8', npm_config_cache: '/tmp/npm-cache', npm_config_offline: 'true', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } };
}
export async function runCommand(job: CommandJob, c: RunnerConfig, secrets: string[], signal?: AbortSignal) {
  const cmd = commandBox(job, c);
  return await new Promise<{ exit_code: number | null; output: string }>((resolveResult) => {
    const child = spawn(cmd.bin, cmd.args, { cwd: cmd.cwd, env: cmd.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '', bytes = 0, timedOut = false;
    const kill = () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    signal?.addEventListener('abort',kill,{once:true}); if(signal?.aborted)kill();
    const timer = setTimeout(() => { timedOut = true; kill(); }, job.command.timeout_seconds * 1000);
    const append = (b: Buffer) => { bytes += b.length; tail = (tail + b.toString('utf8')).slice(-60000); if (bytes > 5000000) kill(); };
    child.stdout!.on('data', append); child.stderr!.on('data', append);
    const finish = (exit_code: number | null, error = '') => { clearTimeout(timer); signal?.removeEventListener('abort',kill); kill(); resolveResult({ exit_code, output: redact((tail.split('\n').slice(-200).join('\n') + (timedOut ? tx("\nSüre sınırı aşıldı.") : '') + (signal?.aborted ? tx("\nSahibi çalışmayı durdurdu.") : '') + error).slice(-20000), secrets) }); };
    child.once('error', () => finish(null, tx("\nKomut kutusu başlatılamadı."))); child.once('close', code => finish(code));
  });
}
