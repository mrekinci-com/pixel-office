import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { createApp } from "../server/app.js";
import {
  captureSizes,
  checkFit,
  checkActors,
  captureNativeScene,
  checkScreens,
} from "./layout.browser.js";
import { demoSnapshot } from "../src/demo.js";
import { longChatFixture } from "./chat.fixture.js";
import { checkChat } from "./chat.browser.js";
import type { Snapshot } from "../shared/types.js";
import { testConfig, cleanup, fakeTududi } from "./helpers.js";
const cache = resolve(".cache/runtime");
mkdirSync(cache, { recursive: true });
process.env.TMPDIR = cache;
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(".cache/browsers");
const { chromium } = await import("playwright");
const config = testConfig();
const fake = fakeTududi();
const { app, store, office, runtime } = await createApp(config, {
  fetcher: fake.fetcher,
  background: false,
});
const director = runtime.director.agent();
const employees = () => store.agents().filter((a) => a.builtin !== "director");
let previewSnapshot: Snapshot | undefined;
let snapshotGate: Promise<void> | undefined;
const liveEvents: unknown[] = [];
office.bus.on("update", (event) => liveEvents.push(event));
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
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  locale: "tr-TR",
  deviceScaleFactor: 2,
});
// Measure the same live canvas motion with an accelerated RAF clock;
// do not wait 25–90 real seconds for every screen/department combination.
await context.addInitScript({ content: "window.__name = (value) => value; localStorage.setItem('po-hareket','canli'); let motionClock=0;window.cancelAnimationFrame=id=>clearTimeout(id);window.requestAnimationFrame=callback=>setTimeout(()=>callback(motionClock+=100),0);" });
const errors: string[] = [];
const failures: string[] = [];
const outsideRequests: string[] = [];
const page = await context.newPage();
page.setDefaultTimeout(10000);
page.on("pageerror", (error) => errors.push(error.message));
const nav = async (label: string) => {
  await page
    .getByRole("navigation")
    .getByRole("button", { name: label, exact: true })
    .click();
};
await context.route("**/*", async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  if (url.origin !== "http://ofis.test") {
    outsideRequests.push(url.origin);
    await route.abort();
    return;
  }
  if (url.pathname === "/api/snapshot" && previewSnapshot) {
    await snapshotGate;
    await route.fulfill({ status: 200, json: previewSnapshot });
    return;
  }
  if (url.pathname === "/api/live") {
    // Deliver real events as SSE chunks without a listener; API tests cover continuous streaming.
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      },
      body:
        "retry: 500\nevent: ready\ndata: {}\n\n" +
        liveEvents
          .splice(0)
          .map((event) => `event: update\ndata: ${JSON.stringify(event)}\n\n`)
          .join(""),
    });
    return;
  }
  try {
    const result = await app.inject({
      method: req.method() as any,
      url: url.pathname + url.search,
      headers: { ...(await req.allHeaders()), host: url.host },
      payload: req.postData() || undefined,
    });
    if (result.statusCode >= 400 && url.pathname !== "/api/session")
      failures.push(`${req.method()} ${url.pathname}: ${result.statusCode}`);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(result.headers)) {
      if (value !== undefined)
        headers[key] = Array.isArray(value) ? value.join("\n") : String(value);
    }
    await route.fulfill({
      status: result.statusCode,
      headers,
      body: result.rawPayload,
    });
  } catch {
    await route.abort();
  }
});
try {
  mkdirSync(resolve(".test-data/screenshots"), { recursive: true });
  await page.goto("http://ofis.test");
  await page.getByRole("heading", { name: "İçeri buyurun." }).waitFor();
  await page.screenshot({
    path: resolve(".test-data/screenshots/giris.png"),
    fullPage: true,
    animations: "disabled",
    scale: "css",
  });
  await page.getByLabel("Sahip şifresi").fill(config.ownerPassword);
  await page.getByRole("button", { name: "Ofisi aç", exact: true }).click();
  await page
    .getByRole("heading", { name: "Piksel Ofis", exact: true })
    .waitFor();
  const before = JSON.stringify(store.snapshot());
  // This section tests six sample employees; the built-in Director changed empty-office assumptions.
  // Preserve the real Director record but start this visual fixture with an empty snapshot.
  previewSnapshot = { departments: [], agents: [], messages: [], events: [], handoffs: [], rules: "", runtime: runtime.snapshot() };
  await page.getByRole("button", { name: "Ofis işlemleri", exact: true }).click();
  await page.getByRole("button", { name: "Deneme modu", exact: true }).click();
  await page.locator(".agent-row").first().waitFor();
  await page.locator(".art-loading").waitFor({ state: "hidden" });
  await page.evaluate(async () => {
    await Promise.all(
      ["Figtree", "Bricolage Grotesque", "Tiny5", "JetBrains Mono"].map(
        (name) => document.fonts.load(`16px "${name}"`, "İığşöüç"),
      ),
    );
    await document.fonts.ready;
  });
  await page.waitForTimeout(2300);
  await captureSizes(page);
  await checkFit(page);
  const chatBounds = await page
    .locator(".chat-slot .floating-chat")
    .boundingBox();
  const sceneBounds = await page.locator(".office-stage").boundingBox();
  assert.ok(
    chatBounds &&
      sceneBounds &&
      chatBounds.x + chatBounds.width <= sceneBounds.x,
    "Chat must not cover the office in normal view.",
  );
  await page.screenshot({
    path: resolve(".test-data/screenshots/ofis.png"),
    fullPage: true,
    animations: "disabled",
    scale: "css",
  });
  await captureNativeScene(
    page,
    demoSnapshot(
      {
        departments: [],
        agents: [],
        messages: [],
        events: [],
        handoffs: [],
        rules: "",
      },
      0,
    ),
  );
  await page.locator(".pixel-stage").screenshot({
    path: resolve(".test-data/screenshots/ofis-sahne.png"),
    style: ".camera-controls, .camera-hint { visibility: hidden; }",
    scale: "css",
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Tema: Sisteme uy. Değiştir", exact: true })
    .click();
  await page.getByRole("menuitemradio", { name: "Koyu", exact: true }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.screenshot({
    path: resolve(".test-data/screenshots/ofis-koyu.png"),
    animations: "disabled",
    fullPage: true,
    scale: "css",
  });
  await page.reload();
  await page
    .getByRole("heading", { name: "Piksel Ofis", exact: true })
    .waitFor();
  assert.equal(
    await page.locator("html").getAttribute("data-theme"),
    "dark",
    "Theme choice must survive reload.",
  );
  await page.getByRole("button", { name: "Ofis işlemleri", exact: true }).click();
  await page.getByRole("button", { name: "Deneme modu", exact: true }).click();
  await page.locator(".art-loading").waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Tema: Koyu. Değiştir", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: "Aydınlık", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Tema: Aydınlık. Değiştir", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: "Sisteme uy", exact: true })
    .click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), null);
  await page.emulateMedia({ colorScheme: "dark" });
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    "rgb(14, 17, 32)",
    "System theme must be followed.",
  );
  await page.emulateMedia({ colorScheme: "light" });
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    "rgb(238, 240, 246)",
  );
  await page
    .getByRole("button", { name: "Menüyü daralt", exact: true })
    .click();
  assert.equal(
    Math.round((await page.locator(".rail").boundingBox())!.width),
    56,
  );
  await checkFit(page);
  await page.reload();
  assert.equal(
    Math.round((await page.locator(".rail").boundingBox())!.width),
    56,
    "Collapsed-menu preference must persist.",
  );
  await page
    .getByRole("button", { name: "Menüyü genişlet", exact: true })
    .click();
  await page.getByRole("button", { name: "Ofis işlemleri", exact: true }).click();
  await page.getByRole("button", { name: "Deneme modu", exact: true }).click();
  await page.locator(".art-loading").waitFor({ state: "hidden" });
  const separator = page.getByRole("separator", {
    name: "Sohbet bölmesinin genişliği",
  });
  await separator.focus();
  await separator.press("ArrowRight");
  const savedSplit = await separator.getAttribute("aria-valuenow");
  await page.reload();
  await page.getByRole("button", { name: "Ofis işlemleri", exact: true }).click();
  await page.getByRole("button", { name: "Deneme modu", exact: true }).click();
  assert.equal(
    await separator.getAttribute("aria-valuenow"),
    savedSplit,
    "Chat width must survive reload.",
  );
  await separator.focus();
  await separator.press("Home");
  const separatorBox = (await separator.boundingBox())!;
  await page.mouse.move(
    separatorBox.x + 4,
    separatorBox.y + separatorBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    separatorBox.x + 70,
    separatorBox.y + separatorBox.height / 2,
    { steps: 4 },
  );
  await page.mouse.up();
  assert.ok(Number(await separator.getAttribute("aria-valuenow")) > 36);
  await checkFit(page);
  await separator.focus();
  await separator.press("Home");
  await page
    .getByRole("button", { name: "Grup sohbetleri", exact: true })
    .click();
  assert.equal(await page.locator("#group-chats").count(), 0);
  await page
    .getByRole("button", { name: "Grup sohbetleri", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Birebir sohbetler", exact: true })
    .click();
  assert.equal(await page.locator("#direct-chats").count(), 0);
  await page
    .getByRole("button", { name: "Birebir sohbetler", exact: true })
    .click();
  await nav("Ajanlar");
  await page
    .getByRole("button", { name: "Deniz sohbetini aç", exact: false })
    .click();
  await page
    .locator(".conversation-heading")
    .getByRole("heading", { name: "Deniz", exact: true })
    .waitFor();
  await page
    .getByLabel("Mesajınız", { exact: true })
    .fill("Korunan sohbet taslağı");
  await page.getByRole("button", { name: "Büyüt", exact: false }).click();
  // Expanded view initially minimizes chat; reopening preserves the draft.
  if (await page.locator(".chat-launcher").count()) await page.getByRole("button", { name: /^Sohbeti aç/ }).click();
  assert.equal(
    await page.getByLabel("Mesajınız", { exact: true }).inputValue(),
    "Korunan sohbet taslağı",
  );
  await page.getByRole("button", { name: "Küçült", exact: true }).click();
  assert.equal(
    await page.getByLabel("Mesajınız", { exact: true }).inputValue(),
    "Korunan sohbet taslağı",
  );
  await page.getByLabel("Mesajınız", { exact: true }).fill("");
  await page.getByRole("button", { name: "Genel sohbet", exact: true }).click();
  const hiddenFrame = await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    return document
      .querySelector<HTMLCanvasElement>(".office-canvas")!
      .toDataURL();
  });
  await page.waitForTimeout(150);
  assert.equal(
    await page
      .locator(".office-canvas")
      .evaluate((c) => (c as HTMLCanvasElement).toDataURL()),
    hiddenFrame,
  );
  await page.evaluate(() => {
    delete (document as any).hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const oldScale = Number(
    await page.locator(".canvas-scroll").getAttribute("data-scale"),
  );
  await page.getByRole("button", { name: "Yakınlaştır", exact: true }).click();
  assert.equal(
    Number(await page.locator(".canvas-scroll").getAttribute("data-scale")),
    Math.min(5, oldScale + 0.1),
  );
  const stage = page.locator(".pixel-stage");
  const beforeDrag = await stage.getAttribute("style");
  const vp = await page.locator(".canvas-scroll").boundingBox();
  assert.ok(vp);
  const emptyFloor = () => page.locator(".office-viewport").evaluate(el => {
    const box=el.getBoundingClientRect();
    for(let y=box.top+80;y<box.bottom-40;y+=30)for(let x=box.left+12;x<box.right-80;x+=30)
      if(document.elementFromPoint(x,y)?.classList.contains("office-canvas"))return {x,y};
    throw new Error("No empty scene point found for camera dragging.");
  });
  const startDrag = await emptyFloor();
  await page.mouse.move(startDrag.x,startDrag.y);await page.mouse.down();
  await page.mouse.move(startDrag.x+70,startDrag.y+20,{steps:4});await page.mouse.up();
  await page.waitForFunction(before => document.querySelector(".pixel-stage")!.getAttribute("style")!==before,beforeDrag);
  const nextDrag = await emptyFloor();
  await page.mouse.move(nextDrag.x,nextDrag.y);await page.mouse.down();
  await page.mouse.move(nextDrag.x+1100,nextDrag.y,{steps:5});await page.mouse.up();
  await page
    .locator(".agent-row")
    .filter({ has: page.getByText("Selin", { exact: true }) })
    .click();
  await page.waitForTimeout(120);
  const revealed = await page
    .getByRole("button", { name: "Selin ile sohbet", exact: false })
    .boundingBox();
  assert.ok(
    revealed &&
      revealed.x >= vp.x &&
      revealed.x + revealed.width <= vp.x + vp.width,
    "List selection must pan to an offscreen agent.",
  );
  await page
    .locator(".rail")
    .getByRole("button", { name: "Genel sohbet", exact: true })
    .click();
  await page.getByRole("button", { name: "Sığdır", exact: true }).click();
  await page.getByRole("button", { name: "Büyüt", exact: false }).click();
  await page.waitForFunction(() =>
    Boolean(document.querySelector(".office-expanded")),
  );
  await page.waitForTimeout(250);
  await checkFit(page);
  await page.screenshot({
    path: resolve(".test-data/screenshots/ofis-buyuk.png"),
    fullPage: true,
    animations: "disabled",
    scale: "css",
  });
  await page
    .getByRole("button", { name: "Deniz ile sohbet", exact: false })
    .click();
  await page
    .locator(".conversation-heading")
    .getByRole("heading", { name: "Deniz", exact: true })
    .waitFor();
  await page
    .getByLabel("Mesajınız", { exact: true })
    .fill("Bu yalnız bir deneme mesajı.");
  await page.getByLabel("Mesajınız", { exact: true }).press("Enter");
  await page
    .getByRole("log", { name: "Yazışmalar" })
    .getByText(
      "Bu bir deneme cevabı. Mesajını aldım; birlikte inceleyebiliriz.",
      { exact: true },
    )
    .waitFor();
  await page.waitForFunction(
    () =>
      (document.querySelector(".agent-hit[aria-pressed=true] .agent-bubble")
        ?.textContent?.length || 0) > 0,
  );
  const speech = await page
    .locator(".agent-hit[aria-pressed=true] .agent-bubble")
    .boundingBox();
  const speechView = await page.locator(".canvas-scroll").boundingBox();
  assert.ok(
    speech &&
      speechView &&
      speech.x >= speechView.x &&
      speech.y >= speechView.y &&
      speech.x + speech.width <= speechView.x + speechView.width &&
      speech.y + speech.height <= speechView.y + speechView.height,
    "Speech bubbles must remain inside the viewport.",
  );
  await page.screenshot({
    path: resolve(".test-data/screenshots/ofis-ajan-sohbet.png"),
    fullPage: true,
    animations: "disabled",
    scale: "css",
  });
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Sohbeti aç", exact: false })
    .waitFor();
  // Esc closes chat first; the next Esc leaves the in-window expanded view.
  assert.equal(
    await page.locator(".office-expanded").count(),
    1,
    "The first Esc must preserve expanded view.",
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".office-expanded"));
  // Use the same overlay in browsers without the fullscreen API.
  await page.evaluate(() => {
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: undefined,
    });
  });
  await page.getByRole("button", { name: "Büyüt", exact: false }).click();
  await page.getByRole("button", { name: "Küçült", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".office-expanded"));
  await page
    .getByRole("button", { name: "Araştırma bölüm sohbeti", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Mesajın alıcısı").inputValue(),
    "department:demo-arastirma",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "Ofis", exact: true }).click();
  await page.getByRole("button", { name: "Büyüt", exact: false }).click();
  await page.waitForTimeout(250);
  const drawer = await page.locator(".floating-chat").boundingBox();
  assert.ok(
    drawer && drawer.width <= 390 && drawer.x >= 0 && drawer.x + drawer.width <= 390 && drawer.y > 80 && drawer.y + drawer.height <= 844,
    "Phone chat must open from the bottom.",
  );
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Phone pages must not overflow horizontally.",
  );
  await page.screenshot({
    path: resolve(".test-data/screenshots/telefon.png"),
    fullPage: true,
    animations: "disabled",
    scale: "css",
  });
  await page
    .getByLabel("Mesajın alıcısı", { exact: true })
    .selectOption("agent:demo-0");
  await page.waitForTimeout(120);
  const phoneAgent = await page
    .getByRole("button", { name: "Deniz ile sohbet", exact: false })
    .boundingBox();
  const phoneChat = await page.locator(".floating-chat").boundingBox();
  assert.ok(
    phoneAgent &&
      phoneChat &&
      phoneAgent.y >= 100 &&
      phoneAgent.y + phoneAgent.height < phoneChat.y,
    `Selected agents must remain above the phone drawer: ${JSON.stringify({phoneAgent,phoneChat})}` ,
  );
  const touch = await context.newCDPSession(page);
  const oldTouchScale = Number(
    await page.locator(".canvas-scroll").getAttribute("data-scale"),
  );
  const touchY = await page.evaluate(() => {
    const view=document.querySelector('.office-viewport')!,box=view.getBoundingClientRect();
    const chat=document.querySelector('.floating-chat')!.getBoundingClientRect();
    for(let y=box.top+24;y<Math.min(box.bottom,chat.top)-12;y+=8)
      if([10,50,70,270,290,330].every(x=>{const hit=document.elementFromPoint(x,y);return hit && view.contains(hit) && !hit.closest('button');}))return y;
    throw new Error("No open scene floor found for pinch zoom.");
  });
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: 70, y: touchY },
      { x: 270, y: touchY },
    ],
  });
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { x: 50, y: touchY },
      { x: 290, y: touchY },
    ],
  });
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { x: 10, y: touchY },
      { x: 330, y: touchY },
    ],
  });
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await page.waitForFunction(
    (old) =>
      Number(
        document.querySelector(".canvas-scroll")?.getAttribute("data-scale"),
      ) > old,
    oldTouchScale,
  );
  await touch.detach();
  assert.equal(await page.evaluate(() => devicePixelRatio), 2);
  await page.getByRole("button", { name: "Küçült", exact: true }).click();
  await page.getByRole("tab", { name: "Sohbet", exact: true }).click();
  const composeBounds = await page
    .getByLabel("Mesajınız", { exact: true })
    .boundingBox();
  assert.ok(
    composeBounds && composeBounds.y + composeBounds.height <= 784,
    "The phone composer must stay above the bottom toolbar.",
  );
  await page
    .getByLabel("Mesajın alıcısı", { exact: true })
    .selectOption("everyone");
  await page.getByRole("tab", { name: "Ofis", exact: true }).click();
  await page.getByRole("button", { name: "Sığdır", exact: true }).click();
  await checkFit(page, true);
  await page.screenshot({
    path: resolve(".test-data/screenshots/telefon.png"),
    scale: "css",
  });
  await page
    .getByRole("navigation", { name: "Telefon gezinmesi" })
    .getByRole("button", { name: "Ajanlar", exact: true })
    .click();
  assert.equal(await page.locator(".agents-table tbody tr").count(), 6);
  await page.setViewportSize({ width: 360, height: 800 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page
    .getByRole("navigation", { name: "Telefon gezinmesi" })
    .getByRole("button", { name: "Diğer", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Şirket kuralları", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Şirket kuralları", exact: true })
    .waitFor();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.setViewportSize({ width: 1920, height: 1080 });
  await nav("Ajanlar");
  await page.screenshot({
    path: resolve(".test-data/screenshots/ajanlar.png"),
    fullPage: true,
    animations: "disabled",
    scale: "css",
  });
  await page.getByLabel("Ajan ara", { exact: true }).fill("ECE");
  assert.equal(await page.locator(".agents-table tbody tr").count(), 1);
  await page.getByRole("heading", { name: "Ece", exact: true }).waitFor();
  await page.getByLabel("Ajan ara", { exact: true }).fill("");
  await page.getByRole("button", { name: "Araştırma", exact: true }).click();
  assert.equal(await page.locator(".agents-table tbody tr").count(), 1);
  assert.equal(await page.getByRole("button", { name: "Yakında", exact: true }).count(), 0);
  await nav("Zamanlanmış görevler");
  await page.getByRole("heading", { name: "Zamanlanmış görevler", exact: true }).waitFor();
  await nav("Ofis");
  await page.getByRole("button", { name: "Ofis işlemleri", exact: true }).click();
  await page
    .getByRole("button", { name: "Bitir", exact: true })
    .first()
    .click();
  assert.equal(
    JSON.stringify(store.snapshot()),
    before,
    "Demo mode must not change persistent data.",
  );
  previewSnapshot = undefined;
  await page.reload();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await nav("Bölümler");
  await page.getByRole("button", { name: "Bölüm aç", exact: true }).click();
  await page.getByLabel("Bölüm adı", { exact: true }).fill("Araştırma");
  await page
    .getByLabel("Açıklama", { exact: true })
    .fill("Kaynakları inceleyen ekip");
  await page.getByRole("button", { name: "Kaydet", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await nav("Ajanlar");
  await page.getByRole("button", { name: "Ajan ekle", exact: true }).click();
  await page.getByLabel("Ad", { exact: true }).fill("Deniz");
  await page.getByLabel("Unvan", { exact: true }).fill("Araştırma uzmanı");
  await page.getByRole("dialog").getByRole("combobox", { name: /^Bölüm/ }).selectOption(store.departments().find((d) => d.name === "Araştırma")!.id);
  await page
    .getByLabel("Ajana talimatınız", { exact: true })
    .fill("Kanıtları incele, Türkçe yaz.");
  await page.getByLabel("Model", { exact: true }).fill("test-modeli");
  await page.getByLabel("Saç biçimi", { exact: true }).selectOption("kivircik");
  await page.getByLabel("Alt kıyafet", { exact: true }).fill("#4d5362");
  await page.getByLabel("Gözlük", { exact: true }).check();
  await page.getByLabel("Kravat", { exact: true }).check();
  await page.getByLabel("Kulaklık", { exact: true }).check();
  const preview = page.locator(".appearance canvas");
  const beforeLook = await preview.evaluate((c) =>
    (c as HTMLCanvasElement).toDataURL(),
  );
  await page.getByLabel("Üst kıyafet", { exact: true }).fill("#be7849");
  await page.waitForFunction(
    (previous) =>
      document
        .querySelector<HTMLCanvasElement>(".appearance canvas")
        ?.toDataURL() !== previous,
    beforeLook,
  );
  await page.getByRole("dialog").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({
    path: resolve(".test-data/screenshots/ajan-formu.png"),
    scale: "css",
  });
  await page.getByText("Görünüm örnekleri", { exact: true }).click();
  await page
    .locator(".character-gallery")
    .screenshot({ path: resolve(".test-data/screenshots/karakterler.png") });
  await page.getByRole("button", { name: "Ajanı ekle", exact: true }).click();
  assert.equal(employees()[0].appearance.style, "kivircik");
  assert.equal(employees()[0].appearance.pants, "#4d5362");
  assert.equal(employees()[0].appearance.headphones, true);
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "Deniz", exact: true }).waitFor();
  await page.locator(".agents-table tbody tr").filter({ has: page.getByRole("heading", { name: "Deniz", exact: true }) }).getByRole("button", { name: "Düzenle", exact: true }).click();
  await page.getByLabel("Unvan", { exact: true }).fill("Kıdemli araştırmacı");
  await page
    .getByRole("button", { name: "Değişiklikleri kaydet", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(employees()[0].title, "Kıdemli araştırmacı");
  await nav("Şirket kuralları");
  await page
    .getByLabel("Ortak talimat", { exact: true })
    .fill("Kaynakları tarihleriyle yaz.");
  await page
    .getByRole("button", { name: "Kuralları kaydet", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Kuralları kaydet", exact: true })
    .waitFor({ state: "visible" });
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLButtonElement>(".rules-bottom button")
        ?.disabled === true,
  );
  assert.equal(store.rules(), "Kaynakları tarihleriyle yaz.");
  await nav("Ofis");
  await page
    .getByLabel("Mesajınız", { exact: true })
    .fill("Ekibe hoş geldiniz.");
  await page
    .getByRole("button", { name: "Mesajı gönder", exact: true })
    .click();
  await page
    .getByRole("log", { name: "Yazışmalar" })
    .getByText("Ekibe hoş geldiniz.", { exact: true })
    .waitFor();
  assert.equal(store.messages().at(-1)?.recipient_type, "everyone");
  await page.getByRole("button", { name: "Büyüt", exact: false }).click();
  await page
    .getByRole("button", { name: "Sohbeti küçült", exact: true })
    .click();
  const incoming = office.message(
    employees()[0].id,
    "everyone",
    null,
    "Canlı gelen mesaj.",
  );
  office.readMessage(incoming.id, employees()[0].id);
  await page
    .getByRole("button", { name: "Sohbeti aç, 1 okunmamış mesaj", exact: true })
    .waitFor();
  assert.equal(
    store
      .messages()
      .find((m) => m.id === incoming.id)
      ?.read_by?.includes("owner"),
    false,
  );
  const [readResponse] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/messages/${incoming.id}/read`) &&
        r.request().method() === "POST",
    ),
    page
      .getByRole("button", {
        name: "Sohbeti aç, 1 okunmamış mesaj",
        exact: true,
      })
      .click(),
  ]);
  assert.equal(readResponse.status(), 200);
  await page
    .getByRole("log", { name: "Yazışmalar" })
    .getByText("Canlı gelen mesaj.", { exact: true })
    .waitFor();
  assert.equal(await page.locator(".message").filter({ hasText: "Canlı gelen mesaj." }).locator(".message-receipt").count(), 0,
    "Read indicators appear only below owner messages.");
  assert.ok(
    store
      .messages()
      .find((m) => m.id === incoming.id)
      ?.read_by?.includes("owner"),
  );
  await page
    .getByRole("button", { name: "Deniz ile sohbet", exact: false })
    .click();
  await page.getByLabel("Mesajınız", { exact: true }).fill("Birebir merhaba.");
  await page.getByLabel("Mesajınız", { exact: true }).press("Shift+Enter");
  await page.getByLabel("Mesajınız", { exact: true }).press("Enter");
  await page
    .getByRole("log", { name: "Yazışmalar" })
    .getByText("Birebir merhaba.", { exact: true })
    .waitFor();
  assert.equal(store.messages().at(-1)?.recipient_id, employees()[0].id);
  assert.equal(store.messages().at(-1)?.recipient_type, "agent");
  await page.getByRole("tab", { name: "Genel", exact: true }).click();
  await page.getByLabel("Mesajınız", { exact: true }).fill("@Den");
  await page
    .getByRole("listbox", { name: "Ajan önerileri" })
    .getByRole("option", { name: "Deniz", exact: false })
    .click();
  assert.equal(
    await page.getByLabel("Mesajın alıcısı").inputValue(),
    `agent:${employees()[0].id}`,
  );
  await page
    .getByLabel("Mesajınız", { exact: true })
    .fill("Adını seçerek gönderiyorum.");
  await page.getByLabel("Mesajınız", { exact: true }).press("Enter");
  await page
    .getByRole("log", { name: "Yazışmalar" })
    .getByText("Adını seçerek gönderiyorum.", { exact: true })
    .waitFor();
  await page.getByRole("heading", { name: "Deniz", exact: true }).waitFor();
  await page.getByRole("button", { name: "Görev ver", exact: true }).click();
  await page
    .getByLabel("Görevin başlığı", { exact: true })
    .fill("Kaynağı gözden geçir");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Görev ver", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Görevler", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Kaynağı gözden geçir", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Not ekle", exact: true }).click();
  await page.getByLabel("Başlık", { exact: true }).fill("İlk not");
  await page
    .getByLabel("Notun içeriği", { exact: true })
    .fill("Notlar Türkçe ve okunabilir.");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Ekle", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByText("İlk not", { exact: true }).click();
  await page
    .getByText("Notlar Türkçe ve okunabilir.", { exact: true })
    .waitFor();
  await page
    .getByLabel("Kaynağı gözden geçir durumu", { exact: true })
    .selectOption("2");
  await page
    .locator(".task-column")
    .filter({
      has: page.getByRole("heading", { name: "Tamamlandı", exact: false }),
    })
    .getByRole("heading", { name: "Kaynağı gözden geçir", exact: true })
    .waitFor();
  await page
    .getByLabel("Kaynağı gözden geçir durumu", { exact: true })
    .selectOption("3");
  await page.getByText("Arşivde · 1 görev", { exact: true }).waitFor();
  await page.locator(".archived-tasks summary").click();
  await page
    .locator(".archived-tasks")
    .getByRole("heading", { name: "Kaynağı gözden geçir", exact: true })
    .waitFor();
  await page
    .getByLabel("Kaynağı gözden geçir durumu", { exact: true })
    .selectOption("2");
  await page
    .locator(".task-column")
    .filter({
      has: page.getByRole("heading", { name: "Tamamlandı", exact: false }),
    })
    .getByRole("heading", { name: "Kaynağı gözden geçir", exact: true })
    .waitFor();
  await page.screenshot({
    path: resolve(".test-data/screenshots/gorevler.png"),
    fullPage: true,
    animations: "disabled",
    scale: "css",
  });
  await nav("Ajanlar");
  await page
    .getByRole("button", { name: "Deniz için diğer işlemler", exact: true })
    .click();
  const priorRuns = runtime.runs().length;
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/snapshot")),
    page.getByRole("button", { name: "Şimdi çalıştır", exact: true }).click(),
  ]);
  assert.equal(runtime.runs().length, priorRuns + 1);
  await page.getByRole("tab", { name: "Hafıza notu", exact: true }).click();
  await page
    .getByLabel("Kalıcı kısa not")
    .fill("Önce kaynakları gözden geçir.");
  const [savedMemory] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/memory") && r.request().method() === "PUT",
    ),
    page.getByRole("button", { name: "Hafızayı kaydet", exact: true }).click(),
  ]);
  assert.equal(savedMemory.status(), 200);
  assert.equal(
    runtime.memory(employees()[0].id),
    "Önce kaynakları gözden geçir.",
  );
  await page
    .getByRole("button", { name: "Pencereyi kapat", exact: true })
    .click();
  runtime.heartbeat("browser-sahte");
  const lease = runtime.claim("browser-sahte")!;
  assert.ok(lease);
  await page.reload();
  await nav("Ajanlar");
  await page.getByRole("button", { name: "Deniz için diğer işlemler", exact: true }).click();
  await page.locator(`.agent-work button[data-run-id="${lease.run.id}"]`).click();
  await page.getByText("Talimat ve bağlam boyutu", { exact: true }).click();
  const contextText = await page.locator(".agent-work .runtime-card:has(h3)").innerText();
  assert.match(contextText, /yaklaşık \d+ token/);
  assert.match(contextText, /En büyük üç parça/);
  assert.match(contextText, /dahil değildir/);
  await page.getByRole("button", { name: "Pencereyi kapat", exact: true }).click();
  const approval = (await runtime.tool(lease.run, "onay_iste", {
    baslik: "Sonucu paylaşalım mı?",
    ayrinti: "Hazırlanan metni paylaşmak istiyorum.",
    tur: "dışarı",
  })) as { id: string };
  await page.reload();
  await nav("Ofis");
  await page.locator(".art-loading").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Deniz ile sohbet", exact: false }).click();
  await page
    .getByRole("heading", { name: "Onay kutusu", exact: true })
    .waitFor();
  await page.getByLabel("Karar notu").fill("Biraz daha incele.");
  const [decision] = await Promise.all([
    page.waitForResponse((r) =>
      r.url().endsWith(`/approvals/${approval.id}/decision`),
    ),
    page.getByRole("button", { name: "Reddet", exact: true }).click(),
  ]);
  assert.equal(decision.status(), 200);
  assert.equal(runtime.approvals()[0].state, "rejected");
  const chainRoot = runtime.enqueue(employees()[0].id, "Deneme", "Zincir freni denemesi", undefined, undefined, true, { maxDepth: 1, maxRuns: 1 })!;
  assert.equal(runtime.enqueue(employees()[0].id, "Devir", "Durmalı", chainRoot), null);
  await page.reload();
  const warning = page.getByRole("alert").filter({ hasText: "İş zinciri sınıra" });
  await warning.waitFor();
  const corner=await page.locator('.runtime-alerts').evaluate(el=>({position:getComputedStyle(el).position,width:el.getBoundingClientRect().width,right:el.getBoundingClientRect().right,viewport:innerWidth}));
  assert.equal(corner.position,'fixed');assert.ok(corner.width<=420);assert.ok(corner.viewport-corner.right<=14);
  await nav('Ajanlar');assert.equal(await warning.count(),1);await nav('Ofis');assert.equal(await warning.count(),1);
  await page.getByRole("button", { name: "Zincir uyarısını kapat", exact: true }).click();
  await warning.waitFor({ state: "hidden" });
  await page.reload(); await page.getByRole("navigation", {name:"Ana gezinme",exact:true}).waitFor();
  assert.equal(await warning.count(),0);
  await nav("Bağlantılar");
  await page.getByLabel("Bağlantı adı").fill("Deneme belgeleri");
  await page
    .getByLabel("Sunucudaki klasör yolu")
    .fill("/izinli-belgeler/deneme");
  await page.getByLabel("Klasör izni").selectOption("write");
  await page
    .getByRole("button", { name: "Bağlantıyı kaydet", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Deneme belgeleri", exact: true })
    .waitFor();
  assert.equal(runtime.links()[0].approved_write, true);
  await page.getByRole("button", { name: "Kaldır", exact: true }).click();
  await page
    .getByRole("heading", { name: "Deneme belgeleri", exact: true })
    .waitFor({ state: "hidden" });
  await nav("Kullanım ve kota");
  await page.getByLabel("Dönem").selectOption("7");
  await page.getByRole("heading", { name: "Deniz", exact: true }).waitFor();
  await nav("Ofis");
  await page
    .getByRole("button", { name: "Tümünü durdur", exact: true })
    .click();
  await page.getByRole("button", { name: "Ofis işlemleri", exact: true }).click();
  await page.getByRole("button", { name: "Devam et", exact: true }).waitFor();
  assert.equal(runtime.paused(), true);
  await page.getByRole("button", { name: "Devam et", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("main")?.getAttribute("aria-busy") !== "true");
  // A2.3: real Office records and a fake runner without model calls.
  const receiver = employees()[0];
  runtime.stop(receiver.id);
  runtime.runnerId = ""; runtime.heartbeatAt = 0;
  await page.reload(); await nav("Ofis");
  await page.getByLabel("Mesajın alıcısı").selectOption("everyone");
  await page.getByLabel("Mesajınız", { exact: true }).fill("A2.3 anılmadan merhaba");
  await page.getByLabel("Mesajınız", { exact: true }).press("Enter");
  await page.getByText("Kimse anılmadı; bu mesaja cevap gelmeyecek", { exact: true }).last().waitFor();
  await page.getByText("Cevap almak için @ ile bir ajan seçin.", { exact: true }).waitFor();
  await nav("Şirket kuralları");
  await page.getByLabel("Genel sohbette anılmadan yazılana kim cevap verir?").selectOption(receiver.id);
  await page.getByRole("button", { name: "Sınırları kaydet", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("main")?.getAttribute("aria-busy") !== "true");
  assert.equal(runtime.settings().greeterAgentId, receiver.id);
  await nav("Ofis");
  await page.getByLabel("Mesajınız", { exact: true }).fill("A2.3 şimdi bunu cevapla");
  await page.getByLabel("Mesajınız", { exact: true }).press("Enter");
  const ownerMessage = page.locator(".message").filter({ hasText: "A2.3 şimdi bunu cevapla" });
  await ownerMessage.getByText("Çalıştırıcı bağlı değil — bağlantı kurulana kadar bekliyor.", { exact: false }).waitFor();
  runtime.heartbeat("browser-sahte");
  const answering = runtime.claim("browser-sahte")!;
  assert.ok(answering.prompt.startsWith("ŞU AN CEVAPLAMAN GEREKEN MESAJ BUDUR\nA2.3 şimdi bunu cevapla"));
  await page.reload(); await ownerMessage.getByText("Deniz çalışıyor…", { exact: true }).waitFor();
  await runtime.tool(answering.run, "teslim_et", { baslik: "Sohbet çıktısı", ozet: "Kısa çıktı", dosyalar: ["cevap.txt"] }, [{ path: "cevap.txt", content: Buffer.from("A2.3 hazır çıktı").toString("base64") }]);
  runtime.finish(answering.run.id, "completed", "Sorunu aldım.", "", { input_tokens: 100, output_tokens: 20 });
  await page.reload(); await ownerMessage.getByText("Deniz: cevaplandı", { exact: true }).waitFor();
  await page.locator(".output-card").getByRole("button", { name: "Önizle", exact: true }).click();
  await page.locator(".output-card pre").getByText("A2.3 hazır çıktı", { exact: true }).waitFor();
  await page.getByLabel("Mesajınız", { exact: true }).fill("A2.3 bütçe denemesi");
  await page.getByLabel("Mesajınız", { exact: true }).press("Enter");
  await page.locator(".message").filter({ hasText: "A2.3 bütçe denemesi" }).waitFor();
  runtime.heartbeat("browser-sahte"); const budgetRun = runtime.claim("browser-sahte")!;
  assert.equal(budgetRun.run.agent_id, receiver.id);
  // Exceed the agent budget; higher chain/daily limits also stop the single retry when exceeded.
  const overAgentBudget = receiver.policy!.inputTokenBudget + 1;
  runtime.update(budgetRun.run.id, "usage", "Kullanım", { input_tokens: overAgentBudget });
  await page.reload();
  const budgetMessage = page.locator(".message").filter({ hasText: "A2.3 bütçe denemesi" });
  await budgetMessage.getByText(/sırada|bağlı değil/).waitFor();
  const budgetRetry=runtime.claim("browser-sahte")!;
  assert.equal(budgetRetry.session?.provider_id,null);
  runtime.update(budgetRetry.run.id,"usage","Kullanım",{input_tokens:overAgentBudget});
  await page.reload();
  await budgetMessage.getByText(/bütçede kesildi/).waitFor();
  assert.equal(await budgetMessage.getByRole("button", { name: "Yeniden dene", exact: true }).count(), 1);
  const budgetEvents=page.locator(".chat-event").filter({hasText:"2 bütçede kesilen çalışma"});
  await budgetEvents.getByRole("button",{name:"Göster",exact:true}).click();
  await budgetEvents.getByRole("button", { name: "Yeniden dene", exact: true }).first().click();
  await budgetMessage.getByText(/sırada|bağlı değil/).waitFor();
  const chainWarnings = page.getByRole("button", { name: "Zincir uyarısını kapat", exact: true });
  while (await chainWarnings.count()) await chainWarnings.first().click();
  await page.locator(".conversation-heading").getByRole("button", { name: "Durdur", exact: true }).click();
  assert.equal(runtime.paused(), false, "Stopping chat must not stop the whole office.");
  await page.locator(".conversation-heading .chat-stop").waitFor({ state: "hidden" });
  const failedHandoff = await office.handoff(null, receiver.id, "A2.3 başlatılamayan devir", "Tekrar denenecek iş");
  runtime.failHandoff(failedHandoff.id, "Geçici başlatma denemeleri tükendi.");
  await nav("Görevler ve notlar");
  await page.getByRole("combobox", { name: /^Ajan/ }).selectOption(receiver.id);
  await page.locator(".pending-handoffs").getByRole("button", { name: "Yeniden dene", exact: true }).click();
  assert.equal(store.snapshot().handoffs.find((h) => h.id === failedHandoff.id)!.status, "created");
  runtime.stop(receiver.id);
  await nav("Olaylar");
  await page.getByRole("heading", { name: "Olaylar", exact: true }).waitFor();
  assert.ok((await page.locator(".event-timeline li").count()) > 0);
  await nav("Bölümler");
  await page.locator(".department-card").filter({ has: page.getByRole("heading", { name: "Araştırma", exact: true }) }).getByRole("button", { name: "Sil", exact: true }).click();
  await page.getByText("Bu bölümde ajan var.", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Kapat", exact: true }).click();
  await nav("Ajanlar");
  await page
    .getByRole("button", { name: "Deniz için diğer işlemler", exact: true })
    .click();
  await page.getByRole("button", { name: "Sil", exact: true }).click();
  await page
    .getByLabel("Tududi hesabını, görevlerini ve notlarını da sil.", {
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "Ajanı sil", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(employees().length, 0);
  assert.equal(store.agents()[0].id, director.id, "The built-in Director must be preserved.");
  assert.equal(fake.users.length, 1, "Accounts must persist during the 24-hour trash period.");
  assert.equal(runtime.director.trashList().length, 1);
  store.db.prepare("UPDATE office_trash SET expires_at=0 WHERE id=?").run(receiver.id);
  await runtime.director.expireTrash();
  assert.equal(fake.users.length, 0, "After expiry, only the deleted agent's account is removed.");
  console.log("B2.3.1 agent chat and management flows passed; built-in Director and trashed account preserved.");
  const seed = demoSnapshot(
    {
      departments: [],
      agents: [],
      messages: [],
      events: [],
      handoffs: [],
      rules: "",
    },
    0,
  );
  const sceneMeasurements: unknown[] = [];
  for (const departments of [1, 6])
    for (const agents of [6, 14]) {
      previewSnapshot = {
        ...seed,
        departments: seed.departments.slice(0, departments),
        agents: Array.from({ length: agents }, (_, i) => ({
          ...seed.agents[i % 6],
          id: `demo-layout-${i}`,
          name: `Ekip ${i + 1}`,
          department_id: seed.departments[i % departments].id,
          desk_x: 0,
          desk_y: 0,
        })),
      };
      await page.reload();
      await page.getByRole("button", { name: "Ofis işlemleri", exact: true }).click();
      await page
        .getByRole("button", { name: "Deneme modu", exact: true })
        .click();
      await page.locator(".art-loading").waitFor({ state: "hidden" });
      await checkFit(page);
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value;
        }, theme);
        for (const [width, height, suffix] of [
          [1920, 1080, "-1920"],
          [1366, 768, "-1366"],
          [1280, 640, ""],
        ] as const) {
          await page.setViewportSize({ width, height });
          const measurement = await checkFit(page);
          sceneMeasurements.push({
            width,
            height,
            agents,
            departments,
            theme,
            ...measurement,
          });
          await checkActors(page, previewSnapshot, 60);
          await page.screenshot({
            path: resolve(
              `.test-data/screenshots/ofis-${agents}-ajan-${departments}-bolum-${theme === "dark" ? "koyu" : "acik"}${suffix}.png`,
            ),
            scale: "css",
          });
          console.log(
            `Scene passed: ${width}×${height}, ${agents} agents, ${departments} departments, ${theme === "dark" ? "dark" : "light"} theme.`,
          );
        }
      }
      await page.setViewportSize({ width: 1920, height: 1080 });
    }
  previewSnapshot = {
    ...seed,
    departments: seed.departments.slice(0, 1),
    agents: seed.agents.map((a, i) => ({
      ...a,
      department_id: seed.departments[0].id,
      status: i === 1 ? "calisiyor" : "kapali",
    })),
  };
  await page.reload();
  await page.locator(".art-loading").waitFor({ state: "hidden" });
  await checkFit(page);
  await checkScreens(page, previewSnapshot);
  writeFileSync(
    resolve(".test-data/screenshots/a1-5-dogrulama.json"),
    JSON.stringify(
      { movementSamplesPerCombination: 60, combinations: sceneMeasurements },
      null,
      2,
    ) + "\n",
  );
  previewSnapshot = undefined;
  await checkChat(page, longChatFixture({ ...seed, runtime: runtime.snapshot() }), (value) => {
    previewSnapshot = value; office.changed();
  }, () => {
    let release!: () => void;
    snapshotGate = new Promise<void>((resolve) => { release = resolve; });
    return () => { release(); snapshotGate = undefined; };
  });
  previewSnapshot = undefined;
  await page.reload();
  await page.waitForFunction(() => document.querySelector("main")?.getAttribute("aria-busy") === "false");
  const [logoutResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/logout") && response.request().method() === "POST"),
    page.locator(".rail .owner-exit").click(),
  ]);
  assert.equal(logoutResponse.status(), 200);

  await page
    .getByRole("heading", { name: "İçeri buyurun.", exact: true })
    .waitFor();
  assert.deepEqual(
    outsideRequests,
    [],
    "Fonts and images must require no external requests.",
  );
  assert.deepEqual(errors, [], "The browser must have no JavaScript errors.");
  assert.deepEqual(failures, [], "Browser flows must have no server errors.");
  console.log(
    "Browser checks passed: themes, forms, tasks/notes, approvals, outputs, connections, usage, appearance, mobile and motion; A2.4 covers four sizes/two themes, 66+ messages, 20 agents/10 departments, thin scrollbars, event details/retry, chat stop, safe/collapsible Markdown, loading/empty states, growing composer and reading-position preservation.",
  );
} catch (error) {
  console.error("Failed browser requests:", failures);
  console.error("Browser errors:", errors);
  await page.screenshot({
    path: resolve(".test-data/browser-failure.png"),
    scale: "css",
  });
  throw error;
} finally {
  await browser.close();
  await app.close();
  cleanup(config);
}
