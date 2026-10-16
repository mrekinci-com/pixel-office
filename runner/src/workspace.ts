import { t as tx, withLanguage } from "./i18n.js";
import { existsSync, mkdirSync, readdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { Lease, FolderLink, CommandJob } from '../../office/shared/runtime.js';
import type { RunnerConfig } from './config.js';
import { runCommand } from './command-box.js';
export function directoryMaps(lease: Lease, work: string) {
  const dir = join(work, 'dizin-haritasi'); mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const link of lease.policy.permission==='folders' ? lease.links : []) {
    const entries: string[] = []; let count = 0;
    const walk = (root: string, prefix = '', depth = 0) => {
      if (depth > 5 || count > 500) return;
      for (const e of readdirSync(root, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
        if (e.name.startsWith('.') || ['node_modules', 'dist', 'data', 'veri', 'coverage'].includes(e.name) || e.isSymbolicLink()) continue;
        const path = prefix + e.name; count++;
        entries.push(e.isDirectory() ? tx("{0}/ — klasör", [path]) : tx("{0} — {1} dosya (otomatik tür bilgisi)", [path, extname(e.name).slice(1) || tx("uzantısız")]));
        if (e.isDirectory()) walk(join(root, e.name), path + '/', depth + 1);
        if (count >= 500) break;
      }
    };
    walk(link.path); if (existsSync(join(dir, link.id + '.txt'))) chmodSync(join(dir, link.id + '.txt'), 0o600); writeFileSync(join(dir, link.id + '.txt'), tx("{0}\nİçerikler okunmadan üretilen sınırlı dizin haritası.\n{1}", [link.name, entries.join('\n')]), { mode: 0o400 });
  }
}
const quote = (v: string) => "'" + v.replace(/'/g, "'\\''") + "'";
export class DirtyWorkspaceError extends Error {
  constructor() { super(tx("Kod klasöründe kaydedilmemiş değişiklikler var. Değişiklikleri kaydet ve devam et düğmesiyle bu işi sürdürebilirsiniz.")); }
}
export function endingLabel(reason: string) {
  if (/token.*(?:bütçe|budget)/i.test(reason)) return tx("token bütçesinde kesildi");
  if (/süresi|süre sınırı|time limit/i.test(reason)) return tx("süre sınırında kesildi");
  if (/durdur|kapatıl|stopped|shut down/i.test(reason)) return tx("durduruldu");
  return reason ? tx("çalışma yarıda kaldı") : tx("tamamlandı");
}
export async function gitCopies(lease: Lease, c: RunnerConfig, finish: boolean, secrets: string[], reason = '', execute = runCommand) {
  const results: string[] = [];
  for (const folder of lease.links.filter(l => l.access === 'write' && !l.approved_write && existsSync(join(l.path, '.git')))) {
    const task = (command: string): CommandJob => ({ id: '', run_id: lease.run.id, agent_id: lease.agent.id, folder, state: 'running', exit_code: null, output: '', command: { id: '', name: tx("Çalışma kopyası"), folder_id: folder.id, directory: '.', command, timeout_seconds: 30, write: finish, approval: false, agent_ids: [lease.agent.id] } });
    const git = 'git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgsign=false';
    const status = await execute(task(`${git} status --porcelain`), c, secrets);
    if (status.exit_code !== 0) throw new Error(tx("Git çalışma kopyasının durumu doğrulanamadı."));
    if (!finish && status.output.trim()) throw new DirtyWorkspaceError();
    if (!finish || !status.output.trim()) continue;
    if (/(?:^|[ /])\.env(?:[.\s]|$)|(?:^|[ /])(?:auth\.json|credentials|\.ssh)(?:[ /\s]|$)/m.test(status.output)) throw new Error(tx("Değişikliklerde gizli dosya yolu bulundu; kayıt durduruldu."));
    const diff = await execute(task(`${git} diff --stat; ${git} ls-files --others --exclude-standard`), c, secrets);
    if (diff.exit_code !== 0) throw new Error(tx("Dosya farkı okunamadı."));
    const message = `${lease.run.summary.slice(0, 150)} — ${withLanguage("en", () => endingLabel(reason))} — ${lease.run.id}`;
    const commit = await execute(task(`${git} add --all && ${git} -c user.name=${quote(lease.agent.name)} -c user.email=${quote(lease.agent.tududi_email)} commit --no-verify -m ${quote(message)}`), c, secrets);
    if (commit.exit_code !== 0) throw new Error(tx("Ajan değişiklikleri Git kaydına alınamadı; çalışma kopyasını kontrol edin."));
    const verify = await execute(task(`${git} status --porcelain && ${git} rev-parse HEAD`), c, secrets);
    if (verify.exit_code !== 0 || !/^[a-f0-9]{40,64}\s*$/.test(verify.output.trim())) throw new Error(tx("Dosyalar kaydedildi ama klasör temiz bırakılamadı. Klasörü kontrol edin."));
    results.push(tx("{0}\nKayıt: {1}\n{2}\n{3}\n{4}", [folder.name, verify.output.trim(), endingLabel(reason), diff.output, commit.output]));
  }
  return results;
}
