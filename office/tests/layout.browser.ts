import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "playwright";
import type { Snapshot } from "../shared/types.js";
import { CHARACTER_WIDTH, CHARACTER_HEIGHT, CHARACTER_X, CHARACTER_Y } from "../src/pixel/characterGeometry.js";
import { makeWorld, TILE } from "../src/pixel/world.js";
import { FLOOR_PALETTES, furnitureAsset } from "../src/pixel/furniture.js";

mkdirSync(resolve(".test-data/screenshots"), { recursive: true });

export async function checkFit(page: Page, mobile = false) {
  await page.waitForFunction(() => {
    const view = document.querySelector(".canvas-scroll"),
      scene = document.querySelector(".pixel-stage");
    if (!view || !scene) return false;
    const a = view.getBoundingClientRect(),
      b = scene.getBoundingClientRect();
    return (
      b.width > 0 &&
      (innerWidth<768 || b.x >= a.x - 1) &&
      (innerWidth<768 || b.y >= a.y - 1) &&
      (innerWidth<768 || b.right <= a.right + 1) &&
      (innerWidth<768 || b.bottom <= a.bottom + 1) &&
      (innerWidth<768 || Math.abs(b.x - a.x - (a.right - b.right)) < 1) &&
      (innerWidth<768 || Math.abs(b.y - a.y - (a.bottom - b.bottom)) < 1) &&
      true
    );
  });
  const sizes = await page.evaluate(() => {
    const view = document
      .querySelector(".canvas-scroll")!
      .getBoundingClientRect();
    const stage = document
      .querySelector(".pixel-stage")!
      .getBoundingClientRect();
    const region = document
      .querySelector(".office-stage")!
      .getBoundingClientRect();
    return {
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
      height: innerHeight,
      width: innerWidth,
      mainScroll: document.querySelector(".office-page")!.scrollHeight,
      mainHeight: document.querySelector(".office-page")!.clientHeight,
      heading: document.querySelector(".scene-heading")!.getBoundingClientRect()
        .height,
      viewBackground: getComputedStyle(
        document.querySelector(".canvas-scroll")!,
      ).backgroundColor,
      cardBackground: getComputedStyle(document.querySelector(".office-scene")!)
        .backgroundColor,
      viewTexture: getComputedStyle(document.querySelector(".canvas-scroll")!)
        .backgroundImage,
      sceneRadius: getComputedStyle(document.querySelector(".pixel-stage")!)
        .borderRadius,
      margins: {
        left: stage.x - view.x,
        right: view.right - stage.right,
        top: stage.y - view.y,
        bottom: view.bottom - stage.bottom,
      },
      outerMargins: {
        left: stage.x - region.x,
        right: region.right - stage.right,
        top: stage.y - region.y,
        bottom: region.bottom - stage.bottom,
      },
      tiles: [
        Number(
          document.querySelector<HTMLElement>(".canvas-scroll")!.dataset.cols,
        ),
        Number(
          document.querySelector<HTMLElement>(".canvas-scroll")!.dataset.rows,
        ),
      ],
      labels: [
        ...document.querySelectorAll<HTMLElement>(".department-plaque"),
      ].map((el) => ({
        text: el.textContent,
        font:
          parseFloat(getComputedStyle(el).fontSize) *
          Number(
            document.querySelector<HTMLElement>(".canvas-scroll")!.dataset
              .scale,
          ),
        fits:
          el.scrollWidth <= el.clientWidth &&
          el.scrollHeight <= el.clientHeight,
        size: [
          el.clientWidth,
          el.scrollWidth,
          el.clientHeight,
          el.scrollHeight,
        ],
        lineHeight: getComputedStyle(el).lineHeight,
      })),
      chatHeading: document
        .querySelector(".conversation-heading")
        ?.getBoundingClientRect().height,
    };
  });
  assert.ok(
    sizes.scrollHeight <= sizes.height && sizes.scrollWidth <= sizes.width,
    `The page must not overflow: ${JSON.stringify(sizes)}`,
  );
  assert.equal(
    sizes.mainScroll,
    sizes.mainHeight,
    "The Office page must not scroll vertically.",
  );
  assert.ok(sizes.heading <= 48, "The toolbar above the office must be at most 48px high.");
  // B1.7: fill the narrow area outside the scene with the office floor color.
  assert.notEqual(
    sizes.viewBackground,
    "rgba(0, 0, 0, 0)",
    "Space outside the scene must use the floor color.",
  );
  assert.equal(
    sizes.viewTexture,
    "none",
    "Floor texture must not extend outside the scene.",
  );
  assert.ok(
    parseFloat(sizes.sceneRadius) > 0,
    "The rounded frame must wrap the scene itself.",
  );
  if (!mobile) {
    assert.ok(
      Object.values(sizes.outerMargins).every(Number.isFinite),
      "The fixed map is centered in its pane; gaps use the theme background.",
    );
    assert.equal(sizes.chatHeading, 48);
    for (const label of sizes.labels) {
      assert.ok(
        label.font >= 11.99,
        `${label.text}: sign text must be at least 12 screen pixels high.`,
      );
      assert.ok(
        label.fits,
        `${label.text}: tabela kesilmemeli. ${JSON.stringify(label)}`,
      );
    }
  }
  return {
    margins: sizes.margins,
    outerMargins: sizes.outerMargins,
    tiles: sizes.tiles,
    minimumLabelFont: Math.min(...sizes.labels.map((l) => l.font)),
  };
}

export async function captureSizes(page: Page) {
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const [width, height, suffix] of [
      [1920, 1080, ""],
      [1366, 768, "-1366"],
      [1280, 640, "-1280x640"],
      [390, 844, "-telefon"],
    ] as const) {
      await page.setViewportSize({ width, height });
      if (width === 390)
        await page.getByRole("tab", { name: "Ofis", exact: true }).click();
      await checkFit(page, width === 390);
      await page.mouse.move(0, 0);
      await page.screenshot({
        path: resolve(
          `.test-data/screenshots/ofis${theme === "dark" ? "-koyu" : ""}${suffix}.png`,
        ),
        scale: "css",
        animations: "disabled",
      });
      if (width === 390 && theme === "light")
        await page.screenshot({
          path: resolve(".test-data/screenshots/telefon.png"),
          scale: "css",
        });
      if (width === 390) {
        await page.getByRole("tab", { name: "Sohbet", exact: true }).click();
        const input = await page
          .getByLabel("Mesajınız", { exact: true })
          .boundingBox();
        const tabs = await page.locator(".tabbar").boundingBox();
        assert.ok(input && tabs && input.y + input.height <= tabs.y);
        await page.screenshot({
          path: resolve(
            `.test-data/screenshots/telefon-sohbet${theme === "dark" ? "-koyu" : ""}.png`,
          ),
          scale: "css",
        });
        await page.getByRole("tab", { name: "Ofis", exact: true }).click();
      }
    }
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(() => {
    delete document.documentElement.dataset.theme;
  });
}

export async function sceneWorld(page: Page, data: Snapshot) {
  const layout = await page.locator(".canvas-scroll").getAttribute("data-layout");
  const labelHeight = Number(
    (await page.locator(".canvas-scroll").getAttribute("data-label-height")) ||
      2.7,
  );
  return makeWorld(data.departments, data.agents, layout === "balanced" ? "balanced" : "wide", labelHeight);
}
export async function checkActors(page: Page, data: Snapshot, frames = 220) {
  const world = await sceneWorld(page, data);
  await page.waitForFunction(
    (count) => document.querySelectorAll(".agent-hit[data-x]").length === count,
    data.agents.length,
  );
  // Wait for the new canvas layout frame after world dimensions change.
  // Idle agents may rest briefly when their first destination is occupied;
  // start sampling on actual walking rather than estimating a delay.
  await page.waitForTimeout(100);
  const reduced = await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (!reduced) await page.waitForFunction(
    () => Boolean(document.querySelector('.agent-hit[data-walking="true"]')), undefined, {timeout:100000});
  const sample = await page.evaluate(
    async ({ world, tile, frames, geometry }) => {
      const result: string[] = [];
      let movingFrames = 0;
      // Sample real movement, not a single stationary frame.
      for (let frame = 0; frame < frames; frame++) {
        if (frame) await new Promise((resolve) => setTimeout(resolve, 80));
        const positions = [
          ...document.querySelectorAll<HTMLElement>('.agent-hit:not([data-passive="true"])'),
        ].map((el) => ({
          id: el.dataset.agentId!,
          restFurniture: el.dataset.restFurnitureId,
          chairId:el.dataset.chairId,
          seated: el.dataset.seated === "true",
          walking: el.dataset.walking === "true",
          x: Math.round(Number(el.dataset.x) * tile) - geometry.x,
          y: Math.round(Number(el.dataset.y) * tile) - geometry.y,
          w: geometry.w,
          h: geometry.h,
        }));
        if (positions.some((p) => p.walking)) movingFrames++;
        const stage=document.querySelector(".pixel-stage")!.getBoundingClientRect();
        const scale=Number(document.querySelector<HTMLElement>(".office-viewport")!.dataset.scale);
        for(const label of document.querySelectorAll<HTMLElement>('.agent-hit:not([data-passive="true"]) .agent-label')) {
          const style=getComputedStyle(label);if(style.display === "none" || style.visibility !== "visible")continue;
          const id=label.closest<HTMLElement>(".agent-hit")!.dataset.agentId!,owner=positions.find(p=>p.id===id)!;
          const b=label.getBoundingClientRect(),box={x:(b.x-stage.x)/scale,y:(b.y-stage.y)/scale,w:b.width/scale,h:b.height/scale};
          const center={x:box.x+box.w/2,y:box.y+box.h/2};
          const distance=(p:typeof owner)=>Math.hypot(center.x-p.x-p.w/2,center.y-p.y-p.h/2);
          if(Math.abs(center.x-owner.x-owner.w/2)>6.1 || box.y<owner.y+owner.h-1 || box.y-owner.y-owner.h>box.h+1 || parseFloat(style.fontSize)*scale<11)
            result.push(`${id}: walking names must remain attached to their owner and readable`);
          for(const other of positions)if(other.id!==id && distance(other)+1/scale<distance(owner))result.push(`${id}: walking name is closer to another character`);
        }
        for (let i = 0; i < positions.length; i++) {
          const a = positions[i];
          for (const b of positions.slice(i + 1))
            if (
              a.x < b.x + b.w &&
              a.x + a.w > b.x &&
              a.y < b.y + b.h &&
              a.y + a.h > b.y
            )
              result.push(`${a.id} / ${b.id}: ${JSON.stringify({a,b,scale,frame})}`);
          for (const f of world.furniture) {
            // Seated agents approach their own chair and desk edge.
            if (
              a.seated &&
              (a.restFurniture === f.id || a.chairId===f.id || (f.kind === "chair" && f.agentId === a.id) ||
                world.desks.some(
                  (desk) => desk.agentId === a.id && desk.islandId === f.id,
                ))
            )
              continue;
            const b = {
              x: f.x * tile,
              y: f.y * tile,
              w: f.w * tile,
              h: f.h * tile,
            };
            if (
              a.x < b.x + b.w &&
              a.x + a.w > b.x &&
              a.y < b.y + b.h &&
              a.y + a.h > b.y
            )
              result.push(`${a.id} / ${f.id}: ${JSON.stringify({actor:a, furniture:b, frame, layout:document.querySelector<HTMLElement>('.office-viewport')?.dataset.layout})}`);
          }
          for (const r of world.rooms) {
            const b = {
              x: r.x * tile,
              y: r.y * tile,
              w: r.w * tile,
              h: r.h * tile,
            };
            if (
              a.x < b.x + b.w &&
              a.x + a.w > b.x &&
              a.y < b.y + b.h &&
              a.y + a.h > b.y
            )
              result.push(`${a.id} / tabela`);
          }
          for (const b of [...world.signs, ...world.wallPanels]) {
            if (
              a.x < b.x + b.w &&
              a.x + a.w > b.x &&
              a.y < b.y + b.h &&
              a.y + a.h > b.y
            )
              result.push(`${a.id} / room sign or wall surface`);
          }
          for (const w of world.walls) {
            const b = {
              x: w.x * tile,
              y: w.y * tile - 14,
              w: w.w * tile,
              h: w.h * tile + 18,
            };
            if (
              a.x < b.x + b.w &&
              a.x + a.w > b.x &&
              a.y < b.y + b.h &&
              a.y + a.h > b.y
            )
              result.push(`${a.id} / duvar`);
          }
        }
        if (result.length) break;
      }
      return { errors: [...new Set(result)], movingFrames };
    },
    {
      world: {
        desks: world.desks,
        furniture: world.furniture,
        walls: world.walls,
        rooms: world.rooms,
        signs: world.signs,
        wallPanels: world.wallPanels,
      },
      tile: TILE,
      frames,
      geometry: {x:CHARACTER_X,y:CHARACTER_Y,w:CHARACTER_WIDTH,h:CHARACTER_HEIGHT},
    },
  );
  assert.deepEqual(
    sample.errors,
    [],
    "Moving characters must not overlap furniture, walls or signs.",
  );
  assert.ok(
    reduced || sample.movingFrames > 0,
    "Collision checks must include actual walking frames.",
  );
}

export async function captureNativeScene(page: Page, data: Snapshot) {
  const world = await sceneWorld(page, data);
  const capture = await page.evaluate((geometry) => ({
    png: document
      .querySelector<HTMLCanvasElement>(".office-canvas")!
      .toDataURL("image/png"),
    actors: [
      ...document.querySelectorAll<HTMLElement>(".agent-hit[data-x]"),
    ].map((el) => ({
      x: Math.round(Number(el.dataset.x) * 16) - geometry.x,
      y: Math.round(Number(el.dataset.y) * 16) - geometry.y,
      w: geometry.w,
      h: geometry.h,
    })),
  }), {x:CHARACTER_X,y:CHARACTER_Y,w:CHARACTER_WIDTH,h:CHARACTER_HEIGHT});
  const desks = world.furniture.filter((f) => f.kind === "desk");
  const image = "ofis-sahne-dogal.png";
  writeFileSync(
    resolve(`.test-data/screenshots/${image}`),
    Buffer.from(capture.png.split(",")[1], "base64"),
  );
  writeFileSync(
    resolve(".test-data/screenshots/ofis-olcum-girdi.json"),
    JSON.stringify(
      {
        image,
        width: world.cols * TILE,
        height: world.rows * TILE,
        interior: {
          x: TILE,
          y: TILE,
          w: (world.cols - 2) * TILE,
          h: (world.rows - 2) * TILE,
        },
        floorColors: FLOOR_PALETTES.flat(),
        actors: capture.actors,
        geometry: {
          world_tiles: [world.cols, world.rows],
          island_width_tiles: desks[0].w,
          interior_width_tiles: world.cols - 2,
          island_ratio: desks[0].w / (world.cols - 2),
          horizontal_gap_ratio:
            (desks[1].x - desks[0].x - desks[0].w) / desks[0].w,
          row_step_ratio: (desks[4].y - desks[0].y) / (desks[0].h + 3),
          aspect_ratio: world.cols / world.rows,
          workspace_height_ratio: world.bottom / world.rows,
        },
      },
      null,
      2,
    ) + "\n",
  );
}
export async function checkScreens(page: Page, data: Snapshot) {
  const world = await sceneWorld(page, data);
  const occupied = world.furniture.find(
    (f) => f.kind === "desk" && f.seatAgentIds?.[1],
  );
  const empty = world.furniture.find(
    (f) => f.kind === "desk" && f.seatAgentIds?.some(id=>data.agents.find(a=>a.id===id)?.status === "kapali"),
  );
  assert.ok(occupied && empty);
  const result = await page.evaluate(
    async ({ occupied, empty, activeName, offName }) => {
      const atlas = await fetch("/assets/office-atlas.json").then((r) =>
        r.json(),
      );
      const canvas =
        document.querySelector<HTMLCanvasElement>(".office-canvas")!;
      const ctx = canvas.getContext("2d")!;
      const samples = [
        { f: occupied, name: activeName, index: 1 },
        { f: empty, name: offName, index: 0 },
      ];
      const signatures = [new Set<string>(), new Set<string>()];
      let lit = false,
        offLit = false;
      for (let frame = 0; frame < 40; frame++) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        samples.forEach(({ f, name, index }, n) => {
          // B1.6 screens are independent of the old thin atlas strip.
          const x=Math.round((f.x+5.5+index*11)*16-32+3);
          const y=Math.round(f.y*16-42+4);
          const w=58,h=37;
          const pixels = ctx.getImageData(x, y, w, h).data;
          signatures[n].add(Array.from(pixels).join(","));
          const bright = Array.from(
            { length: pixels.length / 4 },
            (_, i) => pixels[i * 4 + 1] > 140 && pixels[i * 4 + 2] > 120,
          ).some(Boolean);
          if (n === 0) lit ||= bright;
          else offLit ||= bright;
        });
      }
      const evidence = document.createElement("canvas");
      evidence.width = 704;
      evidence.height = 160;
      evidence
        .getContext("2d")!
        .drawImage(
          canvas,
          occupied.x * 16,
          occupied.y * 16 - 44,
          352,
          160,
          0,
          0,
          352,
          160,
        );
      evidence
        .getContext("2d")!
        .drawImage(
          canvas,
          empty.x * 16,
          empty.y * 16 - 44,
          352,
          160,
          352,
          0,
          352,
          160,
        );
      return {
        activeFrames: signatures[0].size,
        offFrames: signatures[1].size,
        lit,
        offLit,
        png: evidence.toDataURL(),
      };
    },
    {
      occupied,
      empty,
      activeName: furnitureAsset(occupied),
      offName: furnitureAsset(empty),
    },
  );
  assert.ok(
    result.lit && result.activeFrames >= 2,
    "The right-seat occupant must animate its own screen.",
  );
  assert.ok(
    !result.offLit && result.offFrames === 1,
    "An empty desk screen must stay dark and static.",
  );
  writeFileSync(
    resolve(".test-data/screenshots/ofis-ekran-durumlari.png"),
    Buffer.from(result.png.split(",")[1], "base64"),
  );
}
