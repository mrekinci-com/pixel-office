// Production client + Fastify inject + fake Tududi; no listener, service,
// container, live account, runner process or model. All traffic is intercepted.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { testConfig, fakeTududi, cleanup, input } from './helpers.js';
import type { Page } from 'playwright';
import type { Task } from '../shared/types.js';
const cache = resolve('.cache/runtime');
mkdirSync(cache, { recursive: true });
process.env.TMPDIR = cache;
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve('.cache/browsers');
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], downloadsPath: cache,
  env: { ...process.env, LD_LIBRARY_PATH: [resolve('.cache/system-libs/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } });
const client = resolve('dist/client');
const shots = resolve('../docs/asama-u1-gorseller');
mkdirSync(shots, { recursive: true });
mkdirSync(resolve('.test-data/u1'), { recursive: true });
const results: unknown[] = [];
const errors: string[] = [];
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 50)); }
  assert.fail("Expected state was not reached.");
}
async function push(page: Page) {
  await page.evaluate(() => {
    for (const source of (window as typeof window & { u1Sources?: EventSource[] }).u1Sources || [])
      if (source.readyState === 1) source.dispatchEvent(new MessageEvent('update', { data: '{}' }));
  });
}
async function layout(page: Page, width: number, language: string) {
  await page.setViewportSize({ width, height: width <= 600 ? 844 : 900 });
  await page.evaluate(() => { document.querySelector('main')!.scrollTop = 0; });
  await page.locator('.task-card-title').first().waitFor();
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
  const metrics = await page.evaluate(() => {
    const rect = (element: Element) => { const b = element.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, bottom: b.bottom }; };
    const board = document.querySelector<HTMLElement>('.task-columns')!;
    const body = document.querySelector<HTMLElement>('.task-column-body')!;
    const title = document.querySelector<HTMLElement>('.task-card-title')!;
    const description = document.querySelector<HTMLElement>('.task-card p')!;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      pageOverflow: document.documentElement.scrollWidth > innerWidth,
      mainOverflow: document.querySelector('main')!.scrollWidth > document.querySelector('main')!.clientWidth,
      board: { ...rect(board), scrollWidth: board.scrollWidth, clientWidth: board.clientWidth },
      body: { ...rect(body), scrollHeight: body.scrollHeight, clientHeight: body.clientHeight },
      emptyHeights: [...document.querySelectorAll('.task-column')].filter(c => c.querySelector('.column-empty')).map(c => rect(c).height),
      title: { height: title.clientHeight, fullHeight: title.scrollHeight, lineHeight: parseFloat(getComputedStyle(title).lineHeight) },
      description: { height: description.clientHeight, fullHeight: description.scrollHeight, lineHeight: parseFloat(getComputedStyle(description).lineHeight), overflow: getComputedStyle(description).overflowY },
      controls: [...document.querySelectorAll('.tududi-actions > button')].map(rect),
      select: rect(document.querySelector('.tududi-toolbar select')!),
      panel: rect(document.querySelector('.tududi-login > button')!),
      heading: rect(document.querySelector('.page-heading h1')!),
      statusHeights: [...document.querySelectorAll('.task-card select')].map(c => rect(c).height),
    };
  });
  assert.equal(metrics.pageOverflow, false, JSON.stringify(metrics));
  assert.equal(metrics.mainOverflow, false, JSON.stringify(metrics));
  assert.ok(metrics.title.height <= metrics.title.lineHeight * 2 + 1, JSON.stringify(metrics));
  assert.ok(metrics.title.fullHeight > metrics.title.height, "Long titles are clamped to two lines.");
  assert.ok(metrics.description.height <= metrics.description.lineHeight * 3 + 1, JSON.stringify(metrics));
  assert.ok(metrics.description.fullHeight > metrics.description.height, "Long descriptions are clamped to three lines.");
  assert.equal(metrics.description.overflow, 'hidden');
  assert.ok(metrics.body.scrollHeight > metrics.body.clientHeight, "Long columns scroll independently.");
  assert.ok(metrics.emptyHeights.every(h => h < 140), JSON.stringify(metrics));
  assert.ok(metrics.statusHeights.every(h => h === 30), JSON.stringify(metrics));
  assert.ok(metrics.controls.every(c => c.height === 36), JSON.stringify(metrics));
  assert.ok(metrics.controls.every(c => c.x >= 0 && c.x + c.width <= width + 1), JSON.stringify(metrics));
  if (width >= 1200) {
    assert.equal(metrics.board.scrollWidth, metrics.board.clientWidth);
    assert.ok(metrics.board.bottom <= metrics.viewport.height - 8, JSON.stringify(metrics));
    assert.ok(metrics.controls.every(c => c.y === metrics.controls[0].y));
    assert.ok(Math.abs((metrics.heading.y + metrics.heading.height / 2) - (metrics.controls[0].y + 18)) <= 2, JSON.stringify(metrics));
    assert.ok(Math.abs(metrics.select.y - metrics.panel.y) <= 1, JSON.stringify(metrics));
    assert.equal(metrics.select.height, metrics.panel.height);
  } else {
    assert.ok(metrics.board.scrollWidth > metrics.board.clientWidth);
    assert.ok(metrics.board.bottom <= metrics.viewport.height - (width <= 900 ? 60 : 8), JSON.stringify(metrics));
  }
  await page.locator('.task-column-body').first().evaluate(el => { el.scrollTop = 150; });
  assert.ok(await page.locator('.task-column-body').first().evaluate(el => el.scrollTop > 0));
  await page.locator('.task-column-body').first().evaluate(el => { el.scrollTop = 0; });
  await page.locator('.task-columns').evaluate(el => { el.scrollLeft = 0; });
  if (width === 1440 || width === 390)
    await page.screenshot({ path: resolve(shots, `${language}-${await page.locator('html').getAttribute('data-theme')}-${width}.png`) });
  results.push({ language, theme: await page.locator('html').getAttribute('data-theme'), width, metrics });
}
try {
  for (const language of ['tr', 'en'] as const) {
    const config = { ...testConfig(language), publicOrigin: 'http://office.test' };
    const c = await createApp(config, { fetcher: fakeTududi().fetcher, background: false });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: language === 'tr' ? 'tr-TR' : 'en-US', reducedMotion: 'reduce' });
    let page!: Page;
    try {
      // tsx preserves local function names with this helper in serialized callbacks.
      await context.addInitScript({content: `window.__name=(fn)=>fn; localStorage.setItem('po-gm-window','hidden');
        class TestSource extends EventTarget {
          static OPEN=1; readyState=1;
          constructor(){super();(window.u1Sources ||= []).push(this);setTimeout(()=>this.dispatchEvent(new MessageEvent('ready',{data:'{}'})),0);}
          close(){this.readyState=2;}
        }
        Object.defineProperty(window,'EventSource',{value:TestSource});`});
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== 'http://office.test') return route.abort();
        if (url.pathname === '/api/director/terminal/ticket') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ticket: 'u1-fake-ticket' }) });
        if (url.pathname.startsWith('/api/')) {
          const response = await c.app.inject({ method: request.method() as any, url: url.pathname + url.search, headers: request.headers(), ...(request.postData() ? { payload: request.postData()! } : {}) });
          return route.fulfill({ status: response.statusCode, headers: Object.fromEntries(Object.entries(response.headers).filter(([key]) => !['content-length', 'transfer-encoding', 'connection'].includes(key)).map(([key, value]) => [key, Array.isArray(value) ? value.join('\n') : String(value)])), body: response.body });
        }
        const file = url.pathname === '/' ? resolve(client, 'index.html') : resolve(client, '.' + url.pathname);
        if (!file.startsWith(client + sep) || !existsSync(file)) return route.fulfill({ status: 404, body: '' });
        const types: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
        return route.fulfill({ contentType: types[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
      });
      page = await context.newPage();
      page.setDefaultTimeout(12000);
      page.on('pageerror', e => errors.push(e.message));
      await page.routeWebSocket('ws://office.test/api/director/terminal/socket*', ws => {
        ws.send(JSON.stringify({ type: 'status', terminal: { enabled: true, status: 'idle', generation: 1, usageKnown: false } }));
        ws.send(JSON.stringify({ type: 'output', data: language === 'tr' ? 'İşler hazır. Sonraki talimatınızı bekliyorum.\r\n' : 'Ready for your next instruction.\r\n' }));
      });
      await page.goto('http://office.test/');
      await page.getByLabel(language === 'tr' ? 'Sahip şifresi' : 'Owner password', { exact: true }).fill(config.ownerPassword);
      await page.getByRole('button', { name: language === 'tr' ? 'Ofisi aç' : 'Open office', exact: true }).click();
      await page.locator('.office-viewport').waitFor();
      const gm = c.runtime.director.agent();
      await c.office.provision(gm.id);
      const agent = await c.office.createAgent({ ...input(gm.department_id), name: 'Kerem', title: language === 'tr' ? 'Yazılımcı' : 'Developer' });
      const token = c.office.token(agent.id);
      const project = (await c.office.tududi.read(token)).projects[0] || await c.office.tududi.project(token, language === 'tr' ? 'Çalışma defteri' : 'Workbook');
      const longTitle = language === 'tr' ? 'Müşterinin istediği raporu bütün kaynakları yeniden kontrol ederek hazırla; eksik bölümleri tamamla ve teslim tarihinden önce son durumu ayrıntılı biçimde bildir' : 'Prepare the requested report by checking all sources again; complete the missing sections and provide a detailed update before the delivery date';
      const longText = (language === 'tr' ? 'Bu görevde önceki kayıtları inceleyin, doğrulanmış bilgileri bir araya getirin ve sonucu anlaşılır biçimde yazın.\n' : 'Review the previous records, combine the verified information and write the result clearly.\n').repeat(12) + (language === 'tr' ? 'Açıklamanın son satırı.' : 'Last line of the description.');
      const tasks: Task[] = [];
      for (let i = 0; i < 9; i++) tasks.push(await c.office.tududi.task(token, { name: `${i + 1}. ${longTitle}`, description: longText, project_uid: project.uid }));
      const archived = await c.office.tududi.task(token, { name: language === 'tr' ? 'Arşivlenmiş görev' : 'Archived task', description: longText });
      await c.office.tududi.updateTaskFields(token, archived.uid, { status: 3 });
      await c.office.tududi.note(token, { title: language === 'tr' ? 'Teslim notu' : 'Delivery note', content: language === 'tr' ? 'Son kontrol bekleniyor.' : 'Waiting for the final check.' });
      const oldMessages = Array.from({ length: 21 }, (_, i) => c.office.message(gm.id, 'agent', gm.id, `GM ${i + 1}`));
      const other = c.office.message(agent.id, 'agent', agent.id, language === 'tr' ? 'Başka sohbetin cevabı.' : 'Reply in another chat.');
      const run = c.runtime.enqueue(gm.id, 'Deneme', 'Karar bekleyen iş')!;
      const approval = { id: randomUUID(), agent_id: gm.id, run_id: run.id, title: language === 'tr' ? 'Raporu paylaşma kararı' : 'Decision to share the report', detail: '', type: 'external', state: 'pending' as const, note: '', created_at: new Date().toISOString(), decided_at: null, link_id: null, files: [] };
      c.runtime.saveApproval(approval);
      c.runtime.director.entry('text', language === 'tr' ? 'Önceki Genel Müdür cevabı.' : 'Previous Director reply.');
      await push(page);
      const gmButton = page.locator('.rail > nav').getByRole('button', { name: language === 'tr' ? 'Genel Müdür terminalini aç' : 'Open Director terminal', exact: true });
      const approvalButton = page.locator('.rail > nav').getByRole('button', { name: language === 'tr' ? 'Onay kutusu' : 'Approval inbox', exact: true });
      await until(async () => (await gmButton.locator('b').textContent()) === '1');
      assert.equal(await approvalButton.locator('b').textContent(), '1');
      assert.equal(await page.locator('#direct-chats').getByText(gm.name, { exact: true }).count(), 0);
      assert.equal(await page.locator('.rail-upcoming').count(), 0);
      await gmButton.click();
      const terminal = page.getByRole('dialog', { name: language === 'tr' ? 'Genel Müdür terminali' : 'Director terminal', exact: true });
      await terminal.waitFor();
      const isRead = (id: string) => !!c.store.db.prepare("SELECT 1 FROM message_reads WHERE message_id=? AND reader_id='owner'").get(id);
      await until(() => oldMessages.every(m => isRead(m.id)));
      assert.equal(isRead(other.id), false);
      assert.equal(await gmButton.locator('b').textContent(), '1', "Opening the terminal makes no decisions.");
      const fresh = c.office.message(gm.id, 'agent', gm.id, 'Açık terminalde yeni cevap');
      c.runtime.director.entry('text', 'Yeni cevap');
      await push(page);
      await until(() => isRead(fresh.id));
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      const background = c.office.message(gm.id, 'agent', gm.id, 'Arka planda gelen cevap');
      const refreshed = page.waitForResponse(response => response.url().endsWith('/api/snapshot'));
      await push(page);
      // Wait for the snapshot refresh while visibility remains hidden.
      await refreshed;
      assert.equal(isRead(background.id), false);
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await until(() => isRead(background.id));
      await page.screenshot({ path: resolve(shots, `${language}-gm-okundu.png`) });
      await terminal.getByLabel(language === 'tr' ? 'Genel Müdür terminalini küçült' : 'Minimize Director terminal', { exact: true }).click();
      const minimized = c.office.message(gm.id, 'agent', gm.id, 'Küçültülmüşken yeni cevap');
      c.runtime.director.entry('text', 'Küçültülmüşken yeni çıktı');
      await push(page);
      await page.locator('.gm-minimized b').waitFor();
      assert.equal(isRead(minimized.id), false, "Minimized cards do not display the entire answer.");
      await page.locator('.gm-minimized').click();
      await until(() => isRead(minimized.id));
      await terminal.getByLabel(language === 'tr' ? 'Genel Müdür terminalini küçült' : 'Minimize Director terminal', { exact: true }).click();
      assert.equal(await page.locator('.gm-minimized b').count(), 0, "Reading the terminal resets its minimized-card counter.");
      await approvalButton.click();
      await page.getByRole('button', { name: language === 'tr' ? 'Reddet' : 'Reject', exact: true }).click();
      await until(async () => await gmButton.locator('b').count() === 0 && await approvalButton.locator('b').count() === 0);
      await page.reload();
      await page.locator('.office-viewport').waitFor();
      await until(async () => await gmButton.locator('b').count() === 0);
      await page.locator('.rail > nav').getByRole('button', { name: language === 'tr' ? 'Görevler ve notlar' : 'Tasks and notes', exact: true }).click();
      await page.locator('.tududi-toolbar select').selectOption(agent.id);
      await page.locator('.task-card-title').first().waitFor();
      for (const theme of ['dark', 'light']) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; localStorage.setItem('po-tema', value); }, theme);
        for (const width of [1440, 1024, 390, 320]) await layout(page, width, language);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.locator('.task-card-title').first().focus();
      await page.keyboard.press('Enter');
      const detail = page.getByRole('dialog', { name: language === 'tr' ? 'Görev ayrıntısı' : 'Task details', exact: true });
      await detail.waitFor();
      assert.equal(await detail.locator('h3').textContent(), tasks[0].name);
      assert.equal(await detail.locator('.task-detail > p').first().textContent(), longText);
      await page.screenshot({ path: resolve(shots, `${language}-ayrinti.png`) });
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.task-card-title').first().evaluate(el => document.activeElement === el), true);
      await page.locator('.task-column').first().locator('.task-card select').first().selectOption('1');
      await until(async () => (await c.office.tududi.read(token)).tasks.find(t => t.uid === tasks[0].uid)?.status === 1);
      await until(async () => await page.locator('.task-column').nth(1).locator('.task-card').count() === 1);
      assert.equal(await page.getByRole('dialog').count(), 0);
      await page.locator('.archived-tasks > summary').click();
      await page.locator('.archived-tasks .task-card-title').click();
      await detail.waitFor();
      assert.equal(await detail.locator('h3').textContent(), archived.name);
      await page.keyboard.press('Escape');
      console.log(`U1 ${language}: GM read/decision counters, 9 long cards, detail, status, archive, two themes and four widths passed.`);
    } catch (error) {
      if (page) await page.screenshot({ path: resolve('.test-data/u1/failure.png') }).catch(() => {});
      throw error;
    } finally { await context.close(); await c.app.close(); cleanup(config); }
  }
  assert.deepEqual(errors, []);
  writeFileSync(resolve('.test-data/u1/sonuc.json'), JSON.stringify({ passed: true, results }, null, 2));
} finally { await browser.close(); }
