import assert from "node:assert/strict";
import type { Page, Locator } from "playwright";
import type { Snapshot } from "../shared/types.js";
import { sceneWorld } from "./layout.browser.js";
import { chairPosition, TILE, actorBounds, overlaps, furnitureBounds, ownSeatFurniture } from "../src/pixel/world.js";
import { installSeatProbe, assertSeatPixels } from "./seated.browser.js";
import { MAX_CHAIR_DESK_GAP } from "../src/pixel/seating.js";

export async function auditPage(page: Page) {
  const result = await page.evaluate(() => {
    const problems: string[] = [];
    let textCount = 0, minContrast = Infinity;
    const rgb = (value: string) => {
      const nums = value.match(/[\d.]+/g)?.map(Number) || [];
      return [nums[0] || 0, nums[1] || 0, nums[2] || 0, nums[3] ?? 1];
    };
    const blend = (fg: number[], bg: number[]) => fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3])).concat(1);
    const background = (el: Element | null): number[] => {
      if (!el) return [255, 255, 255, 1];
      const color = rgb(getComputedStyle(el).backgroundColor);
      return color[3] === 1 ? color : blend(color, background(el.parentElement));
    };
    const lum = (color: number[]) => color.slice(0, 3).map((c) => c / 255)
      .map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const visible = (el: HTMLElement) => {
      const box = el.getBoundingClientRect(), style = getComputedStyle(el);
      if (!box.width || !box.height || style.visibility !== "visible" || Number(style.opacity) === 0 || box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth) return false;
      for (let p: HTMLElement | null = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p), r = p.getBoundingClientRect();
        if (s.display === "none" || s.visibility !== "visible" || Number(s.opacity) === 0) return false;
        if (/(hidden|clip|auto|scroll)/.test(s.overflowY) && (box.top >= r.bottom || box.bottom <= r.top)) return false;
        if (/(hidden|clip|auto|scroll)/.test(s.overflowX) && (box.left >= r.right || box.right <= r.left)) return false;
      }
      return true;
    };
    const nodes = [...document.querySelectorAll<HTMLElement>("body *")].filter((el) =>
      !el.closest('[aria-hidden="true"], .sr-only, script, style, canvas') && visible(el) &&
      ([...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) || el.matches("input,textarea,select")));
    for (const el of nodes) {
      const style = getComputedStyle(el), bg = background(el);
      const fg = blend(rgb(style.color), bg), a = lum(fg), b = lum(bg);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
      textCount++; minContrast = Math.min(minContrast, ratio);
      const description = `${el.tagName}.${el.className}: ${(el.textContent || (el as HTMLInputElement).placeholder || "").trim().slice(0, 55)}`;
      if (ratio < (large ? 3 : 4.5) - 0.01) problems.push(`Contrast ${ratio.toFixed(2)}: ${description}; ${style.color}/${bg.slice(0, 3)}`);
      if (!el.matches("input,textarea,select") && el.clientWidth && el.scrollWidth > el.clientWidth + 2 && style.textOverflow !== "ellipsis")
        problems.push(`Text overflows horizontally (${el.scrollWidth}/${el.clientWidth}): ${description}`);
      if (!el.matches("input,textarea,select") && el.clientHeight && el.scrollHeight > el.clientHeight + 2 && !/(auto|scroll)/.test(style.overflowY))
        problems.push(`Text overflows vertically (${el.scrollHeight}/${el.clientHeight}): ${description}`);
      if (style.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 2 && style.overflowX !== "hidden")
        problems.push(`Ellipsis is not visible: ${description}`);
      if (style.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 2 && /flex|grid/.test(style.display))
        problems.push(`Truncated text needs its own line box: ${description}`);
    }
    for (const el of document.querySelectorAll<HTMLElement>(".task-dot")) {
      if (!visible(el)) continue;
      const a = lum(rgb(getComputedStyle(el).backgroundColor)), b = lum(background(el.parentElement));
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (ratio < 3) problems.push(`Task status dot has low contrast: ${ratio.toFixed(2)}:1.`);
    }
    if (document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth) problems.push("The page overflows horizontally.");
    const office = document.querySelector(".office-page");
    if (office && (office.scrollHeight > office.clientHeight + 1 || document.documentElement.scrollHeight > innerHeight)) problems.push("The Office page scrolls vertically.");
    return { problems, textCount, minContrast };
  });
  assert.deepEqual(result.problems, [], result.problems.join("\n"));
  return result;
}

export async function auditFocus(locator: Locator) {
  await locator.evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
  const result = await locator.evaluate((el) => {
    const host = el.closest<HTMLElement>("[data-focus-container]") || el as HTMLElement;
    const style = getComputedStyle(host), b = host.getBoundingClientRect();
    const offset = parseFloat(style.outlineOffset), width = parseFloat(style.outlineWidth);
    const rect = { x: b.x, y: b.y, width: b.width, height: b.height };
    const ring = { x: b.x - offset - width, y: b.y - offset - width, width: b.width + 2 * (offset + width), height: b.height + 2 * (offset + width) };
    const inputStyle = getComputedStyle(el);
    const send = host.querySelector(".send-button")?.getBoundingClientRect();
    return { rect, ring, outline: style.outlineStyle, width, element: `${el.tagName}.${el.className}[${el.getAttribute("type") || ""}] / ${el.closest("label")?.textContent?.trim().slice(0, 50)} / focused=${document.activeElement === el} / details=${el.closest("details")?.open}`, innerOutline: inputStyle.outlineStyle,
      innerBorder: inputStyle.borderWidth, shared: host !== el && el.tagName === "TEXTAREA",
      sendInside: !send || (send.x >= b.x && send.y >= b.y && send.right <= b.right && send.bottom <= b.bottom) };
  });
  assert.equal(result.outline, "solid", result.element);
  assert.equal(result.width, 2);
  for (const key of ["x", "y", "width", "height"] as const) assert.ok(Math.abs(result.ring[key] - result.rect[key]) <= 2, `Focus ring: ${JSON.stringify(result)}`);
  assert.ok(result.sendInside, "The Send button must remain inside the focus container.");
  if (result.shared) { assert.equal(result.innerOutline, "none"); assert.equal(result.innerBorder, "0px"); }
  return result;
}

export async function auditInteractiveFocus(page: Page) {
  const previous = await page.evaluateHandle(() => document.activeElement);
  const scrolls = await page.evaluateHandle(() => [...document.querySelectorAll<HTMLElement>("body *")]
    .filter((el) => el.scrollTop || el.scrollLeft || el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)
    .map((el) => ({ el, top: el.scrollTop, left: el.scrollLeft })));
  // Also measure button :focus-visible rings in keyboard navigation mode.
  await page.keyboard.press("Tab");
  const indices = await page.locator('button,a[href],summary,input,select,textarea,[tabindex="0"]').evaluateAll((els) => {
    const seen = new Set<string>();
    return els.flatMap((el, i) => {
      const e = el as HTMLElement, box = e.getBoundingClientRect();
      if (!e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || !box.width || !box.height || box.bottom <= 0 || box.top >= innerHeight || e.matches(":disabled") || getComputedStyle(e).visibility !== "visible") return [];
      if (e.closest("details:not([open])") && !e.matches("summary")) return [];
      for (let p = e.parentElement; p; p = p.parentElement) if (getComputedStyle(p).visibility !== "visible" || getComputedStyle(p).display === "none" || Number(getComputedStyle(p).opacity) === 0) return [];
      const signature = `${e.tagName}:${e.className}:${e.getAttribute("type")}:${e.getAttribute("role")}`;
      if (seen.has(signature)) return [];
      seen.add(signature); return [i];
    });
  });
  const elements = page.locator('button,a[href],summary,input,select,textarea,[tabindex="0"]');
  for (const i of indices) await auditFocus(elements.nth(i));
  await previous.evaluate((el) => {
    (document.activeElement as HTMLElement | null)?.blur();
    if (el instanceof HTMLElement) el.focus({ preventScroll: true });
  });
  await previous.dispose();
  await scrolls.evaluate((items) => items.forEach(({ el, top, left }) => { el.scrollTop = top; el.scrollLeft = left; }));
  await scrolls.dispose();
  return indices.length;
}

export async function auditSeats(page: Page, data: Snapshot) {
  const world = await sceneWorld(page, data);
  await page.waitForFunction((n) => document.querySelectorAll(".agent-hit[data-x]").length === n, data.agents.length);
  const actors = await page.locator('.agent-hit:not([data-passive="true"])').evaluateAll((els) => els.map((el) => ({
    id: (el as HTMLElement).dataset.agentId!, point: { x: Number((el as HTMLElement).dataset.x), y: Number((el as HTMLElement).dataset.y) },
    rest: (el as HTMLElement).dataset.restId, restFurniture: (el as HTMLElement).dataset.restFurnitureId, seated: (el as HTMLElement).dataset.seated === "true", chair: (el as HTMLElement).dataset.chairId, direction: (el as HTMLElement).dataset.direction,
  })));
  const emptyIds: string[] = JSON.parse(await page.locator(".office-canvas").getAttribute("data-empty-chair-ids") || "[]");
  for (const actor of actors) {
    if (actor.seated && actor.rest) {
      const rest=world.rests.find(r=>r.id===actor.rest)!;
      assert.ok(rest.seat && Math.hypot(actor.point.x-rest.seat.x,actor.point.y-rest.seat.y)*TILE<=2);
      assert.equal(actor.restFurniture,rest.furnitureId);
    } else if (actor.seated) {
      const chair = world.furniture.find((f) => f.kind === "chair" && f.agentId === actor.id)!;
      assert.equal(actor.chair, chair.id);
      assert.equal(actor.direction, "up");
      assert.ok(Math.hypot(actor.point.x - chairPosition(chair).x, actor.point.y - chairPosition(chair).y) * TILE <= 2);
      assert.equal(emptyIds.includes(chair.id), false, "An occupied chair must not also render as empty.");
    }
    for (const f of world.furniture) {
      if (actor.seated && (ownSeatFurniture(world, actor.id, f) || actor.restFurniture === f.id || (actor.rest && world.seats.find(s=>s.id===actor.rest)?.chairId===f.id))) continue;
      assert.equal(overlaps(actorBounds(actor.point), furnitureBounds(f)), false, `${actor.id}/${f.id}`);
    }
  }
  await installSeatProbe(page);
  const seated = actors.filter((a) => a.seated && !a.rest)
    .map((a) => { const agent = data.agents.find((agent) => agent.id === a.id)!;
      return { id: a.id, appearance: agent.appearance, working: agent.status === "calisiyor" }; });
  const pixels = await page.evaluate(({ world, seated }) => window.officeSeatProbe.scene(world, seated,
    Number(document.querySelector<HTMLCanvasElement>(".office-canvas")!.dataset.renderedAt)), { world, seated });
  pixels.forEach(assertSeatPixels);
  const gaps = await page.evaluate((world) => window.officeSeatProbe.gaps(world), world);
  for (const gap of gaps) assert.ok(gap.sourceGap >= 0 && gap.sourceGap <= MAX_CHAIR_DESK_GAP, `${gap.chair}: ${gap.sourceGap} kaynak pikseli`);
  return { actors: actors.length, seated: actors.filter((a) => a.seated).length, pixels, gaps };
}

export async function auditAnnotations(page: Page, data: Snapshot) {
  if (!await page.locator(".office-viewport").isVisible()) return;
  const result = await page.evaluate(() => {
    const scale = Number(document.querySelector<HTMLElement>(".office-viewport")!.dataset.scale);
    const actors = [...document.querySelectorAll<HTMLElement>(".agent-hit")].map(el => ({ id: el.dataset.agentId!, box: el.getBoundingClientRect() }));
    const annotations = [...document.querySelectorAll<HTMLElement>(".agent-label,.agent-bubble")]
      .filter(el => getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility === "visible" && el.textContent)
      .map(el => ({ id:el.closest<HTMLElement>(".agent-hit")!.dataset.agentId!, box:el.getBoundingClientRect(),
        label:el.classList.contains("agent-label"), font:parseFloat(getComputedStyle(el).fontSize)*scale, tail:el.dataset.tail,
        shifted:el.dataset.shifted === "true", opacity:Number(getComputedStyle(el).opacity), z:Number(getComputedStyle(el).zIndex) }));
    const intersects = (a:DOMRect,b:DOMRect) => a.left < b.right-1 && a.right > b.left+1 && a.top < b.bottom-1 && a.bottom > b.top+1;
    const center = (b:DOMRect) => ({x:b.x+b.width/2,y:b.y+b.height/2});
    const distance = (a:DOMRect,b:DOMRect) => Math.hypot(center(a).x-center(b).x,center(a).y-center(b).y);
    const problems:string[]=[];
    for (const a of annotations) {
      const owner=actors.find(o=>o.id===a.id)!;
      if(a.font<11)problems.push(a.id+": text must be at least 11 screen pixels high");
      if(a.label) {
        if(a.z < 6 || a.z > 7) problems.push(a.id+": name must be on the layer above furniture");
        for(const element of document.querySelectorAll<HTMLElement>(".agent-bubble,.department-hit,.scene-sign"))
          if(Number(getComputedStyle(element).zIndex)<=a.z)problems.push(a.id+": bubbles and signs must be above names");
        if(Math.abs(center(a.box).x-center(owner.box).x)/scale>6.1 || a.box.top<owner.box.bottom-1 || a.box.top-owner.box.bottom>a.box.height+1)
          problems.push(a.id+": name label must be attached to and centered on its owner");
        for(const other of actors.filter(o=>o.id!==a.id)) if(distance(a.box,other.box)+1<distance(a.box,owner.box))
          problems.push(a.id+": name label is closer to another character: "+JSON.stringify({owner:owner.box,other:other.box,label:a.box,shifted:a.shifted}));
        for(const b of annotations.filter(b=>b.label && b.id!==a.id)) if(intersects(a.box,b.box) && a.opacity===1 && b.opacity===1)
          problems.push(a.id+": the second overlapping label must be muted");
      } else {
        if(!a.tail)problems.push(a.id+": bubble must have a tail");
        for(const b of [...document.querySelectorAll<HTMLElement>(".department-hit,.scene-sign")].map(el=>el.getBoundingClientRect()))
          if(intersects(a.box,b))problems.push(a.id+": bubble intersects a sign");
        for(const other of actors.filter(o=>o.id!==a.id))if(intersects(a.box,other.box))problems.push(a.id+": bubble intersects another character");
        for(const b of annotations.filter(b=>!b.label && b.id!==a.id))if(intersects(a.box,b.box))problems.push(a.id+": bubbles overlap");
      }
    }
    return { problems, visible:annotations.length, labels:annotations.filter(a=>a.label).length };
  });
  assert.deepEqual(result.problems,[],result.problems.join("\n"));return result;
}
