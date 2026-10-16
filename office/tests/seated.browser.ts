import assert from "node:assert/strict";
import { resolve } from "node:path";
import { build } from "vite";
import type { Page } from "playwright";
import type * as Probe from "./seated.probe.js";
import { MIN_SEATED_HEIGHT_RATIO, MAX_CHAIR_DESK_GAP } from "../src/pixel/seating.js";
declare global { interface Window { officeSeatProbe: typeof Probe } }
let probeCode: Promise<string> | undefined;
const routedPages = new WeakSet<Page>();
export async function installSeatProbe(page: Page) {
  if (await page.evaluate(() => Boolean(window.officeSeatProbe))) return;
  probeCode ||= (async () => {
    // Library builds keep React's NODE_ENV branch unless it is defined explicitly.
    // The G2 translation imports now reach React through the shared scene modules.
    const result = await build({ configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, build: { write: false,
      lib: { entry: resolve("tests/seated.probe.ts"), formats: ["iife"], name: "officeSeatProbe" }, minify: false } });
    const output = (Array.isArray(result) ? result[0] : result) as { output: { type: string; code?: string }[] };
    return output.output.find((item) => item.type === "chunk")!.code!;
  })();
  const code = await probeCode;
  if (!routedPages.has(page)) {
    await page.route("http://ofis.test/__tests/seated.js", (route) => route.fulfill({ contentType: "application/javascript", body: code }));
    routedPages.add(page);
  }
  await page.addScriptTag({ url: "http://ofis.test/__tests/seated.js" });
  assert.ok(await page.evaluate(() => typeof window.officeSeatProbe?.scene === "function"), "The scene audit must load in the browser.");
}
export function assertSeatPixels(result: { visibleHeight: number; headHeight: number; torsoPixels: number; expectedPixels: number; matchedPixels: number }) {
  assert.ok(result.headHeight > 0 && result.visibleHeight / result.headHeight >= MIN_SEATED_HEIGHT_RATIO,
    `Seated visible height must be at least 1.6 times head height: ${JSON.stringify(result)}`);
  assert.ok(result.torsoPixels >= 40, "Shoulders and upper back must appear in the actual rendering.");
  assert.equal(result.matchedPixels, result.expectedPixels, "Upper-body pixels must remain uncovered in the real scene.");
}
export async function auditSeatVariants(page: Page) {
  await installSeatProbe(page);
  const variants = await page.evaluate(() => window.officeSeatProbe.variants());
  for (const result of variants) {
    assertSeatPixels(result);
    assert.ok(result.headPreserved, `${result.style}: preserve rear-view hair, skin and hat.`);
    assert.ok(result.shirtPixels >= 40, `${result.style}: clothing color must appear on shoulders and upper back (${result.shirtPixels}).`);
  }
  const directions=await page.evaluate(()=>window.officeSeatProbe.directions());
  for(const pose of directions){assert.ok(pose.upper>200,`${pose.style}/${pose.direction}: upper body`);assert.equal(pose.feet,0,`${pose.style}/${pose.direction}: no standing legs`);}
  // The audit rejects the previous head-only and distant-chair defects.
  assert.throws(() => assertSeatPixels({ ...variants[0], visibleHeight: variants[0].headHeight, torsoPixels: 0 }));
  return { variants: variants.length, minHeightRatio: Math.min(...variants.map((v) => v.visibleHeight / v.headHeight)),
    minTorsoPixels: Math.min(...variants.map((v) => v.torsoPixels)),
    minShirtPixels: Math.min(...variants.map((v) => v.shirtPixels)), maxGap: MAX_CHAIR_DESK_GAP };
}
