import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';

export function claudeLoginCommand(work) {
  const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
  const path = quote(join(work, '.auth', 'claude-login'));
  return `mkdir -p -- ${path} && chmod 700 -- ${path} && env -i PATH="$PATH" LANG=C.UTF-8 HOME=${path} CLAUDE_CONFIG_DIR=${path} claude`;
}
const readEnv = path => existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : null;
const secret = () => randomBytes(32).toString('hex');
const requireValue = (ok, name) => {
  if (!ok) throw new Error(`${name} is missing or invalid. Fix the existing configuration file; it was not changed.`);
};
function envValue(value) {
  // Node and Compose must read the same value. JSON escapes and Compose $
  // expansion must not silently alter passwords or paths containing spaces.
  if (!value.includes("'")) return `'${value}'`;
  if (!/["\\$]/.test(value)) return `"${value}"`;
  throw new Error("Could not safely write a setting. Check quotation marks; existing settings were not changed.");
}
export function privateIP(value) {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return false;
  const numbers = value.split('.').map(Number);
  if (numbers.some((n, i) => n > 255 || String(n) !== value.split('.')[i])) return false;
  const [a, b] = numbers;
  return a === 127 || a === 10 || (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}
const systemdQuote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';

// Keep all files inside the installation directory. Preserve existing settings;
// conflicting settings stop preparation before any writes.
export function prepareInstall(root) {
  root = realpathSync(resolve(root));
  if (['ofis/.env', 'ofis/data/ofis.sqlite', 'calistirici/.env'].some(path => existsSync(join(root, path))))
    throw new Error('Legacy installation found. Migrate data and configuration paths first; files were not changed.');
  // Check all managed destinations before reading credentials or writing any
  // output. existsSync alone misses dangling links and follows directory links.
  const managed = (path, sensitive = false) => {
    const pieces = path.split('/'); let current = root;
    for (let i = 0; i < pieces.length; i++) {
      current = join(current, pieces[i]);
      let stat;
      try { stat = lstatSync(current); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
      const last = i === pieces.length - 1;
      if (stat.isSymbolicLink() || (!last && !stat.isDirectory()) ||
          (last && !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) ||
          (last && sensitive && (stat.mode & 0o077)))
        throw new Error('Unsafe installation path. Check links and private configuration permissions; files were not changed.');
    }
  };
  for (const path of ['.env', 'office/.env', 'runner/.env', 'tududi/.env', 'docker-compose.override.yml', 'office/data', 'tududi/db', 'tududi/uploads', '.cache/install/pixel-office-runner.service'])
    managed(path, ['office/.env', 'runner/.env', 'tududi/.env'].includes(path));
  const pending = [];
  const template = path => readFileSync(join(root, path), 'utf8');
  const plan = (path, source, values) => {
    const target = join(root, path);
    if (existsSync(target)) return readEnv(target);
    const content = template(source).replace(/^([A-Z_]+)=.*$/gm, (line, key) =>
      Object.hasOwn(values, key) ? `${key}=${envValue(values[key])}` : line);
    pending.push([target, content]);
    return parseEnv(content);
  };
  const compose = plan('.env', '.env.example', {});
  const ip = compose.OFIS_PRIVATE_IP || '';
  requireValue(!ip || privateIP(ip), 'OFIS_PRIVATE_IP');
  const existingOffice = readEnv(join(root, 'office/.env'));
  const existingRunner = readEnv(join(root, 'runner/.env'));
  const tududi = plan('tududi/.env', 'config/tududi.env.example', {
    TUDUDI_SESSION_SECRET: secret(),
    TUDUDI_USER_EMAIL: existingOffice?.TUDUDI_ADMIN_EMAIL || 'yonetici@example.test',
    TUDUDI_USER_PASSWORD: existingOffice?.TUDUDI_ADMIN_PASSWORD || secret(),
  });
  requireValue(tududi.TUDUDI_SESSION_SECRET?.length >= 32, 'TUDUDI_SESSION_SECRET');
  requireValue(tududi.TUDUDI_USER_PASSWORD?.length >= 12, 'TUDUDI_USER_PASSWORD');
  requireValue(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(tududi.TUDUDI_USER_EMAIL || ''), 'TUDUDI_USER_EMAIL');
  const office = plan('office/.env', 'office/.env.example', {
    OFIS_OWNER_PASSWORD: secret(),
    OFIS_SECRET_KEY: secret(),
    OFIS_RUNNER_KEY: existingRunner?.OFIS_RUNNER_KEY || secret(),
    TUDUDI_ADMIN_EMAIL: tududi.TUDUDI_USER_EMAIL,
    TUDUDI_ADMIN_PASSWORD: tududi.TUDUDI_USER_PASSWORD,
  });
  requireValue(/^[a-f\d]{64}$/i.test(office.OFIS_SECRET_KEY || ''), 'OFIS_SECRET_KEY');
  requireValue(office.OFIS_OWNER_PASSWORD?.length >= 12, 'OFIS_OWNER_PASSWORD');
  requireValue(office.OFIS_RUNNER_KEY?.length >= 32, 'OFIS_RUNNER_KEY');
  requireValue(office.TUDUDI_ADMIN_EMAIL === tududi.TUDUDI_USER_EMAIL &&
    office.TUDUDI_ADMIN_PASSWORD === tududi.TUDUDI_USER_PASSWORD, "matching Tududi administrator credentials");
  const runner = plan('runner/.env', 'runner/.env.example', {
    OFIS_RUNNER_KEY: office.OFIS_RUNNER_KEY,
    OFIS_WORK_DIR: join(root, 'runner/work'),
  });
  requireValue(runner.OFIS_RUNNER_KEY === office.OFIS_RUNNER_KEY, "matching office and runner keys");
  if (ip && !existsSync(join(root, 'docker-compose.override.yml'))) {
    pending.push([join(root, 'docker-compose.override.yml'),
      '# Local private network port; not published.\nservices:\n  tududi:\n    ports:\n      - "${OFIS_PRIVATE_IP:?Private network address required}:9400:9400"\n']);
  }
  const service = template('runner/systemd/pixel-office-runner.service.example')
    .replaceAll('@RUNNER_DIR@', systemdQuote(join(root, 'runner')))
    .replaceAll('@ENV_FILE@', systemdQuote(join(root, 'runner/.env')))
    .replaceAll('@NODE_BIN@', systemdQuote(process.execPath))
    .replaceAll('@PATH@', systemdQuote(`PATH=${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`));
  for (const [path, content] of pending) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
  }
  for (const path of ['office/data', 'tududi/db', 'tududi/uploads', '.cache/install']) {
    mkdirSync(join(root, path), { recursive: true, mode: 0o700 });
  }
  writeFileSync(join(root, '.cache/install/pixel-office-runner.service'), service, { mode: 0o600 });
  return { created: pending.length, image: compose.PIKSEL_OFIS_TUDUDI_IMAGE || 'pixel-office-tududi:0.87-po.3', privateNetwork: !!ip, claudeLoginCommand: claudeLoginCommand(runner.OFIS_WORK_DIR || join(root, "runner/work")) };
}

function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error("Node.js 24 or later is required.");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const result = prepareInstall(root);
  console.log(`Preparation complete: ${result.created} new configuration files. Existing settings preserved.`);
  const image = spawnSync('docker', ['image', 'inspect', result.image], { stdio: 'ignore', timeout: 10000 });
  if (image.status !== 0) console.log("Warning: the Tududi image could not be verified locally. Prepare the image from the adapted Tududi repository first.");
  console.log("The owner password is in office/.env; Tududi administrator credentials are in tududi/.env. They were not printed.");
  console.log("Configure the runner Codex authentication file and allowed folders in runner/.env.");
  console.log("Claude is experimental — not tested with a real account. Sign in to a dedicated agent account with:");
  console.log('  '+result.claudeLoginCommand);
  console.log("Do not connect your personal ~/.claude directory. With OFIS_CLAUDE_AUTH_FILE empty, this dedicated identity is used automatically. Check your subscription's automation terms.");
  console.log("Check that the container user (UID 1000) can write to the office data directory.");
  console.log("Command to start containers when you run it yourself from the repository root:");
  console.log('  docker compose up -d --build');
  console.log("Build the runner first: cd runner && npm ci && npm run build");
  console.log("The user service example is ready at .cache/install/pixel-office-runner.service. See README.md for installation steps.");
  console.log("No container or service was started.");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    // Never print file contents, process environment or underlying error objects.
    console.error(error instanceof Error && !('code' in error) ? error.message : "Preparation could not be completed. Check file paths and permissions.");
    process.exitCode = 1;
  }
}
