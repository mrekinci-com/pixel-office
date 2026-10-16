// Seat-motion audit; test:browser covers full application flows.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../server/app.js";
import { testConfig, fakeTududi, cleanup } from "./helpers.js";
import { demoSnapshot } from "../src/demo.js";
import { checkActors } from "./layout.browser.js";
import type { Snapshot } from "../shared/types.js";

const cache = resolve(".cache/runtime");
mkdirSync(cache, { recursive: true });
process.env.TMPDIR = cache;
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(".cache/browsers");
const { chromium } = await import("playwright");
const config = testConfig(), fake = fakeTududi();
const { app } = await createApp(config, { fetcher: fake.fetcher });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], downloadsPath: cache,
  env: { ...process.env, LD_LIBRARY_PATH: [resolve(".cache/system-libs/usr/lib/x86_64-linux-gnu"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") } });
const seed = demoSnapshot({ departments: [], agents: [], messages: [], events: [], handoffs: [], rules: "" }, 0);
let snapshot: Snapshot = seed;
const problems: string[] = [], measurements: unknown[] = [];
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: "tr-TR" });
const page = await context.newPage();
await context.addInitScript({ content: "window.__name = (value) => value;" });
page.on("pageerror", (error) => problems.push(error.message));
await context.route("**/*", async (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== "http://ofis.test") { problems.push(`External request: ${url.origin}`); await route.abort(); return; }
  if (url.pathname === "/api/snapshot") { await route.fulfill({ json: snapshot }); return; }
  if (url.pathname === "/api/live") { await route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "retry: 60000\nevent: ready\ndata: {}\n\n" }); return; }
  const response = await app.inject({ method: request.method() as any, url: url.pathname + url.search,
    headers: { ...(await request.allHeaders()), host: url.host }, payload: request.postData() || undefined });
  if (response.statusCode >= 400 && url.pathname !== "/api/session") problems.push(`Request failed: ${url.pathname} ${response.statusCode}`);
  const headers = Object.fromEntries(Object.entries(response.headers).filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k, Array.isArray(v) ? v.join("\n") : String(v)]));
  await route.fulfill({ status: response.statusCode, headers, body: response.rawPayload });
});
try {
  await page.goto("http://ofis.test");
  await page.getByLabel("Sahip şifresi").fill(config.ownerPassword);
  await page.getByRole("button", { name: "Ofisi aç", exact: true }).click();
  for (const departments of [1, 6]) for (const agents of [6, 14]) {
    snapshot = { ...seed, departments: seed.departments.slice(0, departments),
      agents: Array.from({ length: agents }, (_, i) => ({ ...seed.agents[i % 6], id: `seating-motion-${i}`,
        department_id: seed.departments[i % departments].id, desk_x: 0, desk_y: 0 })) };
    await page.reload();
    await page.locator(".art-loading").waitFor({ state: "hidden" });
    for (const theme of ["light", "dark"]) for (const [width, height] of [[1920, 1080], [1366, 768], [1280, 640]]) {
      await page.evaluate((theme) => document.documentElement.dataset.theme = theme, theme);
      await page.setViewportSize({ width, height });
      await page.waitForFunction(() => {
        const view = document.querySelector<HTMLElement>(".canvas-scroll")!, canvas = document.querySelector<HTMLCanvasElement>(".office-canvas")!;
        const stage = document.querySelector<HTMLElement>(".pixel-stage")!, a = view.getBoundingClientRect(), b = stage.getBoundingClientRect();
        return canvas.dataset.renderedCols === view.dataset.cols && canvas.dataset.renderedRows === view.dataset.rows &&
          b.width > 0 && b.right <= a.right + 1 && b.bottom <= a.bottom + 1 &&
          Math.abs((b.x - a.x) - (a.right - b.right)) < 1 && Math.abs((b.y - a.y) - (a.bottom - b.bottom)) < 1;
      });
      await checkActors(page, snapshot, 60);
      measurements.push({ departments, agents, width, height, theme, frames: 60 });
      console.log(`Seating and walking passed: ${agents} agents, ${departments} departments, ${width}×${height}, ${theme}.`);
    }
  }
  assert.deepEqual(problems, []);
  writeFileSync(resolve(".test-data/seating-motion.json"), JSON.stringify({ combinations: measurements, frames: measurements.length * 60 }, null, 2) + "\n");
} finally { await browser.close(); await app.close(); cleanup(config); }
