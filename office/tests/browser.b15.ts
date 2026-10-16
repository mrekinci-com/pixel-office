import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createApp } from "../server/app.js";
import { testConfig, fakeTududi, cleanup } from "./helpers.js";
import { demoSnapshot } from "../src/demo.js";
import { auditAnnotations, auditPage, auditSeats } from "./visual.audit.js";
import type { Snapshot } from "../shared/types.js";
import {makeWorld,TILE} from "../src/pixel/world.js";
const visual = process.argv.includes("--visual"), updating = process.argv.includes("--update-baselines");
const cache = resolve(".cache/runtime");
mkdirSync(cache, { recursive: true });
process.env.TMPDIR = cache;
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(".cache/browsers");
const { chromium } = await import("playwright");
const development = process.argv.includes("--development"), staticDir = development ? resolve(".test-data/b15-client") : undefined;
if (development) {
    const { build } = await import("vite");
    await build({ envFile: false, logLevel: "warn", build: { outDir: staticDir, emptyOutDir: true } });
}
const config = testConfig(), fake = fakeTududi(), { app } = await createApp(config, { fetcher: fake.fetcher, background: false, staticDir });
const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ["--hide-scrollbars"], args: ["--no-sandbox"], downloadsPath: cache,
    env: { ...process.env, LD_LIBRARY_PATH: [resolve(".cache/system-libs/usr/lib/x86_64-linux-gnu"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") } });
const seed = demoSnapshot({ departments: [], agents: [], messages: [], events: [], handoffs: [], rules: "" }, 0);
const baseline = resolve("tests/__screenshots__"), current = resolve(".test-data/visual-b15/current");
mkdirSync(current, { recursive: true });
const files: string[] = [], measurements: unknown[] = [], failures: string[] = [];
async function settleScene(page: import("playwright").Page) {
    await page.waitForFunction(() => {
        const view = document.querySelector<HTMLElement>(".office-viewport"), canvas = document.querySelector<HTMLElement>(".office-canvas");
        if (!view || !canvas || canvas.dataset.renderedCols !== view.dataset.cols || canvas.dataset.renderedRows !== view.dataset.rows)
            return false;
        const scale = Number(view.dataset.scale);
        return [...document.querySelectorAll<HTMLElement>(".agent-label,.agent-bubble")].filter(el => getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility === "visible")
            .every(el => Math.abs(parseFloat(getComputedStyle(el).fontSize) * scale - 12) < .01);
    });
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}
async function capture(page: import("playwright").Page, name: string) {
    if (!visual)
        return;
    await page.evaluate(async () => {
        await document.fonts.ready;
        const frame = () => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
        document.documentElement.style.transform = "translate(1px,1px)";
        await frame();
        document.documentElement.style.transform = "";
        await frame();
    });
    const options = { scale: "css", animations: "disabled", caret: "hide" } as const;
    let shot = await page.screenshot(options), stable = false;
    for (let i = 0; i < 8; i++) {
        const next = await page.screenshot(options);
        if (shot.equals(next)) {
            stable = true;
            break;
        }
        shot = next;
    }
    assert.ok(stable, name + ": two consecutive captures must match");
    const file = name + ".png";
    writeFileSync(resolve(current, file), shot);
    files.push(file);
    const crop = name + "-yakin-2x.png";
    await page.locator(".office-viewport").screenshot({ path: resolve(current, crop), scale: "device", animations: "disabled", caret: "hide" });
    files.push(crop);
    if (updating)
        for (const f of [file, crop])
            copyFileSync(resolve(current, f), resolve(baseline, f));
}
async function auditMonitors(page: import("playwright").Page, snapshot: Snapshot) {
    const monitors = JSON.parse(await page.locator(".office-canvas").getAttribute("data-monitors") || "[]");
    assert.equal(monitors.length, 24);
    assert.equal(monitors.filter((m: {
        state: string;
    }) => m.state === "working").length, snapshot.agents.filter(a => a.status === "calisiyor").length);
    assert.ok(monitors.filter((m: {
        id: string | null;
    }) => !m.id).every((m: {
        state: string;
    }) => m.state === "off"));
    // B1.6: verify actual canvas content against state, not just data fields.
    const layout=await page.locator(".office-viewport").getAttribute("data-layout");
    const world=makeWorld(snapshot.departments,snapshot.agents,layout === "balanced" ? "balanced" : "wide");
    const monitorPixels=await page.evaluate(boxes=>{
      const canvas=document.querySelector<HTMLCanvasElement>('.office-canvas')!,ctx=canvas.getContext('2d')!;
      return boxes.map(box=>{
        const pixels=ctx.getImageData(box.x,box.y,64,44).data,colors=new Set<string>();
        for(let i=0;i<pixels.length;i+=4)colors.add(`${pixels[i]},${pixels[i+1]},${pixels[i+2]}`);
        return {id:box.id,colors:[...colors]};
      });
    },world.furniture.filter(f=>f.kind==='desk').flatMap(f=>[0,1].map(i=>({id:f.seatAgentIds?.[i]||null,x:(f.x+5.5+i*11)*TILE-32,y:f.y*TILE-42}))));
    for(const monitor of monitorPixels) {
      const state=monitors.find((m:{id:string|null})=>m.id===monitor.id)?.state;
      const color=({working:'118,216,179',idle:'82,140,159',waiting:'255,231,160',off:'54,67,75'} as Record<string,string>)[state];
      assert.ok(monitor.colors.includes(color),`${monitor.id||'Empty seat'}: ${state} screen must actually render`);
    }
    return {monitors,monitorPixels};
}
async function auditFit(page: import("playwright").Page, desktop: boolean) {
    const fill = await page.evaluate(() => {
        const map=document.querySelector('.pixel-stage')!.getBoundingClientRect(),view=document.querySelector('.office-viewport')!.getBoundingClientRect();
        const width=map.width/view.width,height=map.height/view.height;
        return {width,height,shortSide:view.width<view.height ? width : height};
    });
    if(desktop) {
        assert.ok(fill.width>=.88 && fill.height>=.88, `Fit occupancy: ${JSON.stringify(fill)}`);
        assert.ok(fill.shortSide>=.96, `Fit short edge: ${JSON.stringify(fill)}`);
        assert.ok(fill.width<=1.002 && fill.height<=1.002,"Fit must not crop the scene");
    } else assert.equal(await page.locator('.office-viewport').getAttribute('data-layout'),'balanced');
    const texts=await page.locator('.agent-bubble').evaluateAll(els=>els.filter(el=>el.textContent?.trim()).map(el=>({text:el.textContent!,source:(el as HTMLElement).title,visible:getComputedStyle(el).visibility==='visible'})));
    for(const bubble of texts) {
        assert.ok(bubble.visible,"Populated bubbles must be visible");
        assert.ok(bubble.text.split('\n').length<=2,"Bubbles must use at most two lines");
        for(const word of bubble.text.replace(/…/g,'').split(/\s+/).filter(Boolean)) assert.ok(bubble.source.split(/\s+/).includes(word),"Bubbles must use complete source words");
        if(desktop && bubble.source==='Kaynakları inceliyorum') assert.equal(bubble.text.replace(/\n/g,' '),bubble.source,"Both words must be visible");
    }
    return fill;
}
try {
    for (const size of [{ width: 1920, height: 1000 }, { width: 1366, height: 768 }, { width: 1280, height: 640 }, { width: 390, height: 844 }])
        for (const theme of ["light", "dark"]) {
            const context = await browser.newContext({ viewport: size, locale: "tr-TR", deviceScaleFactor: 2, reducedMotion: "reduce" });
            await context.addInitScript({ content: `window.__name=value=>value;localStorage.setItem('po-tema','${theme}');const Original=Date;globalThis.Date=class extends Original{constructor(...args){super(...(args.length?args:['2026-10-13T10:00:00Z']));}static now(){return 1791885600000;}};const raf=requestAnimationFrame.bind(window);performance.now=()=>10000;window.requestAnimationFrame=cb=>raf(()=>cb(10000));` });
            let snapshot: Snapshot = seed;
            await context.route("**/*", async (route) => {
                const request = route.request(), url = new URL(request.url());
                if (url.origin !== "http://ofis.test") {
                    failures.push("External request");
                    await route.abort();
                    return;
                }
                if (url.pathname === "/api/snapshot") {
                    await route.fulfill({ json: snapshot });
                    return;
                }
                if (url.pathname === "/api/live") {
                    await route.fulfill({ contentType: "text/event-stream", body: "retry: 60000\nevent: ready\ndata: {}\n\n" });
                    return;
                }
                if (url.pathname.endsWith("/read")) {
                    await route.fulfill({ json: { ok: true } });
                    return;
                }
                const response = await app.inject({ method: request.method() as any, url: url.pathname + url.search, remoteAddress: `127.0.0.${Math.floor(size.width / 100) + (theme === "dark" ? 50 : 0)}`, headers: { ...await request.allHeaders(), host: url.host }, payload: request.postData() || undefined });
                await route.fulfill({ status: response.statusCode, headers: Object.fromEntries(Object.entries(response.headers).filter(([, v]) => v !== undefined).map(([k, v]) => [k, Array.isArray(v) ? v.join("\n") : String(v)])), body: response.rawPayload });
            });
            const page = await context.newPage();
            page.on("pageerror", e => failures.push(e.message));
            await page.goto("http://ofis.test");
            await page.getByLabel("Sahip şifresi").fill(config.ownerPassword);
            await page.getByRole("button", { name: "Ofisi aç", exact: true }).click();
            for (const count of [4, 14, 24]) {
                snapshot = { ...seed, agents: Array.from({ length: count }, (_, i) => ({ ...seed.agents[i % 6], id: `b15-${i}`, name: `Ekip ${i + 1}`, department_id: seed.departments[i % 6].id, current_job: "Kaynakları inceliyorum", status: (["calisiyor", "bosta", "bekliyor", "kapali"] as const)[i % 4] })), messages: [], events: [] };
                await page.reload();
                await page.locator(".art-loading").waitFor({ state: "hidden" });
                await settleScene(page);
                assert.equal(await page.locator('.agent-hit[data-seated="true"]').count(), snapshot.agents.filter(a => a.status !== "kapali").length);
                const {monitors,monitorPixels}=await auditMonitors(page,snapshot);
                const normalFill=await auditFit(page, size.width > 900);
                await auditSeats(page, snapshot);
                await auditAnnotations(page, snapshot);
                await auditPage(page);
                await page.getByRole("button", { name: "Ofis işlemleri", exact: true }).click();
                assert.equal(await page.getByRole("button", { name: snapshot.agents.filter(a=>a.status!=="kapali").length>3 ? "Büyük toplantı · yakında" : "Toplantıya çağır", exact: true }).count(), 1);
                await page.getByRole("button", { name: "Ofis işlemleri", exact: true }).click();
                if(!visual && size.width>900) await page.getByLabel("Mesajınız",{exact:true}).fill("Yerleşim değişirken taslak korunur.");
                const suffix = `${count}-${size.width}x${size.height}-${theme}`;
                await capture(page, `b15-harita-${suffix}`);
                await page.getByRole("button", { name: "Büyüt", exact: true }).click();
                await settleScene(page);
                if(!visual && size.width>900) {
                    if(await page.locator(".chat-launcher").count()) await page.getByRole("button",{name:/^Sohbeti aç/}).click();
                    assert.equal(await page.getByLabel("Mesajınız",{exact:true}).inputValue(),"Yerleşim değişirken taslak korunur.");
                }
                await auditSeats(page, snapshot);
                await auditAnnotations(page, snapshot);
                const expandedFill=await auditFit(page, size.width > 900);
                await auditMonitors(page,snapshot);
                assert.equal(await page.locator(".office-viewport").getAttribute("data-layout"),size.width > 900 ? "wide" : "balanced");
                await auditPage(page);
                await capture(page, `b15-buyuk-${suffix}`);
                await page.getByRole("button", { name: "Küçült", exact: true }).click();
                if(!visual && size.width>900) {
                    assert.equal(await page.getByLabel("Mesajınız",{exact:true}).inputValue(),"Yerleşim değişirken taslak korunur.");
                    await page.getByLabel("Mesajınız",{exact:true}).fill("");
                }
                measurements.push({ size, theme, count, normalFill, expandedFill, monitors, monitorPixels });
            }
            if(!visual && size.width===1920 && theme==="light") {
                // Chromium cannot resize the viewport while native fullscreen is active.
                // Earlier passes test the native API; use the CSS expanded view here.
                await page.evaluate(()=>Object.defineProperty(document.documentElement,'requestFullscreen',{configurable:true,value:()=>Promise.reject(new Error('Pencere boyutu denetimi'))}));
                await page.getByRole("button",{name:"Büyüt",exact:true}).click();
                await page.waitForFunction(()=>document.querySelector<HTMLElement>('.office-viewport')?.dataset.layout==='wide');
                await settleScene(page);
                for(const [width,expected] of [[1540,'wide'],[1400,'balanced'],[1560,'balanced'],[1620,'wide']] as const) {
                    await page.setViewportSize({width,height:1000});
                    await page.waitForFunction(expected=>document.querySelector<HTMLElement>('.office-viewport')?.dataset.layout===expected,expected);
                    await settleScene(page);
                    await auditSeats(page,snapshot);
                }
                await page.setViewportSize(size);
                await page.getByRole("button",{name:"Küçült",exact:true}).click();
                await settleScene(page);
                await page.getByRole("separator",{name:"Sohbet bölmesinin genişliği"}).press('ArrowRight');
                const saved=await page.evaluate(()=>localStorage.getItem('po-sohbet-oran'));
                await page.setViewportSize({width:1366,height:768});
                await settleScene(page);
                assert.equal(await page.evaluate(()=>localStorage.getItem('po-sohbet-oran')),saved);
                await page.reload(); await settleScene(page);
                const split=await page.locator('.office-layout').evaluate(el=>(el as HTMLElement).style.getPropertyValue('--chat-split'));
                assert.equal(parseFloat(split),Number(saved),"Saved width must survive reload");
                console.log("B1.8 viewport threshold, hysteresis, drafts and width preference passed");
            }
            await context.close();
            console.log(`B1.5 map/seats/screens passed: ${size.width}×${size.height}, ${theme}, 4/14/24 agents`);
        }
    if (!visual) {
        const context = await browser.newContext({ viewport: { width: 1920, height: 1000 }, locale: "tr-TR", deviceScaleFactor: 2, reducedMotion: "no-preference" });
        await context.addInitScript({ content: "window.__name=value=>value;localStorage.setItem('po-hareket','sakin');let clock=0;window.cancelAnimationFrame=id=>clearTimeout(id);window.requestAnimationFrame=cb=>setTimeout(()=>cb(clock+=100),0);" });
        let snapshot: Snapshot = seed;
        await context.route("**/*", async (route) => {
            const request = route.request(), url = new URL(request.url());
            if (url.origin !== "http://ofis.test") {
                await route.abort();
                failures.push("External request");
                return;
            }
            if (url.pathname === "/api/snapshot") {
                await route.fulfill({ json: snapshot });
                return;
            }
            if (url.pathname === "/api/live") {
                await route.fulfill({ contentType: "text/event-stream", body: "retry: 60000\nevent: ready\ndata: {}\n\n" });
                return;
            }
            const response = await app.inject({ method: request.method() as any, url: url.pathname + url.search, remoteAddress: "127.0.0.199", headers: { ...await request.allHeaders(), host: url.host }, payload: request.postData() || undefined });
            await route.fulfill({ status: response.statusCode, headers: Object.fromEntries(Object.entries(response.headers).filter(([, v]) => v !== undefined).map(([k, v]) => [k, Array.isArray(v) ? v.join("\n") : String(v)])), body: response.rawPayload });
        });
        const page = await context.newPage();
        page.on("pageerror", e => failures.push(e.message));
        await page.goto("http://ofis.test");
        await page.getByLabel("Sahip şifresi").fill(config.ownerPassword);
        await page.getByRole("button", { name: "Ofisi aç", exact: true }).click();
        for (const expanded of [false,true]) for (const count of [2, 3]) {
            snapshot = { ...seed, agents: Array.from({ length: count }, (_, i) => ({ ...seed.agents[i % 6], id: `meeting-${i}`, name: `Ekip ${i + 1}`, department_id: seed.departments[i % 6].id, status: "bosta" })), messages: [], events: [] };
            await page.reload();
            await page.locator(".art-loading").waitFor({ state: "hidden" });
            if(expanded) await page.getByRole("button",{name:"Büyüt",exact:true}).click();
            await settleScene(page);
            await page.getByRole("button", { name: "Ofis işlemleri", exact: true }).click();
            await page.getByRole("button", { name: "Toplantıya çağır", exact: true }).click();
            await page.getByRole("button", { name: "Ofis işlemleri", exact: true }).click();
            await page.waitForFunction(count => document.querySelectorAll('.agent-hit[data-rest-id^="meeting-"][data-seated="true"]').length === count, count, { timeout: 90000 });
            const directions = await page.locator('.agent-hit').evaluateAll(els => els.map(el => (el as HTMLElement).dataset.direction));
            assert.ok(directions.includes("up") && directions.includes("down"));
            assert.ok(JSON.parse(await page.locator(".office-canvas").getAttribute("data-monitors") || "[]").every((m: {
                state: string;
            }) => m.state === "off"));
            await page.locator('.office-viewport').screenshot({ path: resolve(`.test-data/b15-toplanti-${expanded ? "wide" : "balanced"}-${count}.png`), scale: "device" });
            await page.waitForFunction(count => document.querySelectorAll('.agent-hit[data-seated="true"][data-rest-id=""]').length === count, count, { timeout: 90000 });
            await page.emulateMedia({ reducedMotion: "reduce" });
            await auditSeats(page, snapshot);
            await page.emulateMedia({ reducedMotion: "no-preference" });
            console.log(`B1.8 real meeting and return passed: ${expanded ? "wide" : "balanced"}, ${count} agents`);
        }
        await context.close();
    }
    assert.deepEqual(failures, []);
    if (visual) {
        const manifest = resolve(baseline, "b15-taban.json");
        if (updating)
            writeFileSync(manifest, JSON.stringify({ browser: browser.version(), files: files.toSorted() }, null, 2) + "\n");
        else {
            assert.deepEqual(files.toSorted(), JSON.parse(readFileSync(manifest, "utf8")).files);
            const comparison = spawnSync("python3", ["scripts/compare-visual.py", baseline, current, ...files], { encoding: "utf8", env: { ...process.env, PYTHONPATH: resolve(".cache/python") }, maxBuffer: 8 * 1024 * 1024 });
            assert.equal(comparison.status, 0, comparison.stdout + comparison.stderr);
            console.log(comparison.stdout.trim());
        }
    }
    writeFileSync(resolve(visual ? ".test-data/b15-visual.json" : ".test-data/b15-browser.json"), JSON.stringify({ visual, updating, files, measurements }, null, 2) + "\n");
}
finally {
    await browser.close();
    await app.close();
    cleanup(config);
}
