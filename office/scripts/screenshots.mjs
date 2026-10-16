// Prepare a writable workspace before loading tsx or Vite.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let work;
let child;
let interrupted = false;
const stop = () => { interrupted = true; child?.kill('SIGTERM'); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  const temporaryRoot = resolve(root, '.test-data');
  mkdirSync(temporaryRoot, { recursive: true });
  work = mkdtempSync(join(temporaryRoot, 'screenshots-work-'));
  child = spawn(process.execPath, ['--import', 'tsx', 'scripts/screenshots.ts', ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      TMPDIR: work,
      SCREENSHOTS_WORK_DIR: work,
      XDG_CONFIG_HOME: resolve(work, 'config'),
      XDG_CACHE_HOME: resolve(work, 'cache'),
      PLAYWRIGHT_BROWSERS_PATH: resolve(root, '.cache/browsers'),
      LD_LIBRARY_PATH: resolve(root, '.cache/system-libs/usr/lib/x86_64-linux-gnu'),
    },
  });
  const code = await new Promise((resolveCode, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolveCode(code ?? 1));
  });
  process.exitCode = interrupted ? 1 : code;
} catch {
  console.error("Screenshot capture failed. Check temporary-directory permissions and installed Node dependencies.");
  process.exitCode = 1;
} finally {
  if (work) rmSync(work, { recursive: true, force: true });
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
}
