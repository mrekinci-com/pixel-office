import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { resolve } from 'node:path';
import { build } from 'vite';
import { chromium, type Page } from 'playwright';
import type { HTTPMethods } from 'fastify';
import { createApp } from '../server/app.js';
import { fakeTududi, testConfig, cleanup } from '../tests/helpers.js';
import { screenshotFixture, screenshotTasks, screenshotTerminal } from './screenshots-fixture.js';
import { translate, type Language } from '../shared/i18n/index.js';

const screens = { office: 'Ofis', director: 'Genel Müdür terminalini aç', agents: 'Ajanlar', schedules: 'Zamanlanmış görevler', tasks: 'Görevler ve notlar', approvals: 'Onay kutusu' } as const;
type Screen = keyof typeof screens;
type Capture = { screen: Screen; width: number; height: number; theme: 'light' | 'dark'; expanded: boolean; file?: string };

function options() {
  let screen: Screen = 'office', count = 7, language: Language = 'en', readme = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--screen' && args[i + 1] && Object.hasOwn(screens, args[i + 1])) screen = args[++i] as Screen;
    else if (args[i] === '--agents' && /^\d+$/.test(args[i + 1] || '')) count = Number(args[++i]);
    else if (args[i] === '--language' && ['en', 'tr'].includes(args[i + 1])) language = args[++i] as Language;
    else if (args[i] === '--readme') readme = true;
    else throw new Error("Usage: npm run screenshots -- [--screen office|director|agents|schedules|tasks|approvals] [--agents 2–30] [--language en|tr] [--readme]");
  }
  if (count < 2 || count > 30) throw new Error("Agent count must be between 2 and 30.");
  if (readme && (language !== 'en' || count < 6 || count > 8)) throw new Error("README captures require English and 6–8 sample agents.");
  return { screen, count, language, readme };
}

// Lossless PNG optimization: retain the exact pixels and all non-IDAT chunks.
function optimizePng(file: string) {
  const png = readFileSync(file), chunks: Buffer[] = [], imageData: Buffer[] = [];
  let insertAt = -1;
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), end = offset + length + 12;
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      if (insertAt < 0) insertAt = chunks.length;
      imageData.push(png.subarray(offset + 8, offset + 8 + length));
    } else chunks.push(png.subarray(offset, end));
    offset = end;
  }
  const data = deflateSync(inflateSync(Buffer.concat(imageData)), { level: 9 });
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length); chunk.write('IDAT', 4); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  chunks.splice(insertAt, 0, chunk);
  const optimized = Buffer.concat([png.subarray(0, 8), ...chunks]);
  if (optimized.length < png.length) writeFileSync(file, optimized);
  const bytes = Math.min(png.length, optimized.length);
  if (bytes >= 600_000) throw new Error(`PNG exceeds 600 KB: ${file}`);
  return bytes;
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const box = (r: DOMRect) => ({ x: r.x, y: r.y, width: r.width, height: r.height });
    const scene = document.querySelector<HTMLElement>('.office-viewport');
    const sceneBox = scene?.getBoundingClientRect();
    const viewport = { x: 0, y: 0, width: innerWidth, height: innerHeight };
    type Box = typeof viewport;
    const intersect = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    const clipped = (a: Box, b: Box): Box => ({
      x: Math.max(a.x, b.x), y: Math.max(a.y, b.y),
      width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
      height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
    });
    const visibleScene = sceneBox ? clipped(box(sceneBox), viewport) : null;
    const elements = [...document.querySelectorAll<HTMLElement>('.agent-hit,.agent-label,.agent-bubble,.department-hit,.scene-sign')].map((el, index) => {
      const style = getComputedStyle(el), bounds = box(el.getBoundingClientRect());
      const owner = el.closest<HTMLElement>('.agent-hit');
      const kind = el.classList.contains('agent-hit') ? 'karakter' : el.classList.contains('agent-label') ? 'ad-etiketi' : el.classList.contains('agent-bubble') ? 'balon' : el.classList.contains('department-hit') ? 'bolum-tabelasi' : 'sahne-tabelasi';
      let cssVisible = true;
      for (let parent: HTMLElement | null = el; parent; parent = parent.parentElement) {
        const s = getComputedStyle(parent);
        if (s.display === 'none' || s.visibility !== 'visible' || Number(s.opacity) === 0) cssVisible = false;
      }
      return {
        id: `${kind}-${index}`, kind, agent_id: owner?.dataset.agentId || null,
        box: bounds, visibility: style.visibility, display: style.display, opacity: style.opacity,
        visible: cssVisible && bounds.width > 0 && bounds.height > 0 && intersect(bounds, visibleScene || viewport),
        visibleBox: clipped(bounds, visibleScene || viewport),
        text: kind === 'karakter' ? el.getAttribute('title') || '' : el.textContent?.trim() || '',
        status: owner?.querySelector<HTMLElement>('.agent-label')?.dataset.status || null,
        tail: kind === 'balon' ? el.dataset.tail || null : null,
        seated: kind === 'karakter' ? el.dataset.seated === 'true' : null,
      };
    });
    const characters = elements.filter(e => e.kind === 'karakter');
    const signs = elements.filter(e => e.kind === 'bolum-tabelasi' || e.kind === 'sahne-tabelasi');
    // The atlas head region spans the first 22 rows (SEATED_HEAD_HEIGHT=44 / CHARACTER_SCALE=2).
    // This is a geometric head reference, not the visible hair boundary.
    const head = (a: Box) => ({ x: a.x + a.width / 2, y: a.y + a.height * 11 / 48 });
    const nearest = (p: { x: number; y: number }, b: Box) => ({ x: Math.max(b.x, Math.min(p.x, b.x + b.width)), y: Math.max(b.y, Math.min(p.y, b.y + b.height)) });
    const cutsSegment = (start: { x: number; y: number }, end: { x: number; y: number }, b: Box) => {
      let lo = 0, hi = 1;
      for (const axis of ['x', 'y'] as const) {
        const d = end[axis] - start[axis], min = b[axis], max = min + (axis === 'x' ? b.width : b.height);
        if (d === 0) { if (start[axis] < min || start[axis] > max) return false; }
        else { const t1 = (min - start[axis]) / d, t2 = (max - start[axis]) / d; lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2)); }
      }
      return lo <= hi && hi > 0 && lo < 1;
    };
    const relationships = elements.filter(e => e.kind === 'balon').map(bubble => {
      const owner = characters.find(a => a.agent_id === bubble.agent_id)!;
      const ownerHead = head(owner.box), point = nearest(ownerHead, bubble.box);
      const present = bubble.display !== 'none' && !!bubble.text && bubble.box.width > 0 && bubble.box.height > 0;
      const overlapping = present ? signs.filter(s => s.visible && intersect(bubble.box, s.box)) : [];
      const between = present ? signs.filter(s => s.visible && cutsSegment(ownerHead, point, s.box)) : [];
      return {
        bubble_id: bubble.id, owner_id: owner.id, agent_id: bubble.agent_id,
        headReference: ownerHead, nearestBubblePoint: present ? point : null,
        headDistancePx: present ? Math.hypot(point.x - ownerHead.x, point.y - ownerHead.y) : null,
        overlapsSign: overlapping.length > 0, overlappingSigns: overlapping.map(s => s.id),
        signBetweenOwnerAndBubble: between.length > 0, signsBetween: between.map(s => s.id),
      };
    });
    // Crop at integer CSS pixels so PNG dimensions are exactly doubled.
    const crop = visibleScene ? {
      x: Math.ceil(visibleScene.x), y: Math.ceil(visibleScene.y),
      width: Math.floor(visibleScene.x + visibleScene.width) - Math.ceil(visibleScene.x),
      height: Math.floor(visibleScene.height / 2),
    } : null;
    const stage=document.querySelector<HTMLElement>('.pixel-stage')?.getBoundingClientRect();
    const scale=Number(scene?.dataset.scale);
    return { layout:scene?.dataset.layout, scale, stage:stage ? box(stage) : null, fill:stage && sceneBox ? {width:stage.width/sceneBox.width,height:stage.height/sceneBox.height,shortSide:sceneBox.width<sceneBox.height ? stage.width/sceneBox.width : stage.height/sceneBox.height} : null, viewport, scene: sceneBox ? box(sceneBox) : null, crop, elements, relationships };
  });
}

async function main() {
  const { screen, count, language, readme } = options();
  const tx = (key: string) => translate(language, key);
  const captures: Capture[] = readme ? [
    { screen: 'office', width: 1600, height: 900, theme: 'dark', expanded: false, file: 'office.png' },
    { screen: 'office', width: 1600, height: 900, theme: 'light', expanded: true, file: 'office-expanded.png' },
    { screen: 'director', width: 1600, height: 900, theme: 'dark', expanded: false, file: 'director.png' },
    { screen: 'agents', width: 1600, height: 900, theme: 'dark', expanded: false, file: 'agents.png' },
    { screen: 'tasks', width: 1600, height: 900, theme: 'dark', expanded: false, file: 'tasks.png' },
  ] : [1920, 1366, 1280, 390].flatMap((width, i) => (['light', 'dark'] as const).flatMap(theme =>
    (screen === 'office' ? [false, true] : [false]).map(expanded => ({ screen, width, height: [1000, 768, 640, 844][i], theme, expanded }))));
  const started = Date.now(), root = resolve('.'), work = process.env.SCREENSHOTS_WORK_DIR;
  if (!work) throw new Error("Run this script with npm run screenshots.");
  const output = resolve(readme ? '../docs/images' : '.test-data/screenshots');
  if (!readme) rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  console.log("Preparing a temporary screenshot build…");
  const staticDir = resolve(work, 'client');
  await build({ root, configLoader: 'runner', envFile: false, cacheDir: resolve(work, 'vite-cache'), logLevel: 'warn', build: { outDir: staticDir, emptyOutDir: true } });
  const config = testConfig(language), fake = fakeTududi();
  const { app } = await createApp(config, { fetcher: fake.fetcher, staticDir, background: false });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const measurements = [];
  let injected = 0, blocked = 0;
  try {
    try {
      browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'],
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], downloadsPath: work, timeout: 15000 });
    } catch {
      throw new Error("Could not launch the browser. Check Chromium in .cache/browsers and libraries in .cache/system-libs/usr/lib/x86_64-linux-gnu. The script downloads nothing.");
    }
    for (const capture of captures) {
      const { width, height, theme, expanded, screen } = capture, label = theme;
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, locale: language === 'en' ? 'en-US' : 'tr-TR', timezoneId: 'UTC', colorScheme: 'light', reducedMotion: 'reduce', serviceWorkers: 'block' });
      const snapshot = screenshotFixture(count, language);
      try {
        await context.addInitScript({ content: `window.__name = value => value;
          localStorage.setItem('po-tema', ${JSON.stringify(theme)});
          localStorage.setItem('po-language', ${JSON.stringify(language)});
          localStorage.setItem('po-gm-window', 'hidden');
          localStorage.setItem('po-gm-geometry', JSON.stringify({
            x: Math.min(380, Math.max(12, innerWidth - 1100)), y: 82,
            width: Math.min(1080, innerWidth - 24), height: Math.min(732, innerHeight - 100),
          }));
          localStorage.setItem('po-sohbet-oran', '36');
          // A fulfilled, finite SSE response would immediately disconnect. Keep
          // the sample live feed open in memory; no network connection is made.
          window.EventSource = class extends EventTarget {
            static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
            readyState = 1;
            constructor(url) {
              super();
              if (url !== '/api/live') throw new Error('Unexpected sample event feed.');
              setTimeout(() => this.dispatchEvent(new Event('ready')), 0);
            }
            close() { this.readyState = 2; }
          };
          { let seed = 17; Math.random = () => (seed = Math.imul(seed, 16807) >>> 0) / 4294967296; }
          { const OriginalDate = Date; globalThis.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : ['2026-10-13T12:00:00Z'])); } static now() { return 1791892800000; } }; }
          performance.now = () => 10000;
          { const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => raf(() => cb(10000)); }
          { const interval = window.setInterval.bind(window); window.setInterval = (cb, ms, ...args) => interval(cb, ms === 5000 ? 2147483647 : ms, ...args); }` });
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const errors: string[] = [];
        let terminalOutput = false;
        await context.routeWebSocket('**/*', socket => {
          if (new URL(socket.url()).pathname !== '/api/director/terminal/socket') { blocked++; socket.close(); return; }
          socket.send(JSON.stringify({ type: 'status', terminal: { enabled: true, status: 'waiting', generation: 1, usageKnown: true, runner: 'codex' } }));
          // Wait for xterm's fit/resize before streaming the sample session.
          socket.onMessage(() => {
            if (terminalOutput) return;
            terminalOutput = true;
            socket.send(JSON.stringify({ type: 'output', data: screenshotTerminal(language) }));
          });
        });
        page.on('pageerror', error => errors.push(error.message));
        await context.route('**/*', async route => {
          const req = route.request(), url = new URL(req.url());
          if (url.origin !== 'http://ofis.test') { blocked++; await route.abort(); return; }
          if (url.pathname === '/api/language') { await route.fulfill({ json: { language } }); return; }
          if (/^\/api\/agents\/sample-agent-\d+\/tududi$/.test(url.pathname)) { await route.fulfill({ json: screenshotTasks(language) }); return; }
          if (url.pathname === '/api/director') {
            await route.fulfill({ json: { director: snapshot.runtime!.director, agent: snapshot.agents[0], session: { turns: 1 }, logs: [], has_older: false } }); return;
          }
          if (url.pathname === '/api/director/read') { await route.fulfill({ json: { read: 0 } }); return; }
          if (url.pathname === '/api/director/terminal/ticket') { await route.fulfill({ json: { ticket: 'sample-ticket' } }); return; }
          if (url.pathname === '/api/snapshot') { await route.fulfill({ json: snapshot }); return; }
          if (url.pathname === '/api/live') {
            await route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\nevent: ready\ndata: {}\n\n' }); return;
          }
          const result = await app.inject({ method: req.method() as HTTPMethods, url: url.pathname + url.search, headers: { ...(await req.allHeaders()), host: url.host }, payload: req.postData() || undefined,
            remoteAddress: `192.0.2.${(width === 1920 ? 1 : width === 1366 ? 3 : 5) + Number(theme === 'dark')}` });
          injected++;
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(result.headers)) if (value !== undefined) headers[key] = Array.isArray(value) ? value.join('\n') : String(value);
          await route.fulfill({ status: result.statusCode, headers, body: result.rawPayload });
        });
        await page.goto('http://ofis.test');
        await page.getByLabel(tx('Sahip şifresi')).fill(config.ownerPassword);
        await page.getByRole('button', { name: tx('Ofisi aç'), exact: true }).click();
        if(width>900) await page.getByRole('heading', { name: tx('Piksel Ofis'), exact: true }).waitFor();
        else await page.locator('.office-scene').waitFor({state:'visible'});
        await page.locator('.art-loading').waitFor({ state: 'hidden' });
        await page.evaluate(async () => {
          await Promise.all(['Figtree', 'Bricolage Grotesque', 'Tiny5', 'JetBrains Mono'].map(name => document.fonts.load(`16px "${name}"`, 'İığşöüç')));
          await document.fonts.ready;
        });
        await page.waitForFunction(({count,bubbles}) => document.querySelectorAll('.agent-hit[data-x]').length === count &&
          [...document.querySelectorAll('.agent-hit .agent-bubble')].filter(e => e.textContent?.trim()).length >= bubbles, {
            count: snapshot.agents.filter(a => a.builtin !== 'director').length,
            bubbles: snapshot.agents.filter(a => a.builtin !== 'director' && (a.status === 'calisiyor' || a.status === 'bekliyor')).length,
          });
        if (screen === 'director') await page.keyboard.press('Control+Shift+G');
        else if (screen !== 'office') {
          if (width > 900) await page.locator('.rail nav').getByRole('button', { name: tx(screens[screen]), exact: true }).click();
          else if (screen === 'agents' || screen === 'tasks') {
            await page.locator('.tabbar').getByRole('button', { name: tx(screen === 'tasks' ? 'Görevler' : screens[screen]), exact: true }).click();
          } else {
            await page.locator('.tabbar').getByRole('button', { name: tx('Diğer'), exact: true }).click();
            await page.getByRole('dialog').getByRole('button', { name: tx(screens[screen]), exact: true }).click();
          }
        }
        if (screen === 'agents') await page.locator('.agents-table tbody tr').last().waitFor();
        if (screen === 'tasks') {
          await page.locator('.tududi-toolbar select').selectOption(snapshot.agents[1].id);
          await page.getByRole('button', { name: screenshotTasks(language).tasks[0].name, exact: true }).waitFor();
        }
        if (screen === 'director') {
          await page.getByRole('dialog', { name: tx('Genel Müdür terminali'), exact: true }).waitFor();
          await page.waitForFunction(() => document.querySelector('.gm-xterm')?.textContent?.includes('› '));
        }
        await page.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') !== 'true');
        // Allow the last two camera and font measurement frames to finish.
        await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
        if(expanded) { await page.getByRole('button',{name:tx('Büyüt'),exact:true}).click(); await page.getByRole('button',{name:tx('Sığdır'),exact:true}).click(); }
        if (screen === 'office' || screen === 'director') await page.waitForFunction(()=>{const v=document.querySelector<HTMLElement>('.office-viewport'),c=document.querySelector<HTMLElement>('.office-canvas');return v && c && c.dataset.renderedCols===v.dataset.cols && c.dataset.renderedRows===v.dataset.rows;});
        await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
        const file = capture.file || `${screen}-${width}-${label}${expanded ? '-expanded' : ''}.png`;
        const measurement = await measure(page);
        await page.screenshot({ path: resolve(output, file), scale: 'css', animations: 'disabled' });
        const pngBytes = readme ? optimizePng(resolve(output, file)) : undefined;
        if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
        if (await page.locator('html').getAttribute('lang') !== language) throw new Error('Incorrect interface language.');
        if (readme) {
          const visibleText = await page.locator('body').innerText();
          if (/[çğıöşüÇĞİÖŞÜ]|Not connected|Runner disconnected/.test(visibleText)) throw new Error('Unexpected language or disconnected runner.');
          if (await page.locator('[role=alert]').count()) throw new Error('Unexpected alert in publication capture.');
        }
        let closeup: string | null = null;
        if (screen === 'office' && !readme) {
          if (!measurement.crop || measurement.crop.width <= 0 || measurement.crop.height <= 0) throw new Error("Could not capture a close-up because the office scene was not found.");
          closeup = `${screen}-${width}-${label}${expanded ? '-expanded' : ''}-closeup.png`;
          await page.screenshot({ path: resolve(output, closeup), clip: measurement.crop, scale: 'device', animations: 'disabled' });
          const lowerCrop={...measurement.crop,y:measurement.crop.y+measurement.crop.height};
          await page.screenshot({path:resolve(output,`${screen}-${width}-${label}${expanded ? '-expanded' : ''}-rooms-closeup.png`),clip:lowerCrop,scale:'device',animations:'disabled'});
        }
        measurements.push({ file, closeup, language, pngBytes, theme: label, agents: count, ...measurement, browserErrors: errors });
        console.log(`Captured: ${file}${closeup ? ` and ${closeup}` : ''}`);
      } finally { await context.close(); }
    }
    writeFileSync(resolve(readme ? '.test-data' : output, readme ? 'readme-screenshots.json' : 'measurements.json'), JSON.stringify({
      screen, language, readme, syntheticDataOnly: true, demo: false, elapsedMs: Date.now() - started, browser: browser.version(),
      transport: { method: 'Fastify inject; no listening port', injectedRequests: injected, blockedExternalRequests: blocked, fakeTududiRequests: fake.calls.length },
      coordinateSystem: 'Ekranın sol üstünden başlayan CSS pikseli; yakın görüntüler bu ölçülerin 2 katıdır.',
      headReference: 'Karakter kutusunun yatay ortası, atlasın ilk 22 satırlık baş bölgesinin ortası. Görünür saç pikselleri ölçülmez.',
      relationshipMethod: 'Baş referansından balon kutusunun en yakın noktasına uzaklık; aynı doğru parçasını kesen görünür tabela aradadır. Kesişim kutularla hesaplanır, görsel yargı verilmez.',
      captures: measurements,
    }, null, 2) + '\n');
    if (!readme) writeFileSync(resolve(output, 'README.md'), `# Ekran görüntüleri\n\nBu klasör her çalıştırmada temizlenir. Bütün ekranlar sahte verilerle hazırlanır; canlı ofis verisi veya gerçek model çağrısı yoktur. Bağlantı ve terminal akışı tarayıcıda taklit edilir.\n\n- \`${screen}-1920-*.png\`: 1920×1000 ekran.\n- \`${screen}-1280-*.png\`: 1280×640 ekran.\n- \`light\` ve \`dark\`: iki tema.\n- \`*-closeup.png\`: ofis sahnesinin ekranda görünen üst yarısı, 2× çözünürlük.\n- \`measurements.json\`: her görüntünün balon, ad etiketi, bölüm/sahne tabelası ve karakter kutuları; CSS görünürlüğü, metni, ekranda kalan kutusu ve balon-sahip ilişkileri. Baş uzaklığı geometrik bir baş referansına göre ölçülür; gerçek saç pikseli değildir. Boş/gizli balonlarda uzaklık \`null\` olur.\n\nÖnce normal görüntüye, ayrıntı için yakın görüntüye bakın. JSON'da \`captures\` içinden aynı \`file\` adını bulun. \`elements\` öğeleri \`id\` ve \`agent_id\` ile, \`relationships\` ilişkileri bu kimliklerle eşleşir. \`headDistancePx\` CSS pikselidir; \`overlapsSign\` kutu kesişimini, \`signBetweenOwnerAndBubble\` baş-balona giden doğru üzerinde tabela olup olmadığını gösterir. Yakın görüntü koordinatı: (ekran koordinatı − \`crop\` başlangıcı) × 2. CSS \`visibility\` tek başına ekranda görünmeyi kanıtlamaz; \`visible\` ve \`visibleBox\` da okunmalıdır. Bunlar örtülme/piksel analizi değildir.\n\nDeneme saati, ilk ajan durumları ve animasyon anı sabitlenir. Görsel kusur varsa da görüntüler üretilebildiğinde çıkış 0'dır; betik kabul/ret vermez.\n\nÇalıştırma: \`cd office && npm run screenshots\`. Başka ekran: \`npm run screenshots -- --screen office|director|agents|schedules|tasks|approvals\` (birini seçin). Kalabalık: \`npm run screenshots -- --agents 14\`. Dil: \`npm run screenshots -- --language en|tr\` (varsayılan en). README görüntüleri: \`npm run screenshots -- --readme\`. Yerel tarayıcı ve kitaplıklar \`.cache\` altında önceden hazır olmalıdır; ağ, ev klasörü ve Docker gerekmez. Komut bağlantısına yazma yetkisi gerekir. Vite derlemesi/önbelleği ve tarayıcı geçici dosyaları depo içindeki \`.test-data\` dizinine alınır ve bitince silinir.\n`);
    console.log(`Screenshots ready: ${output} (${((Date.now() - started) / 1000).toFixed(1)} seconds).`);
  } finally { await browser?.close(); await app.close(); cleanup(config); }
}

try { await main(); }
catch (error) { console.error(`Screenshot capture failed: ${error instanceof Error ? error.message : 'Unexpected error.'}`); process.exitCode = 1; }
