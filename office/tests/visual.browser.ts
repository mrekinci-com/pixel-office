import {
  mkdirSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import { createApp } from "../server/app.js";
import { testConfig, fakeTududi, cleanup } from "./helpers.js";
import { demoSnapshot } from "../src/demo.js";
import { defaultSettings, defaultPolicy } from "../shared/runtime.js";
import type { Snapshot } from "../shared/types.js";
import {
  auditPage,
  auditFocus,
  auditSeats,
  auditAnnotations,
  auditInteractiveFocus,
} from "./visual.audit.js";
import { auditSeatVariants, installSeatProbe } from "./seated.browser.js";
import { longChatFixture } from "./chat.fixture.js";
import { auditScrollbars } from "./chat.audit.js";

const updating = process.argv.includes("--update-baselines");
const filter = process.env.VISUAL_FILTER;
const cache = resolve(".cache/runtime");
mkdirSync(cache, { recursive: true });
process.env.TMPDIR = cache;
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(".cache/browsers");
const { chromium } = await import("playwright");
const config = testConfig(),
  fake = fakeTududi();
const { app } = await createApp(config, { fetcher: fake.fetcher });
const browser = await chromium.launch({
  headless: true,
  ignoreDefaultArgs: ["--hide-scrollbars"],
  args: ["--no-sandbox"],
  downloadsPath: cache,
  env: {
    ...process.env,
    LD_LIBRARY_PATH: [
      resolve(".cache/system-libs/usr/lib/x86_64-linux-gnu"),
      process.env.LD_LIBRARY_PATH,
    ]
      .filter(Boolean)
      .join(":"),
  },
});
const baseline = resolve("tests/__screenshots__"),
  current = resolve(".test-data/visual/current");
mkdirSync(baseline, { recursive: true });
mkdirSync(current, { recursive: true });
mkdirSync(resolve(".test-data/screenshots"), { recursive: true });
const empty: Snapshot = {
  departments: [],
  agents: [],
  messages: [],
  events: [],
  handoffs: [],
  rules: "",
};
const seed = demoSnapshot(empty, 0);
const fixture: Snapshot = {
  ...seed,
  departments: seed.departments.slice(0, 3),
  agents: seed.agents.map((a, i) => ({
    ...a,
    department_id: seed.departments[Math.floor(i / 2)].id,
    tududi_state: "ready",
    session_mode:"work",
    prompt: "Kaynakları karşılaştır ve sonucu sade bir dille yaz.",
  })),
  messages: [
    {
      id: "visual-message",
      sender_agent_id: null,
      sender_type: "user",
      recipient_type: "everyone",
      recipient_id: null,
      text: "Bugünkü işleri birlikte gözden geçirelim.",
      created_at: "2026-10-10T10:00:00Z",
      read_at: null,
      read_by: ["owner"],
    },
    {
      id: "visual-unread",
      sender_agent_id: seed.agents[0].id,
      sender_type: "agent",
      recipient_type: "everyone",
      recipient_id: null,
      text: "İlk notlar hazır.",
      created_at: "2026-10-10T10:01:00Z",
      read_at: null,
      read_by: [],
    },
  ],
  events: [
    {
      id: "visual-event",
      agent_id: seed.agents[0].id,
      department_id: seed.departments[0].id,
      kind: "agent_event",
      text: "Çalışmaya başladım; ilk notlarımı hazırlıyorum.",
      created_at: "2026-10-10T10:00:00Z",
    },
  ],
  runtime: {
    connected: true,
    paused: false,
    models: { claude: ["sonnet", "opus", "fable"], codex: ["gpt-6.1-sol"] },
    settings: {...defaultSettings, language: 'tr' as const},
    sessions:[{agent_id:'demo-0',session_key:'demo-0:work:visual-work',work_item_id:'visual-work',runner:'codex',generation:1,provider_id:'11111111-1111-4111-8111-111111111111',created_at:'2026-10-10T10:00:00Z',turns:6,input_tokens:12450,cached_input_tokens:9000,last_input_tokens:11000,renewals:2,bytes:24000,rules_hash:'',renewing:false}],
    runs: [
      {
        id: "visual-run",
        work_item_id:"visual-work",
        agent_id: "demo-0",
        chain_id: "visual-chain",
        depth: 0,
        trigger: "Kullanıcı mesajı",
        summary: "Kaynakları incele ve sonucu paylaş.",
        conversation_type: "agent",
        conversation_id: "demo-0",
        state: "running",
        created_at: "2026-10-10T10:00:00Z",
        started_at: "2026-10-10T10:00:00Z",
        finished_at: null,
        output: "İlk kaynakları karşılaştırıyorum.",
        reason: "",
        calls: 2,
        retry: 0,
        duration_ms: 12000,
        usage: { input_tokens: 120, output_tokens: 40 },
      },
    ],
    approvals: [
      {
        id: "visual-approval",
        agent_id: "demo-2",
        run_id: "visual-run",
        title: "Hazırlanan dosyaları paylaşma onayı",
        detail:
          "Dosyalar kendi çalışma klasörümde hazır. Paylaşmadan önce görüşünüzü istiyorum.",
        type: "dosya",
        state: "pending",
        note: "",
        created_at: "2026-10-10T10:00:00Z",
        decided_at: null,
        link_id: "visual-link",
        files: [
          {
            path: "sonuc.md",
            content: "",
            before_hash: null,
            after_hash: "a".repeat(64),
            diff: "sonuc.md\n--- Önce\nBoş dosya\n+++ Sonra\nİlk inceleme tamamlandı.",
          },
        ],
      },
    ],
    links: [
      {
        id: "visual-link",
        name: "Ortak belgeler",
        path: "/izinli-klasor/belgeler",
        access: "write",
        approved_write: true,
        agent_ids: ["demo-0", "demo-2"],
        validation: "valid",
        detail: "Klasör yolu doğrulandı.",
      },
    ],
    artifacts: [
      {
        id: "visual-artifact",
        agent_id: "demo-0",
        run_id: "visual-run",
        title: "İlk sonuç",
        summary: "Kaynaklardan derlenen kısa sonuç.",
        name: "sonuc.md",
        mime: "text/markdown",
        size: 64,
        created_at: "2026-10-10T10:00:00Z",
      },
    ],
    activity: [
      {
        id: 1,
        run_id: "visual-run",
        kind: "tool",
        text: "tududi_not_yaz: Toplantı notları",
        created_at: "2026-10-10T10:00:00Z",
      },
    ],
  },
  rules:
    "Kaynakları belirt. Bilinmeyenleri açıkça yaz. İşleri birlikte gözden geçir.",
};
const remote = {
  projects: [
    {
      uid: "visual-project",
      name: "Yeni proje",
      description: "Ekibin ortak çalışma alanı.",
    },
  ],
  tasks: [
    {
      uid: "visual-task",
      name: "Kaynakları incele",
      description: "Notları karşılaştır ve kısa bir sonuç yaz.",
      status: 1,
    },
    { uid: "visual-task-2", name: "Sonucu paylaş", status: 0 },
  ],
  notes: [
    {
      uid: "visual-note",
      title: "Toplantı notları",
      content: "Kaynaklar birlikte incelendi. Sonuçlar ekiple paylaşılacak.",
    },
  ],
};
const measurements: unknown[] = [],
  files: string[] = [],
  problems: string[] = [];
let count = 0;
try {
  await Promise.all([
    [1920, 1080],
    [1366, 768],
    [1280, 640],
    [390, 844],
  ].map(async ([width, height]) => {
    for (const theme of ["light", "dark"] as const) {
      const suffix = `${width}x${height}-${theme === "light" ? "aydinlik" : "koyu"}`;
      if (filter && !suffix.includes(filter) && !filter.startsWith("a2-2")) continue;
      let snapshot = structuredClone(fixture);
      let showContextEstimate = false;
      // Separate browser contexts represent separate clients; production login limits stay intact.
      const testAddress = `192.0.2.${1 + [1920, 1366, 1280, 390].indexOf(width) * 2 + Number(theme === "dark")}`;
      const context = await browser.newContext({
        viewport: { width, height },
        locale: "tr-TR",
        timezoneId: "UTC",
        deviceScaleFactor: 2,
        colorScheme: "light",
        reducedMotion: "reduce",
      });
      // Small function-name helper serialized into the browser by tsx.
      await context.addInitScript({
        content: "window.__name = (value) => value; { const NativeEventSource = EventSource; window.__visualStreams = []; window.EventSource = class extends NativeEventSource { constructor(...args) { super(...args); window.__visualStreams.push(this); } }; }",
      });
      await context.addInitScript({
        content:
          "{ const OriginalDate = Date; globalThis.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : ['2026-10-10T12:00:00Z'])); } static now() { return 1791633600000; } }; }",
      });
      await context.addInitScript(
        ({ theme }) => {
          localStorage.setItem("po-tema", theme);
          let seed = 17;
          Math.random = () => {
            seed = Math.imul(seed, 16807) >>> 0;
            return seed / 4294967296;
          };
          const state = window as unknown as { visualTime: number };
          state.visualTime = 10000;
          performance.now = () => state.visualTime;
          const request = window.requestAnimationFrame.bind(window);
          window.requestAnimationFrame = (callback) =>
            request(() => callback(state.visualTime));
        },
        { theme },
      );
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on("pageerror", (e) => problems.push(e.message));
      await context.route("**/*", async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (url.origin !== "http://ofis.test") {
          problems.push(`External request: ${url.origin}`);
          await route.abort();
          return;
        }
        if (/^\/api\/agents\/[^/]+\/session$/.test(url.pathname)) {
          const agent=snapshot.agents.find(a=>a.id===url.pathname.split('/')[3]) || snapshot.agents[0];
          await route.fulfill({json:{session:{...fixture.runtime!.sessions![0],agent_id:agent.id,runner:agent.runner},logs:[{id:1,run_id:'visual-run',kind:'input',text:'Kaynakları karşılaştır ve kısa iş notunu güncelle.'},{id:2,run_id:'visual-run',kind:'text',text:'İlgili bilgi notunu okuyorum. Önceki kararın tarihi doğrulandı.'},{id:3,run_id:'visual-run',kind:'tool',text:'tududi_not_oku: Kararlar'},{id:4,run_id:'visual-run',kind:'command_result',text:'Testler: çıkış 0\n12 test geçti.'},{id:5,run_id:'visual-run',kind:'text',text:'İş notu güncellendi. İncelemeye hazır.'}],runs:snapshot.runtime!.runs}});return;
        }
        if(url.pathname==='/api/usage/details'){await route.fulfill({json:{expensive:snapshot.runtime!.runs,sessions:[{agent_id:snapshot.agents[0].id,session_key:"visual-session",input_tokens:12450,cached_input_tokens:9000,average_tokens:2075,average_cached_tokens:1500,average_uncached_tokens:575,renewals:2}],days:[{agent_id:snapshot.agents[0].id,day:'2026-10-10',input_tokens:12450,cached_input_tokens:9000,uncached_input_tokens:3450,output_tokens:920}]}});return;}
        if(url.pathname==='/api/summaries'){await route.fulfill({json:[{day:'2026-10-10',text:'Deniz: 3 iş bitti, 1 başarısız, 1 bekleyen.\n12.450 girdi token; 180 saniye.\nBekleyen onay: 1.\nEn pahalı iş: Kaynakları incele.',published:true}]});return;}
        if(url.pathname==='/api/shared-notebook'){await route.fulfill({json:[{id:'visual-shared',title:'Şirket kararları',content:'2026-10-10: Kaynaklar tarihleriyle kaydedilir. Deneme sonuçları canlı sonuçlardan ayrı tutulur.',locked:1,invalid:0}]});return;}
        if (url.pathname === "/api/usage") {
          await route.fulfill({
            json: snapshot.agents.map((a) => ({
              id: a.id,
              name: a.name,
              runs: 3,
              duration_ms: 180000,
              failed: 1,
              input_tokens: 12000,cached_input_tokens:9000,uncached_input_tokens:3000,average_tokens:4000,average_cached_tokens:3000,average_uncached_tokens:1000, output_tokens: 900, total_tokens: 12900, average_ms: 45000,
            })),
          });
          return;
        }
        if (url.pathname.endsWith("/memory")) {
          await route.fulfill({
            json: { text: "Kaynakları tarihleriyle birlikte kaydet." },
          });
          return;
        }
        if (url.pathname.startsWith("/api/runs/")) {
          await route.fulfill({
            json: {
              run: snapshot.runtime!.runs[0],
              logs: [
                {
                  id: 1,
                  run_id: "visual-run",
                  kind: "tool",
                  text: "tududi_not_yaz: Toplantı notları",
                  created_at: "2026-10-10T10:00:00Z",
                },
                { id: 2, run_id: "visual-run", kind: "context", text: showContextEstimate ? JSON.stringify({ karakter: 4200, tahmini_token: 1050, en_buyuk_uc: [{ ad: "İş ve sohbet bağlamı", karakter: 1600, tahmini_token: 400 }, { ad: "Yetki ve onay sınırları", karakter: 1200, tahmini_token: 300 }, { ad: "Şirket rehberi", karakter: 800, tahmini_token: 200 }] }) : "Talimat ve bağlam: 4200 karakter, 4680 bayt", created_at: "2026-10-10T10:00:00Z" },
                { id: 3, run_id: "visual-run", kind: "diagnostic", text: "Yapılandırma hatası: bilinmeyen ayar. Anahtar: [gizlendi]", created_at: "2026-10-10T10:00:00Z" },
              ],
            },
          });
          return;
        }
        if (url.pathname.endsWith("/download")) {
          if (snapshot.runtime?.artifacts[0].mime === "image/png") {
            await route.fulfill({
              headers: { "content-type": "image/png" },
              body: readFileSync(resolve("public/assets/character-atlas.png")),
            });
            return;
          }
          await route.fulfill({
            headers: { "content-type": "text/markdown" },
            body: "# İlk sonuç\n\nKaynaklar karşılaştırıldı.",
          });
          return;
        }
        if (url.pathname === "/api/snapshot") {
          await route.fulfill({ json: snapshot });
          return;
        }
        if (url.pathname === "/api/live") {
          await route.fulfill({
            headers: { "content-type": "text/event-stream" },
            body: "retry: 60000\nevent: ready\ndata: {}\n\n",
          });
          return;
        }
        if (/^\/api\/agents\/[^/]+\/tududi$/.test(url.pathname)) {
          await route.fulfill({ json: remote });
          return;
        }
        if (/^\/api\/messages\/[^/]+\/read$/.test(url.pathname)) {
          await route.fulfill({ json: { ok: true } });
          return;
        }
        if (url.pathname === "/api/messages" && request.method() === "POST") {
          const body = request.postDataJSON();
          const message = {
            ...snapshot.messages[0],
            ...body,
            id: `visual-send-${snapshot.messages.length}`,
            created_at: "2026-10-10T12:00:00Z",
          };
          snapshot.messages.push(message);
          await route.fulfill({ json: message });
          return;
        }
        const response = await app.inject({
          remoteAddress: testAddress,
          method: request.method() as any,
          url: url.pathname + url.search,
          headers: { ...(await request.allHeaders()), host: url.host },
          payload: request.postData() || undefined,
        });
        if (response.statusCode >= 400 && url.pathname !== "/api/session")
          problems.push(
            `Request failed: ${url.pathname} ${response.statusCode}`,
          );
        const headers = Object.fromEntries(
          Object.entries(response.headers)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, Array.isArray(v) ? v.join("\n") : String(v)]),
        );
        await route.fulfill({
          status: response.statusCode,
          headers,
          body: response.rawPayload,
        });
      });
      const settle = async () => {
        await page.evaluate(async () => {
          await document.fonts.ready;
        });
        await page.waitForTimeout(80);
        await page.evaluate(() => {
          (window as unknown as { visualTime: number }).visualTime += 100;
        });
        await page.waitForFunction(() => {
          const c = document.querySelector<HTMLCanvasElement>(".office-canvas");
          const v = document.querySelector<HTMLElement>(".office-viewport");
          return (
            !c ||
            !v ||
            !v.offsetWidth ||
            !v.offsetHeight ||
            getComputedStyle(v).visibility === "hidden" ||
            (c.dataset.renderedAt ===
              String(
                (window as unknown as { visualTime: number }).visualTime,
              ) &&
              c.dataset.renderedCols === v.dataset.cols &&
              c.dataset.renderedRows === v.dataset.rows)
          );
        });
      };
      const capture = async (name: string, closeup?: string) => {
        if (filter?.startsWith("a2-2") && !name.startsWith(filter)) return;
        // Opening a chat can still be saving its read receipts. During that
        // request the compose field is disabled, so wait before testing focus.
        await page.waitForFunction(() => document.querySelector("main")?.getAttribute("aria-busy") !== "true");
        // When measuring the transient new-message button, focusing links outside
        // history changes the reading position and naturally hides the button.
        const focusKinds = name === "a2-4-yeni-mesaj"
          ? (await auditFocus(page.locator(".new-messages")), ["button"])
          : await auditInteractiveFocus(page);
        await settle();
        // Request a full redraw after scrolling/focus changes to remove tile-cache
        // effects from the comparison.
        // Preserve focus, final position and comparison thresholds.
        await page.evaluate(async () => {
          const root=document.documentElement,previous=root.style.transform;
          const frame=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
          root.style.transform='translate(1px, 1px)';await frame();
          root.style.transform=previous;await frame();
        });
        // Focus restoration invalidates paint even on pages without a canvas.
        // Wait for two real animation frames before comparing pixels; thresholds stay unchanged.
        await page.evaluate(() => new Promise<void>((done) => {
          requestAnimationFrame(() => requestAnimationFrame(() => done()));
        }));
        measurements.push({
          name,
          width,
          height,
          theme,
          focusKinds,
          ...(await auditPage(page)),
          scrolling: await auditScrollbars(page),
        });
        if (await page.locator(".office-viewport").count())
          await auditAnnotations(page, snapshot);
        const file = `${name}-${suffix}.png`,
          path = resolve(current, file);
        // After focus changes, the text layer may need one more capture to settle.
        // Record only two consecutive identical images.
        const options = { animations: "disabled", scale: "css", caret: "hide" } as const;
        let shot = await page.screenshot(options), stable = false;
        for (let attempt = 0; attempt < 8; attempt++) {
          await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
          const next = await page.screenshot(options);
          if (shot.equals(next)) { stable = true; break; }
          shot = next;
        }
        assert.ok(stable, `Screenshot rendering must stabilize: ${file}`);
        writeFileSync(path, shot);
        files.push(file);
        count++;
        if (updating) copyFileSync(path, resolve(baseline, file));
        if (!process.env.VISUAL_SKIP_CONVENIENCE && (width === 1920 || (width === 390 && name.startsWith("telefon"))))
          copyFileSync(
            path,
            resolve(
              `.test-data/screenshots/${name}-${theme === "light" ? "aydinlik" : "koyu"}.png`,
            ),
          );
        if (closeup) {
          const region = page.locator(closeup).first();
          const zoom = `${name}-yakin-2x-${suffix}.png`;
          if (closeup.includes("agent-hit")) {
            const world = await (
              await import("./layout.browser.js")
            ).sceneWorld(page, snapshot);
            const id = await region.getAttribute("data-agent-id");
            const desk = world.desks.find((d) => d.agentId === id)!;
            const island = world.furniture.find((f) => f.id === desk.islandId)!;
            const stage = (await page.locator(".pixel-stage").boundingBox())!;
            const scale = Number(
              await page.locator(".office-viewport").getAttribute("data-scale"),
            );
            await page.screenshot({
              path: resolve(current, zoom),
              scale: "device",
              animations: "disabled",
              caret: "hide",
              clip: {
                x: stage.x + island.x * 16 * scale,
                y: stage.y + (island.y - 3) * 16 * scale,
                width: island.w * 16 * scale,
                height: 12 * 16 * scale,
              },
            });
          } else
            await region.screenshot({
              path: resolve(current, zoom),
              scale: "device",
              animations: "disabled",
              caret: "hide",
            });
          files.push(zoom);
          count++;
          if (updating)
            copyFileSync(resolve(current, zoom), resolve(baseline, zoom));
        }
      };
      const nav = async (label: string) => {
        if (width > 900) {
          await page
            .getByRole("navigation", { name: "Ana gezinme", exact: true })
            .getByRole("button", { name: label, exact: true })
            .click();
        } else if (
          ["Ofis", "Ajanlar", "Görevler ve notlar", "Olaylar"].includes(label)
        ) {
          await page
            .getByRole("navigation", { name: "Telefon gezinmesi" })
            .getByRole("button", {
              name: label === "Görevler ve notlar" ? "Görevler" : label,
              exact: true,
            })
            .click();
        } else {
          await page
            .getByRole("button", { name: "Diğer", exact: true })
            .click();
          await page
            .getByRole("dialog")
            .getByRole("button", { name: label, exact: true })
            .click();
        }
        await settle();
      };
      const office = async () => {
        await nav("Ofis");
        if (width <= 900)
          await page.getByRole("tab", { name: "Ofis", exact: true }).click();
        await page.locator(".art-loading").waitFor({ state: "hidden" });
        await settle();
        await auditSeats(page, snapshot);
      };
      const chat = async () => {
        if (width <= 900)
          await page.getByRole("tab", { name: "Sohbet", exact: true }).click();
      };
      const fields = async (selector: string) => {
        const all = page.locator(selector);
        for (let i = 0; i < (await all.count()); i++) {
          const field = all.nth(i);
          if ((await field.isVisible()) && (await field.isEnabled())) {
            await field.scrollIntoViewIfNeeded();
            measurements.push({
              focus: await auditFocus(field),
              field: await field.getAttribute("name"),
              width,
              height,
              theme,
            });
          }
        }
      };
      try {
        await page.goto("http://ofis.test");
        await page.getByRole("heading", { name: "İçeri buyurun." }).waitFor();
        await capture("giris");
        if (width === 1920 && theme === "light") {
          const guardBase = resolve(".test-data/visual/guard-base"),
            guardCurrent = resolve(".test-data/visual/guard-current");
          mkdirSync(guardBase, { recursive: true });
          mkdirSync(guardCurrent, { recursive: true });
          copyFileSync(
            resolve(current, `giris-${suffix}.png`),
            resolve(guardBase, "denetim.png"),
          );
          const marker = await page.addStyleTag({
            content:
              '.login-screen::after { content: ""; position: fixed; left: 0; top: 0; width: 32px; height: 32px; background: red; }',
          });
          await page.screenshot({
            path: resolve(guardCurrent, "denetim.png"),
            scale: "css",
            caret: "hide",
          });
          await marker.evaluate((el) => (el as HTMLElement).remove());
          const rejected = spawnSync(
            "python3",
            [
              "scripts/compare-visual.py",
              guardBase,
              guardCurrent,
              "denetim.png",
            ],
            {
              encoding: "utf8",
              env: { ...process.env, PYTHONPATH: resolve(".cache/python") },
            },
          );
          assert.equal(
            rejected.status,
            1,
            "Visual auditing must reject unexpected pixel differences.",
          );
        }
        await auditFocus(page.getByLabel("Sahip şifresi"));
        await capture("giris-odak", ".login-form");
        await page.getByRole("button", { name: /Tema:/ }).click();
        await capture("tema-secimi", ".theme-menu");
        await page.keyboard.press("Escape");
        await page.getByLabel("Sahip şifresi").fill(config.ownerPassword);
        await page
          .getByRole("button", { name: "Ofisi aç", exact: true })
          .click();
        await page.locator(".art-loading").waitFor({ state: "hidden" });
        await office();
        await page
          .locator('.agent-hit[data-agent-id="demo-2"] .agent-bubble')
          .filter({ hasText: "?" })
          .waitFor({ state: "visible" });
        await page.mouse.move(0, 0);
        await capture("ofis");
        if (width === 1920 && theme === "light") {
          // Verify that the audits actually detect the old defects too.
          const broken = await page.addStyleTag({
            content: ".rail { background: var(--ink) !important; }",
          });
          await assert.rejects(() => auditPage(page));
          await broken.evaluate((el) => (el as HTMLElement).remove());
          const saved = await page
            .locator(".office-canvas")
            .getAttribute("data-empty-chair-ids");
          const occupied = await page
            .locator('.agent-hit[data-seated="true"]')
            .first()
            .getAttribute("data-chair-id");
          await page
            .locator(".office-canvas")
            .evaluate(
              (el, id) =>
                ((el as HTMLElement).dataset.emptyChairIds = JSON.stringify([
                  id,
                ])),
              occupied,
            );
          await assert.rejects(() => auditSeats(page, snapshot));
          await page
            .locator(".office-canvas")
            .evaluate(
              (el, value) =>
                ((el as HTMLElement).dataset.emptyChairIds = value!),
              saved,
            );
          const shifted = await page.addStyleTag({
            content:
              ".compose-field:focus-within { outline-offset: 6px !important; }",
          });
          await assert.rejects(() =>
            auditFocus(page.getByLabel("Mesajınız", { exact: true })),
          );
          await shifted.evaluate((el) => (el as HTMLElement).remove());
          await page
            .getByLabel("Mesajınız", { exact: true })
            .evaluate((el) => (el as HTMLElement).blur());
        }
        if (width === 390) await capture("telefon-ofis");
        await page.getByRole("button", { name: "Büyüt", exact: true }).click();
        await settle();
        await auditSeats(page, snapshot);
        await capture("buyuk-ekran");
        await page.getByRole("button", { name: "Küçült", exact: true }).click();
        await settle();
        await page.locator('.agent-hit[data-agent-id="demo-0"]').focus();
        await page.locator('.agent-hit[data-agent-id="demo-0"]').click();
        if (width <= 900)
          await page.getByRole("tab", { name: "Ofis", exact: true }).click();
        await capture("secili-calisan", ".agent-hit[data-agent-id='demo-0']");
        await page
          .locator(".office-viewport")
          .hover({ position: { x: 5, y: 5 } });
        await capture("ofis-uzerine-gelme", ".camera-controls");
        // Show all four states in one frame; save each state's selection separately.
        for (const [id, name] of [
          ["demo-1", "bosta"],
          ["demo-2", "bekleyen"],
          ["demo-4", "kapali"],
        ]) {
          await page.locator(`.agent-hit[data-agent-id="${id}"]`).focus();
          await page.locator(`.agent-hit[data-agent-id="${id}"]`).click();
          if (id === "demo-2") {
            await page
              .getByRole("heading", { name: "Onay kutusu", exact: true })
              .waitFor();
            await office();
          }
          if (width <= 900)
            await page.getByRole("tab", { name: "Ofis", exact: true }).click();
          await capture(`secili-${name}`, `.agent-hit[data-agent-id="${id}"]`);
        }
        await chat();
        await page
          .getByLabel("Mesajınız", { exact: true })
          .fill("Kaynakları birlikte inceleyelim. Sonucu sade bir dille yaz.");
        await auditFocus(page.getByLabel("Mesajınız", { exact: true }));
        await capture("mesaj-yazilirken", ".compose-field");
        await auditFocus(page.getByLabel("Mesajın alıcısı", { exact: true }));
        await capture("alici-odak", ".chat-compose");
        await page
          .getByLabel("Mesajın alıcısı", { exact: true })
          .selectOption("agent:demo-0");
        await page
          .getByLabel("Mesajınız", { exact: true })
          .fill("Notları inceliyorum.");
        await page
          .getByRole("button", { name: "Mesajı gönder", exact: true })
          .click();
        await page
          .getByLabel("Mesajınız", { exact: true })
          .waitFor({ state: "visible" });
        if (width <= 900)
          await page.getByRole("tab", { name: "Ofis", exact: true }).click();
        await settle();
        await page.waitForFunction(() =>
          Boolean(
            document.querySelector(
              '.agent-hit[data-agent-id="demo-0"] .agent-bubble',
            )?.textContent,
          ),
        );
        await capture("calisan-balon", ".agent-hit[data-agent-id='demo-0']");
        assert.ok(
          await page
            .locator('.agent-hit[data-agent-id="demo-0"] .agent-bubble')
            .isVisible(),
          "Working agents must have visible bubbles.",
        );
        await nav("Ajanlar");
        await capture("ajanlar");
        await auditFocus(page.getByRole("searchbox", { name: "Ajan ara" }));
        await capture("arama-odak", ".agent-toolbar");
        await page
          .getByRole("button", { name: "Ajan ekle", exact: true })
          .click();
        await fields(
          ".agent-sheet input, .agent-sheet select, .agent-sheet textarea",
        );
        await page.getByLabel("Ad", { exact: true }).focus();
        await page.locator(".agent-sheet").evaluate((el) => (el.scrollTop = 0));
        await capture("ajan-formu");
        await page.getByLabel("Ajana talimatınız", { exact: true }).focus();
        await capture("ajan-formu-odak", "textarea");
        await page.locator(".appearance").scrollIntoViewIfNeeded();
        await capture("ajan-gorunumu");
        await page.locator(".appearance-gallery summary").click();
        await page.locator(".character-gallery").scrollIntoViewIfNeeded();
        await capture("gorunum-ornekleri");
        await page.locator(".appearance-gallery summary").click();
        await page.locator(".advanced summary").click();
        await fields(".advanced input,.advanced select");
        await page.locator(".advanced").scrollIntoViewIfNeeded();
        await capture("masa-durum-formu");
        await page
          .getByRole("button", { name: "Pencereyi kapat", exact: true })
          .click();
        await nav("Bölümler");
        await capture("bolumler");
        await page
          .getByRole("button", { name: "Bölüm aç", exact: true })
          .click();
        await fields(".modal input, .modal textarea");
        await capture("bolum-formu");
        await page
          .getByRole("button", { name: "Pencereyi kapat", exact: true })
          .click();
        await nav("Görevler ve notlar");
        await page.getByText("Kaynakları incele", { exact: true }).waitFor();
        await capture("gorevler-ve-notlar");
        await page
          .getByRole("button", { name: "Görev ekle", exact: true })
          .click();
        await fields(".modal input, .modal textarea, .modal select");
        await page.getByLabel("Başlık", { exact: true }).focus();
        await capture("gorev-ekle", ".modal");
        await page
          .getByRole("button", { name: "Pencereyi kapat", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Not ekle", exact: true })
          .click();
        await fields(".modal input, .modal textarea, .modal select");
        await page.getByLabel("Notun içeriği", { exact: true }).focus();
        await capture("not-ekle", ".modal");
        await page
          .getByRole("button", { name: "Pencereyi kapat", exact: true })
          .click();
        await nav("Şirket kuralları");
        await capture("sirket-kurallari");
        await auditFocus(page.locator(".rules-card textarea"));
        await capture("kurallar-odak", ".rules-card");
        await fields(".runtime-settings input, .runtime-settings textarea");
        await page.locator(".runtime-settings").scrollIntoViewIfNeeded();
        await capture("calisma-sinirlari");
        await nav("Onay kutusu");
        await capture("onay-kutusu");
        await page
          .getByLabel("Karar notu")
          .fill("Dosyaları birlikte gözden geçirdik.");
        await capture("onay-notu");
        await page.locator(".runtime-card details summary").first().click();
        await capture("onay-dosya-farki");
        await nav("Bağlantılar");
        await fields(".runtime-card input, .runtime-card select");
        await capture("baglantilar");
        await page.getByLabel("Klasör izni").selectOption("write");
        await capture("onayli-klasor-formu");
        await nav("Kullanım ve kota");
        await page.getByText("3 çalışma", { exact: false }).first().waitFor();
        await capture("kullanim");
        await page.getByText('Oturum kullanımı',{exact:true}).click();
        await capture('a3-oturum-kullanimi','.runtime-card:has-text("Oturum kullanımı")');
        snapshot.runtime!.providerPauses=[{provider:'codex',reason:'Kullanım sınırı',until:null}];await page.reload();await nav('Kullanım ve kota');
        await capture('a3-kota-duraklamasi','.runtime-card:has-text("Codex kotası doldu")');
        snapshot.runtime!.providerPauses=[];
        await nav('Özetler ve ortak defter');await page.getByText('Şirket kararları',{exact:true}).waitFor();
        await page.getByLabel('Not başlığı',{exact:true}).fill('Doğrulanmış yol haritası');
        await page.getByLabel('Doğrulanmış kısa bilgi',{exact:true}).fill('2026-10-10: Önce ilgili dosyayı ve kısa bilgi notunu oku.');
        await capture('a3-ortak-defter');
        await page.locator('.runtime-cards details summary').first().click();await capture('a3-gunluk-ozet','.runtime-cards details');
        await nav('Bağlantılar');await page.getByLabel('Komut adı',{exact:true}).fill('Testler');
        await page.getByLabel('Klasör bağlantısı').selectOption({index:1});
        await page.getByLabel('Sabit komut satırı',{exact:true}).fill('npm test');
        await page.getByLabel('Klasörün altındaki çalışma yeri',{exact:true}).fill('ofis');
        await page.getByLabel('Komut adı',{exact:true}).focus();await capture('a3-komut-baglantisi','section:has(> h2:text-is("Komut bağlantıları"))');
        await nav("Ajanlar");
        await page
          .getByRole("button", {
            name: "Deniz için diğer işlemler",
            exact: true,
          })
          .click();
        await capture("ajan-calisma-kaydi");
        await page
          .getByRole("button", { name: /Çalışıyor · Kaynakları incele/ })
          .click();
        await capture("calisma-dokumu");
        await page.getByText("Tanı", { exact: true }).click();
        await capture("calisma-tanisi", ".agent-work .runtime-card:has(h3)");
        await page.getByRole("tab", { name: "Çıktılar", exact: true }).click();
        await capture("ajan-ciktilari");
        await page.getByRole("button", { name: "Önizle", exact: true }).click();
        await page
          .locator(".artifact-markdown")
          .getByRole("heading", { name: "İlk sonuç", exact: true })
          .waitFor();
        await capture("cikti-onizleme");
        snapshot.runtime!.artifacts[0].mime = "image/png";
        await page.reload();
        await nav("Ajanlar");
        await page
          .getByRole("button", {
            name: "Deniz için diğer işlemler",
            exact: true,
          })
          .click();
        await page.getByRole("tab", { name: "Çıktılar", exact: true }).click();
        await page.getByRole("button", { name: "Önizle", exact: true }).click();
        await page.locator(".artifact-preview").waitFor();
        await page.waitForFunction(
          () =>
            (document.querySelector(".artifact-preview") as HTMLImageElement)
              ?.naturalWidth > 0,
        );
        await capture("cikti-gorsel-onizleme");
        snapshot.runtime!.artifacts[0].mime = "text/markdown";
        await page
          .getByRole("tab", { name: "Hafıza notu", exact: true })
          .click();
        await page.getByLabel("Kalıcı kısa not").focus();
        await capture("hafiza-notu");
        await page.getByRole('tab',{name:'Oturum',exact:true}).click();
        await page.getByRole('log',{name:'Oturum dökümü'}).getByText('Testler: çıkış 0',{exact:false}).waitFor();
        await capture('a3-canli-oturum','.session-panel');
        await page.getByLabel('Bu oturuma yaz',{exact:true}).fill('Sonucu kısa yaz; kaynak tarihini de ekle.');
        await capture('a3-sahip-girdisi','.session-panel form');
        await page.getByRole('button',{name:'Oturumu sıfırla',exact:true}).click();
        await capture('a3-oturum-sifirlama','.session-panel .hint');

        await page
          .getByRole("button", { name: "Pencereyi kapat", exact: true })
          .click();
        await nav("Olaylar");
        await capture("olaylar");
        await fields(".event-filters select");
        const upcoming = [
          "Hazır ajan şablonları",
          "Beceriler",
        ];
        // Future screens remain in the phone's More menu; the empty sidebar
        // heading has been removed on desktop.
        if (width <= 900) for (let i = 0; i < upcoming.length; i++) {
          await nav(upcoming[i]);
          await capture(`yakinda-${i + 1}`);
        }
        if (width > 900) {
          await page
            .getByRole("button", { name: "Menüyü daralt", exact: true })
            .click();
          const compact = page.getByRole("button", { name: /Tema:/ });
          const selected = await compact.getAttribute("title");
          await compact.click();
          assert.equal(await page.getByRole("menu", { name: "Tema seçimi" }).isVisible(), true);
          await page.keyboard.press("Escape");
          assert.equal(await compact.getAttribute("title"), selected);
          assert.equal(await page.locator(".rail .brand").isVisible(), false);
          await capture("dar-menu");
          await page
            .getByRole("button", { name: "Menüyü genişlet", exact: true })
            .click();
        }
        snapshot.agents[0].name =
          "Deniz Çok Uzun Bir Çalışan Adı ve Ekip Koordinatörü";
        snapshot.agents[0].title =
          "Kaynakları Karşılaştırma ve Ortak Çalışmaları Koordine Etme Uzmanı";
        snapshot.departments[0].name =
          "Uzun Adlı Ortak Çalışma ve Araştırma Bölümü";
        snapshot.messages.push({
          ...snapshot.messages[0],
          id: "visual-long",
          text:
            "Uzun bir mesajın kutusuna sığması gerekir. ".repeat(35) +
            "kesintisizuzunsözcük".repeat(30),
        });
        await page.reload();
        await office();
        await page.locator('.agent-hit[data-agent-id="demo-0"]').focus();
        await page.locator('.agent-hit[data-agent-id="demo-0"]').click();
        await chat();
        await capture("uzun-ad-birebir");
        await page
          .getByLabel("Mesajın alıcısı", { exact: true })
          .selectOption("everyone");
        await capture("uzun-ad-mesaj");
        if (width === 390) await capture("telefon-sohbet");
        await nav("Ajanlar");
        await capture("uzun-ad-ajanlar");
        await nav("Bölümler");
        await capture("uzun-ad-bolumler");
        if (width === 1920 && !filter?.startsWith("a2-2")) {
          measurements.push({
            theme,
            seatingVariants: await auditSeatVariants(page),
          });
          for (const frame of [0, 1, 2]) {
            await page.evaluate(
              ({ theme, frame }) =>
                window.officeSeatProbe.gallery(theme, frame),
              { theme, frame },
            );
            const file = `oturma-gorunumleri-kare-${frame}-${suffix}.png`;
            await page
              .locator("#seated-gallery")
              .screenshot({ path: resolve(current, file), scale: "css" });
            files.push(file);
            count++;
            if (updating)
              copyFileSync(resolve(current, file), resolve(baseline, file));
            await page.locator("#seated-gallery").evaluate((el) => el.remove());
          }
          for (const agentCount of [6, 14]) {
            snapshot = {
              ...structuredClone(fixture),
              departments: seed.departments.slice(0, 6),
              agents: Array.from({ length: agentCount }, (_, i) => ({
                ...seed.agents[i % 6],
                id: `seated-scene-${i}`,
                name: `Ekip ${i + 1}`,
                department_id: seed.departments[i % 6].id,
                desk_x: 0,
                desk_y: 0,
                status: "calisiyor",
                appearance: {
                  ...seed.agents[i % 6].appearance,
                  glasses: Boolean(i & 1),
                  tie: Boolean(i & 2),
                  headphones: Boolean(i & 4),
                },
              })),
            };
            await page.reload();
            await office();
            measurements.push({
              theme,
              agentCount,
              seating: await auditSeats(page, snapshot),
            });
            await capture(
              `oturma-${agentCount}-ajan`,
              ".agent-hit[data-seated='true']",
            );
            for (const time of [11200, 11900, 12600]) {
              await page.evaluate((time) => {
                (window as unknown as { visualTime: number }).visualTime = time;
              }, time);
              await settle();
              await auditSeats(page, snapshot);
            }
          }
          await installSeatProbe(page);
          const world = await (
            await import("./layout.browser.js")
          ).sceneWorld(page, snapshot);
          world.furniture.find((f) => f.islandId)!.y += 1;
          const brokenGaps = await page.evaluate(
            (world) => window.officeSeatProbe.gaps(world),
            world,
          );
          assert.ok(
            brokenGaps.some((gap) => gap.sourceGap > 3),
            "Distant chairs must fail the threshold.",
          );
        }
        snapshot = structuredClone(fixture);
        snapshot.runtime!.stoppedChains = [{ id: "visual-chain", reason: "İş zinciri sınıra ulaştığı için durduruldu. Yeni bir iş verebilirsiniz.", stopped_at: "2026-10-10T10:00:00Z", message_id: "visual-notice", event_id: "visual-event" }];
        await page.reload(); await nav("Ofis");
        await page.getByRole("alert").filter({ hasText: "İş zinciri sınıra" }).waitFor();
        await capture("a2-2-zincir-uyarisi", ".global-error");
        await page.getByRole("button", { name: "Zincir uyarısını kapat", exact: true }).click();
        snapshot.runtime!.stoppedChains = [];
        snapshot.runtime!.pendingDeletions = [{ id: "visual-deletion", name: "Deniz", state: "pending", detail: "Tududi kısa süreliğine girişleri sınırladı, 3 dakika sonra tekrar deneyin.", next_at: 0, attempts: 1 }];
        await page.reload(); await nav("Ofis");
        await page.getByRole("status").filter({ hasText: "silinmeyi bekliyor" }).waitFor();
        await capture("a2-2-bekleyen-hesap", ".global-error");
        snapshot.runtime!.pendingDeletions = [];
        showContextEstimate = true;
        await page.reload(); await nav("Ajanlar");
        await page.getByRole("button", { name: "Deniz için diğer işlemler", exact: true }).click();
        await page.getByRole("button", { name: /Çalışıyor · Kaynakları incele/ }).click();
        await page.getByText("Talimat ve bağlam boyutu", { exact: true }).click();
        await capture("a2-2-baglam", ".agent-work .runtime-card:has(h3)");
        snapshot = structuredClone(fixture);
        snapshot.messages[0].response_note = "Kimse anılmadı; bu mesaja cevap gelmeyecek";
        await page.reload(); await nav("Ofis");
        if (width === 390) await page.getByRole("tab", { name: "Sohbet", exact: true }).click();
        await capture("a2-3-karsilayan-yok", ".chat-compose");
        snapshot.messages[0].response_note = "";
        snapshot.runtime!.settings = { ...defaultSettings,language:'tr', greeterAgentId: "demo-0" };
        const linked = { ...snapshot.runtime!.runs[0], message_id: snapshot.messages[0].id, conversation_type: "everyone" as const, conversation_id: null, priority: 1 };
        for (const state of ["queued", "running", "completed", "failed"] as const) {
          snapshot.runtime!.runs = [{ ...linked, state, reason: state === "failed" ? "Token bütçesi aşıldı. Akışta gözlenen kullanıma göre durduruldu." : "" }];
          snapshot.runtime!.connected = state !== "queued";
          await page.reload(); await nav("Ofis");
          if (width === 390) await page.getByRole("tab", { name: "Sohbet", exact: true }).click();
          await capture(`a2-3-mesaj-${state}`, ".chat-messages");
        }
        snapshot.runtime!.connected = true;
        snapshot.runtime!.runs = [{ ...linked, state: "queued" }, { ...linked, id: "background", message_id: null, state: "running", priority: 0 }];
        await page.reload(); await nav("Ofis");
        if (width === 390) await page.getByRole("tab", { name: "Sohbet", exact: true }).click();
        await page.getByText(/önünde 1 iş var/).waitFor();
        await capture("a2-3-mesaj-sirasi", ".message-status");
        if (width === 390) await page.getByRole("tab", { name: "Ofis", exact: true }).click();
        await capture("a2-3-ofiste-sirada", ".office-stage");
        snapshot.runtime!.runs = [];
        snapshot.messages[1].artifact_ids = ["visual-artifact"];
        await page.reload(); await nav("Ofis");
        if (width === 390) await page.getByRole("tab", { name: "Sohbet", exact: true }).click();
        await page.locator(".output-card").getByRole("button", { name: "Önizle" }).click();
        await page.locator(".output-card pre").waitFor();
        await page.waitForFunction(() => document.querySelector("main")?.getAttribute("aria-busy") !== "true");
        await capture("a2-3-cikti-karti", ".output-card");
        snapshot.runtime!.protocolError = "Çalıştırıcı sürümü uyumsuz — güncelleyin";
        await page.reload(); await nav("Ofis");
        await capture("a2-3-surum-uyumsuz", ".global-error");
        snapshot.runtime!.protocolError = "";
        snapshot.handoffs = [{ id: "visual-handoff", from_agent_id: "demo-1", to_agent_id: "demo-0", title: "Dosyayı incele", description: "Gelen taslağı değerlendir.", status: "not_started", note: "Ofis araçları başlatılamadı.", tududi_task_uid: null, created_at: "2026-10-10T10:00:00Z" }];
        await page.reload(); await nav("Görevler ve notlar");
        await capture("a2-3-devir-baslatilamadi", ".pending-handoffs");
        snapshot.runtime!.chains = [{ id: "visual-chain", runs: [{ ...linked, state: "completed" }, { ...linked, id: "receiver", agent_id: "demo-1", depth: 1, state: "failed", summary: "Taslağı incele", usage: { input_tokens: 400100, output_tokens: 310 } }], input_tokens: 710000, output_tokens: 1500, duration_ms: 170000 }];
        await page.reload(); await nav("Kullanım ve kota");
        await page.getByText(/İş zinciri · 2 çalışma/).click();
        await capture("a2-3-zincir-kullanimi", ".runtime-card:has(summary)");
        // A3.2: explained queue blocks, direct panel login and daily cap.
        snapshot = structuredClone(fixture);
        snapshot.runtime!.dailyUsage = {day:'2026-10-10',input_tokens:5300000,uncached_input_tokens:2300000};
        await page.reload(); await nav('Görevler ve notlar');
        await capture('a3-2-tududi-paneli','.tududi-panel-entry');
        await nav('Kullanım ve kota');
        await capture('a3-2-gunluk-tavan','.daily-token-usage');
        const blocks = [
          ['gunluk-token',"Günlük token tavanı doldu (5,3 / 3 milyon) — yarın sıfırlanır ya da Kullanım'dan tavanı yükseltin.",'usage'],
          ['ajan-siniri',"Deniz: ajan günlük çalışma sınırı doldu — yarın sıfırlanır ya da Ajanlar'dan sınırı yükseltin.",'agents'],
          ['saglayici',"Codex sağlayıcısı duraklatıldı — Kullanım'dan sağlayıcıyı sürdürün; açılma saati bilinmiyor.",'usage'],
          ['baglanti','Çalıştırıcı bağlı değil — bağlantı kurulana kadar bekliyor.','links'],
          ['surum','Çalıştırıcı sürümü uyumsuz — çalıştırıcı güncellenene kadar bekliyor.','links'],
        ] as const;
        for (const [name,reason,setting] of blocks) {
          snapshot.runtime!.runs=[{...linked,state:'queued',reason}];
          snapshot.runtime!.queueBlocks=[{agent_id:linked.agent_id,reason,setting}];
          await page.reload();await nav('Ofis');
          if(width===390)await page.getByRole('tab',{name:'Sohbet',exact:true}).click();
          await page.locator('.message-status').filter({hasText:reason}).first().waitFor();
          await capture(`a3-2-kuyruk-${name}`,'.message-status');
          if(name==='gunluk-token') {
            if(width===390)await page.getByRole('tab',{name:'Ofis',exact:true}).click();
            await capture('a3-2-ofis-bekleme','.office-queue-status');
          }
        }
        snapshot.runtime!.queueBlocks=[];
        await page.goto('http://ofis.test/?oturum=demo-0');await nav('Ofis');
        if(width===390)await page.getByRole('tab',{name:'Sohbet',exact:true}).click();
        await page.locator('.chat-shortcuts').getByRole('button',{name:'Tududi paneli',exact:true}).waitFor();
        await capture('a3-2-sohbet-paneli','.conversation-heading');
        await page.goto('http://ofis.test/');
        snapshot = longChatFixture(fixture);
        await page.reload(); await nav("Ofis");
        if (width === 390) await page.getByRole("tab", { name: "Sohbet", exact: true }).click();
        await page.locator(".output-card").waitFor();
        await capture("a2-4-uzun-sohbet", ".chat-messages");
        await page.locator(".chat-event").getByRole("button", { name: "Göster", exact: true }).click();
        await page.locator(".chat-event").scrollIntoViewIfNeeded();
        await capture("a2-4-hata-ayrintisi", ".chat-event");
        await page.getByRole("button", { name: "Devamını göster", exact: true }).click();
        await page.locator(".message").last().scrollIntoViewIfNeeded();
        await capture("a2-4-markdown", ".message:last-child");
        await page.getByRole("button", { name: "Daha az göster", exact: true }).click();
        if (width !== 390) {
          await capture("a2-4-sohbet-listeleri", ".rail-chats");
          if (width === 1280 && theme === "light") {
            const squeezed = await page.addStyleTag({ content: ".rail-chats .agent-row { margin-bottom: 3px; }" });
            await assert.rejects(() => auditScrollbars(page), /Üç öğe için alan yok/);
            await squeezed.evaluate((el) => (el as Element).remove());
          }
          await page.locator("#group-chats").evaluate((el) => { el.scrollTop = el.scrollHeight; });
          await page.locator("#direct-chats").evaluate((el) => { el.scrollTop = 51; });
          await page.waitForFunction(() => document.querySelector("#direct-chats")?.getAttribute("data-fade-top") === "true");
          await capture("a2-4-listeler-kaydirilmis", ".rail-chats");
          if (width === 1920 && theme === "light") {
            const native = await page.addStyleTag({ content: "::-webkit-scrollbar { width: 16px !important; }" });
            await assert.rejects(() => auditScrollbars(page)); await native.evaluate((el) => (el as Element).remove());
            const cut = await page.addStyleTag({ content: ".scroll-list { mask-image: none !important; }" });
            await assert.rejects(() => auditScrollbars(page)); await cut.evaluate((el) => (el as Element).remove());
          }
        }
        await page.locator(".chat-messages").evaluate((el) => { el.scrollTop = 300; });
        await page.waitForTimeout(80);
        snapshot.messages.push({ ...snapshot.messages.at(-1)!, id: "visual-new-chat-message", artifact_ids: [], text: "Yeni gelen kısa mesaj.", created_at: "2026-10-10T10:35:00Z" });
        await page.evaluate(() => {
          for (const stream of (window as unknown as { __visualStreams: EventSource[] }).__visualStreams)
            stream.dispatchEvent(new MessageEvent("update", { data: "{}" }));
        });
        await page.getByRole("button", { name: "1 yeni mesaj ↓", exact: true }).waitFor();
        await capture("a2-4-yeni-mesaj", ".new-messages");
        await page.getByRole("button", { name: "1 yeni mesaj ↓", exact: true }).click();
        await page.getByLabel("Mesajınız", { exact: true }).fill("Kısa mesaj");
        await capture("a2-4-kisa-mesaj-kutusu", ".compose-field");
        await page.getByLabel("Mesajınız", { exact: true }).fill(Array.from({ length: 12 }, (_, i) => `${i + 1}. Yazma notu`).join("\n"));
        await capture("a2-4-buyuyen-mesaj-kutusu", ".compose-field");
        if (width === 390) await page.getByRole("tab", { name: "Ofis", exact: true }).click();
        await page.getByRole("button", { name: "Ofis işlemleri", exact: true }).click();
        await capture("a2-4-ofis-islemleri", ".scene-heading");
        await page.getByRole("button", { name: "Ofis işlemleri", exact: true }).click();
        snapshot.runtime!.runs = [{ ...linked, agent_id: snapshot.agents[0].id, state: "failed", message_id: "chat-message-59", reason: "Süre sınırına ulaşıldı.", conversation_id: null }];
        snapshot.runtime!.messageRuns = undefined;
        snapshot.events.push({ id: "chat-new-event", agent_id: snapshot.agents[0].id, department_id: snapshot.departments[0].id,
          kind: "run_failed", text: "Süre sınırına ulaşıldı. Daha kısa bir iş vererek yeniden deneyebilirsiniz.",
          created_at: "2026-10-10T10:34:00Z", conversation_type: "everyone", conversation_id: null, run_id: linked.id, message_id: "chat-message-59" });
        await page.reload(); await nav("Ofis");
        if (width === 390) await page.getByRole("tab", { name: "Sohbet", exact: true }).click();
        await capture("a2-4-calisma-olayi", ".chat-event:has-text('Defne çalışamadı')");
        snapshot.runtime!.runs[0].state = "queued";
        snapshot.runtime!.approvals = structuredClone(fixture.runtime!.approvals);
        snapshot.runtime!.protocolError = "Çalıştırıcı sürümü uyumsuz — güncelleyin";
        await page.reload(); await nav("Ofis");
        if(width===390)await page.getByRole("tab",{name:"Ofis",exact:true}).click();
        await capture("a2-4-ofis-uyari", ".scene-heading");
        console.log(`Visual audit passed: ${suffix}.`);
      } catch (error) {
        await page.screenshot({
          path: resolve(current, `basarisiz-${suffix}.png`),
          scale: "css",
        });
        throw error;
      } finally {
        await context.close();
      }
    }
  }));
  assert.deepEqual(problems, [], "There must be no browser errors or external requests.");
  const manifestPath = resolve(baseline, "taban.json");
  if (updating) {
    const old = existsSync(manifestPath)
      ? JSON.parse(readFileSync(manifestPath, "utf8"))
      : { files: [] };
    const kept: string[] = filter
      ? old.files.filter((file: string) => !file.includes(filter))
      : [];
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          browser: browser.version(),
          node: process.version,
          deviceScaleFactor: 2,
          screenshotScale: "css; yakın kırpmalar 2×",
          frozenDate: "2026-10-10T12:00:00Z",
          reducedMotion: "reduce",
          files: [...new Set([...kept, ...files])].sort(),
        },
        null,
        2,
      ) + "\n",
    );
  } else if (!filter) {
    assert.ok(
      existsSync(manifestPath),
      "Visual comparison baselines must exist.",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.deepEqual(
      files.toSorted(),
      manifest.files,
      "All saved screen states must be audited again.",
    );
  }
  if (!updating) {
    for (const file of files)
      assert.ok(
        existsSync(resolve(baseline, file)),
        `Missing comparison baseline: ${file}. Review and create it with --update-baselines.`,
      );
    const comparison = spawnSync(
      "python3",
      ["scripts/compare-visual.py", baseline, current, ...files],
      {
        encoding: "utf8",
        env: { ...process.env, PYTHONPATH: resolve(".cache/python") },
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    assert.equal(comparison.status, 0, comparison.stdout + comparison.stderr);
    console.log(comparison.stdout.trim());
  }
  writeFileSync(
    resolve(".test-data/visual/dogrulama.json"),
    JSON.stringify(
      { baselineUpdated: updating, screenshots: count, measurements },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `${count} screenshots passed contrast, overflow, chair and focus checks.${updating ? " Comparison baselines created." : " Baseline comparison passed."}`,
  );
} finally {
  await browser.close();
  await app.close();
  cleanup(config);
}
