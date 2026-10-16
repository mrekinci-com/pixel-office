import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, symlinkSync, linkSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import { prepareInstall, privateIP } from './install.mjs';

process.env.LANG = 'tr_TR.UTF-8';
const repo = fileURLToPath(new URL('../', import.meta.url));
const templates = ['docker-compose.yml', '.env.example', 'office/.env.example', 'runner/.env.example', 'config/tududi.env.example',
  'runner/systemd/pixel-office-runner.service.example'];
const envPaths = ['.env', 'office/.env', 'runner/.env', 'tududi/.env'];
const env = (root, path) => parseEnv(readFileSync(join(root, path), 'utf8'));

test("G3: installer rejects linked directories/files and overly broad secret-file permissions", () => {
  for(const kind of ['directory','symlink','hardlink','permissions']) {
    const root=fixture('g3-install-');
    try {
      const outside=join(root,'ayri-alan'); mkdirSync(outside);
      const source=join(outside,'hedef'); writeFileSync(source,'korunacak',{mode:0o600});
      const target=join(root,'office/.env');
      if(kind==='directory'){rmSync(join(root,'tududi'),{recursive:true,force:true});symlinkSync(outside,join(root,'tududi'));}
      else if(kind==='symlink')symlinkSync(source,target);
      else if(kind==='hardlink')linkSync(source,target);
      else {writeFileSync(target,'geçersiz',{mode:0o600});chmodSync(target,0o644);}
      assert.throws(()=>prepareInstall(root),/Unsafe installation path/);
      assert.equal(readFileSync(source,'utf8'),'korunacak');
      assert.equal(existsSync(join(root,'.env')),false);
      assert.equal(existsSync(join(outside,'.env')),false);
    } finally { rmSync(root,{recursive:true,force:true}); }
  }
});
function fixture(prefix = 'kurulum % alan-') {
  const base = resolve(repo, '.test-data');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, prefix));
  for (const file of templates) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    copyFileSync(join(repo, file), join(root, file));
  }
  return root;
}

test("R1: legacy live data/settings paths prevent preparation from creating any files", () => {
  for (const marker of ['ofis/.env', 'ofis/data/ofis.sqlite', 'calistirici/.env']) {
    const root = fixture('legacy-install-');
    try {
      mkdirSync(join(root, marker, '..'), { recursive: true });
      writeFileSync(join(root, marker), 'preserved-local-fixture', { mode: 0o600 });
      assert.throws(() => prepareInstall(root), /Legacy installation found/);
      assert.equal(readFileSync(join(root, marker), 'utf8'), 'preserved-local-fixture');
      assert.equal(existsSync(join(root, '.env')), false);
      assert.equal(existsSync(join(root, 'office/.env')), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("Fresh install: shared key, matching administrator and private file permissions; reruns preserve settings", () => {
  const root = fixture();
  try {
    const result = prepareInstall(root);
    assert.equal(result.created, 4);
    assert.equal(result.image, 'pixel-office-tududi:0.87-po.3');
    assert.equal(existsSync(join(root, 'docker-compose.override.yml')), false);
    const office = env(root, 'office/.env'), runner = env(root, 'runner/.env'), tududi = env(root, 'tududi/.env');
    assert.match(office.OFIS_SECRET_KEY, /^[a-f\d]{64}$/);
    assert.ok(office.OFIS_OWNER_PASSWORD.length >= 12);
    assert.equal(office.OFIS_RUNNER_KEY, runner.OFIS_RUNNER_KEY);
    assert.equal(office.TUDUDI_ADMIN_EMAIL, tududi.TUDUDI_USER_EMAIL);
    assert.equal(office.TUDUDI_ADMIN_PASSWORD, tududi.TUDUDI_USER_PASSWORD);
    assert.notEqual(office.OFIS_OWNER_PASSWORD, tududi.TUDUDI_USER_PASSWORD);
    assert.equal(runner.OFIS_WORK_DIR, join(root, 'runner/work'));
    const before = envPaths.map(path => readFileSync(join(root, path), 'utf8'));
    assert.equal(prepareInstall(root).created, 0);
    assert.deepEqual(envPaths.map(path => readFileSync(join(root, path), 'utf8')), before);
    for (const file of envPaths) assert.equal(statSync(join(root, file)).mode & 0o777, 0o600);
    const service = readFileSync(join(root, '.cache/install/pixel-office-runner.service'), 'utf8');
    assert.ok(!/@[A-Z_]+@/.test(service));
    assert.ok(service.includes('kurulum %% alan-'));
    assert.ok(service.includes(`ExecStart="${process.execPath}"`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Private addresses create only local overrides; existing overrides and image choices persist", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, '.env'), 'OFIS_PRIVATE_IP=10.20.30.40\nPIKSEL_OFIS_TUDUDI_IMAGE=ozel-tududi:deneme\n', { mode: 0o600 });
    const result = prepareInstall(root);
    assert.equal(result.image, 'ozel-tududi:deneme');
    assert.equal(result.privateNetwork, true);
    const path = join(root, 'docker-compose.override.yml');
    assert.match(readFileSync(path, 'utf8'), /OFIS_PRIVATE_IP/);
    writeFileSync(path, '# Operator-owned local override\n');
    prepareInstall(root);
    assert.equal(readFileSync(path, 'utf8'), '# Operator-owned local override\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Public/malformed IPs and missing settings fail before writing files", () => {
  for (const ip of ['0.0.0.0', '192.0.2.10', 'example.test', '10.999.0.1', '010.0.0.1']) {
    const root = fixture();
    try {
      writeFileSync(join(root, '.env'), `OFIS_PRIVATE_IP=${ip}\n`);
      assert.throws(() => prepareInstall(root), /OFIS_PRIVATE_IP/);
      assert.equal(existsSync(join(root, 'office/.env')), false);
      assert.equal(existsSync(join(root, 'tududi/.env')), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.10', '100.64.0.1']) assert.equal(privateIP(ip), true);
});

test("Existing key conflicts stop before creating new files", () => {
  const root = fixture();
  try {
    prepareInstall(root);
    const path = join(root, 'runner/.env');
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, original.replace(/^OFIS_RUNNER_KEY=.*$/m, 'OFIS_RUNNER_KEY="' + 'f'.repeat(64) + '"'));
    rmSync(join(root, '.env'));
    assert.throws(() => prepareInstall(root), /matching office and runner keys/);
    assert.equal(existsSync(join(root, '.env')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Partial installs preserve admin-password spaces, dollars, quotes and backslashes", () => {
  const root = fixture();
  try {
    prepareInstall(root);
    const password = 'yalnız test " # $DEGISKEN \\n son';
    const file = join(root, 'office/.env');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^TUDUDI_ADMIN_PASSWORD=.*$/m, () => `TUDUDI_ADMIN_PASSWORD='${password}'`));
    rmSync(join(root, 'tududi/.env'));
    prepareInstall(root);
    assert.equal(env(root, 'office/.env').TUDUDI_ADMIN_PASSWORD, password);
    assert.equal(env(root, 'tududi/.env').TUDUDI_USER_PASSWORD, password);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Full helper reads Docker images only, prints startup commands and hides secrets", () => {
  const root = fixture();
  try {
    mkdirSync(join(root, 'scripts'));
    for (const file of ['install.sh', 'install.mjs']) copyFileSync(join(repo, 'scripts', file), join(root, 'scripts', file));
    // The Docker stub permits only this read-only query; up/run/start must fail.
    mkdirSync(join(root, 'bin'));
    const calls = join(root, 'docker-calls.txt');
    writeFileSync(join(root, 'bin/docker'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$OFIS_TEST_DOCKER_CALLS"\n[ "$1" = image ] && [ "$2" = inspect ] || exit 99\nexit 1\n', { mode: 0o700 });
    const result = spawnSync('bash', [join(root, 'scripts/install.sh')], {
      env: { ...process.env, OFIS_TEST_DOCKER_CALLS: calls, PATH: `${join(root, 'bin')}:${process.env.PATH}` }, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, 0, "The preparation command must succeed.");
    assert.match(result.stdout, /Warning: the Tududi image/);
    assert.match(result.stdout, /docker compose up -d --build/);
    assert.match(result.stdout, /No container or service was started/);
    assert.equal(readFileSync(calls, 'utf8'), 'image inspect pixel-office-tududi:0.87-po.3\n');
    for (const path of ['office/.env', 'runner/.env', 'tududi/.env']) {
      for (const [key, value] of Object.entries(env(root, path))) {
        if (/PASSWORD|SECRET|KEY/.test(key) && value) assert.ok(!result.stdout.includes(value) && !result.stderr.includes(value));
      }
    }
    const help = spawnSync('bash', [join(root, 'scripts/install.sh'), '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const composeAvailable = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0;
test("Clean Compose binds only local ports; private-address overrides configure extra ports and proxy together", { skip: !composeAvailable }, () => {
  const root = fixture('compose alan-');
  try {
    prepareInstall(root);
    const composeEnv = { ...process.env };
    for (const key of Object.keys(composeEnv)) if (key.startsWith('COMPOSE_') || ['OFIS_PRIVATE_IP', 'PIKSEL_OFIS_TUDUDI_IMAGE'].includes(key)) delete composeEnv[key];
    const config = () => {
      const result = spawnSync('docker', ['compose', '--project-directory', root, '--env-file', join(root, '.env'), 'config', '--format', 'json'],
        { cwd: root, env: composeEnv, encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 0, "Compose configuration must resolve; potentially secret output is withheld.");
      return JSON.parse(result.stdout).services;
    };
    let services = config();
    assert.equal(services.tududi.image, 'pixel-office-tududi:0.87-po.3');
    assert.equal(services.tududi.ports.length, 2);
    assert.ok(services.tududi.ports.every(port => port.host_ip === '127.0.0.1'));
    assert.equal(services['tududi-proxy'].environment.TUDUDI_PROXY_BIND, '127.0.0.1');
    assert.equal(services.office.environment.OFIS_PUBLIC_URL, 'http://127.0.0.1:9400');
    writeFileSync(join(root, '.env'), 'OFIS_PRIVATE_IP=10.20.30.40\n');
    prepareInstall(root);
    services = config();
    assert.equal(services.tududi.ports.length, 3);
    assert.ok(services.tududi.ports.some(port => port.host_ip === '10.20.30.40' && port.target === 9400));
    assert.equal(services['tududi-proxy'].environment.TUDUDI_PROXY_BIND, '10.20.30.40');
    assert.equal(services.office.environment.OFIS_PUBLIC_URL, 'http://10.20.30.40:9400');
    assert.equal(services.office.environment.TUDUDI_PUBLIC_URL, 'http://10.20.30.40:9394');
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("Installer help and errors stay English across LANG values", () => {
  for (const [language, expected] of [['tr_TR.UTF-8', /Usage/], ['en_US.UTF-8', /Usage/], ['de_DE.UTF-8', /Usage/]]) {
    const result = spawnSync('bash', [join(repo, 'scripts/install.sh'), '--help'], {env:{...process.env,LANG:language},encoding:'utf8'});
    assert.equal(result.status,0); assert.match(result.stdout,expected);
    assert.doesNotMatch(result.stdout, /[çğıöşüÇĞİÖŞÜ]/);
    const invalid = spawnSync('bash', [join(repo, 'scripts/install.sh'), '--unknown'], {env:{...process.env,LANG:language},encoding:'utf8'});
    assert.equal(invalid.status,1); assert.match(invalid.stderr,/Unknown option/);
  }
  const root = fixture();
  try {
    writeFileSync(join(root,'.env'), 'OFIS_PRIVATE_IP=0.0.0.0\n', {mode:0o600});
    process.env.LANG='en_US.UTF-8';
    assert.throws(()=>prepareInstall(root), /missing or invalid/);
    assert.equal(existsSync(join(root,'office/.env')),false);
  } finally { process.env.LANG='tr_TR.UTF-8'; rmSync(root,{recursive:true,force:true}); }
});

test("C1: installer prints separate Claude login commands without personal profiles or credential contents",()=>{
  const root=fixture('c1-login-');try{
    const result=prepareInstall(root);
    assert.ok(result.claudeLoginCommand.includes('CLAUDE_CONFIG_DIR='));assert.ok(result.claudeLoginCommand.includes('/.auth/claude-login'));
    assert.ok(!result.claudeLoginCommand.includes('~/.claude'));assert.ok(!result.claudeLoginCommand.includes(env(root,'runner/.env').OFIS_RUNNER_KEY));
    const syntax=spawnSync('/bin/bash',['-n'],{input:result.claudeLoginCommand,encoding:'utf8'});assert.equal(syntax.status,0,syntax.stderr);
    assert.ok(!existsSync(join(root,'runner','work','.auth')),"The installer neither signs in nor creates credentials.");
  } finally{rmSync(root,{recursive:true,force:true});}
});
