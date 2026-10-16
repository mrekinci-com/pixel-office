// Loaded only by browser tests, never included in the production page.
import { hairStyles, hairLabels, type Appearance } from "../shared/types";
import { loadArt, characterSprite } from "../src/pixel/atlas";
import { person, normalizeAppearance, type Direction } from "../src/pixel/sprites";
import { drawChairSeat, drawChairBack, drawFurniture } from "../src/pixel/furniture";
import { actorBounds, chairPosition, TILE, type Furniture, type World } from "../src/pixel/world";
import { CHAIR_BACK_TOP, SEATED_RISE, SEATED_HEAD_HEIGHT, deskFrontEdge, deskProfile } from "../src/pixel/seating";

import { CHARACTER_SCALE, CHARACTER_WIDTH, CHARACTER_HEIGHT, CHARACTER_X } from "../src/pixel/characterGeometry";
const canvas = (width = CHARACTER_WIDTH, height = CHARACTER_HEIGHT + 4) => {
  const c = document.createElement("canvas"); c.width = width; c.height = height;
  return c;
};
function render(appearance: Appearance, variant: number, frame: number, breath: boolean, withPerson = true, headDirection?: Direction, gesture?: string) {
  const c = canvas(), ctx = c.getContext("2d")!;
  const chair: Furniture = { id: "probe", kind: "chair", x: (CHARACTER_X-8)/TILE, y: SEATED_RISE / TILE, w: 2, h: 3, variant };
  drawChairSeat(ctx, chair, 0);
  if (withPerson) person(ctx, appearance, 0, 0, frame, 1, "up", true, breath, CHARACTER_SCALE, headDirection, gesture);
  drawChairBack(ctx, chair);
  return c;
}
function measure(appearance: Appearance, variant: number, frame: number, breath: boolean, scene?: Uint8ClampedArray, headDirection?: Direction, gesture?: string) {
  const c = render(appearance, variant, frame, breath, true, headDirection, gesture);
  const expected = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  const bare = render(appearance, variant, frame, breath, false).getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  const actual = scene || expected;
  const rows = new Set<number>(), headRows = new Set<number>();
  let torsoPixels = 0, expectedPixels = 0, matchedPixels = 0;
  const mismatches: {x:number;y:number;expected:number[];actual:number[]}[]=[];
  for (let y = 0; y < CHAIR_BACK_TOP + SEATED_RISE; y++) for (let x = 0; x < CHARACTER_WIDTH; x++) {
    const i = (y * CHARACTER_WIDTH + x) * 4;
    if (expected[i + 3] !== 255 || expected.slice(i, i + 4).every((v, j) => v === bare[i + j])) continue;
    expectedPixels++;
    if ([0, 1, 2].some((j) => Math.abs(actual[i + j] - expected[i + j]) > 2)) {
      if(mismatches.length<12)mismatches.push({x,y,expected:[...expected.slice(i,i+3)],actual:[...actual.slice(i,i+3)]});
      continue;
    }
    matchedPixels++; rows.add(y);
    if (y < SEATED_HEAD_HEIGHT + Number(breath) * CHARACTER_SCALE) headRows.add(y);
    else torsoPixels++;
  }
  return { visibleHeight: rows.size ? Math.max(...rows) - Math.min(...rows) + 1 : 0,
    headHeight: headRows.size ? Math.max(...headRows) - Math.min(...headRows) + 1 : 0,
    torsoPixels, expectedPixels, matchedPixels, mismatches };
}
const appearanceFor = (style: Appearance["style"], accessories: number, palette = 0): Appearance => ({
  style, skin: palette ? "#6e4630" : "#edb583", hair: palette ? "#c4a77a" : "#453344",
  shirt: palette ? "#a33e72" : "#347b91", pants: palette ? "#765a31" : "#354655",
  glasses: Boolean(accessories & 1), tie: Boolean(accessories & 2), headphones: Boolean(accessories & 4),
});
export async function variants() {
  await loadArt();
  const results = [];
  for (const style of hairStyles) for (let accessories = 0; accessories < 8; accessories++)
    for (const palette of [0, 1]) for (const variant of [0, 1]) for (const frame of [0, 1, 2]) for (const breath of [false, true]) {
      const appearance = appearanceFor(style, accessories, palette);
      const metrics = measure(appearance, variant, frame, breath);
      const sitting = characterSprite(normalizeAppearance(appearance), "sit-back", frame)!;
      const up = characterSprite(normalizeAppearance(appearance), "up", 0)!;
      // Preserve the same rear-view hair, skin and hat pixels and colors.
      const head = (c: HTMLCanvasElement) => [...c.getContext("2d")!.getImageData(8, 0, 17, 20).data];
      const upHead = head(up);
      const headPreserved = head(sitting).every((v, i) => v === upHead[i]);
      const original = render(appearance, variant, frame, breath).getContext("2d")!.getImageData(0, 0, CHARACTER_WIDTH, CHARACTER_HEIGHT + 4).data;
      const recolored = render({ ...appearance, shirt: "#7830cc" }, variant, frame, breath).getContext("2d")!.getImageData(0, 0, CHARACTER_WIDTH, CHARACTER_HEIGHT + 4).data;
      let shirtPixels = 0;
      for (let y = Math.ceil(SEATED_HEAD_HEIGHT + Number(breath) * CHARACTER_SCALE); y < CHAIR_BACK_TOP + SEATED_RISE; y++) for (let x = 0; x < CHARACTER_WIDTH; x++) {
        const i = (y * CHARACTER_WIDTH + x) * 4;
        if ([0, 1, 2].some((j) => original[i + j] !== recolored[i + j])) shirtPixels++;
      }
      results.push({ style, accessories, palette, variant, frame, breath, headPreserved, shirtPixels, ...metrics });
    }
  for (const style of hairStyles) {
    const frames = [0, 1, 2].map((frame) => [...render(appearanceFor(style, 0), 0, frame, false).getContext("2d")!.getImageData(0, 0, CHARACTER_WIDTH, CHARACTER_HEIGHT + 4).data].join(","));
    if (new Set(frames).size !== 3) throw new Error(`${style}: typing frames must differ.`);
  }
  return results;
}
export async function directions() {
  await loadArt();const results=[];
  for(const style of hairStyles)for(let accessories=0;accessories<8;accessories++)for(const direction of ["up","down","left","right"]){
    const sprite=characterSprite(normalizeAppearance(appearanceFor(style,accessories)),`sit-${direction}`,0)!;
    const data=sprite.getContext("2d")!.getImageData(0,0,32,48).data;
    let upper=0,feet=0;for(let y=0;y<48;y++)for(let x=0;x<32;x++)if(data[(y*32+x)*4+3]){if(y<36)upper++;if(y>42)feet++;}
    results.push({style,accessories,direction,upper,feet});
  }return results;
}
export async function scene(world: World, actors: { id: string; appearance: Appearance; working?: boolean }[], time: number) {
  await loadArt();
  const sceneCanvas = document.querySelector<HTMLCanvasElement>(".office-canvas")!;
  const ctx = sceneCanvas.getContext("2d")!;
  // The atlas may load during a new RAF frame. Read pixels and time from
  // the same canvas frame without awaiting between reads.
  time = Number(sceneCanvas.dataset.renderedAt);
  return actors.map((actor) => {
    const chair = world.furniture.find((f) => f.kind === "chair" && f.agentId === actor.id)!;
    const bounds = actorBounds(chairPosition(chair));
    const actual = ctx.getImageData(bounds.x, bounds.y, CHARACTER_WIDTH, CHARACTER_HEIGHT + 4).data;
    return { id: actor.id, ...measure(actor.appearance, chair.variant || 0, Number(document.querySelector<HTMLElement>(`[data-agent-id="${actor.id}"]`)!.dataset.animationFrame),
      document.querySelector<HTMLElement>(`[data-agent-id="${actor.id}"]`)!.dataset.breath === "true", actual,
      (document.querySelector<HTMLElement>(`[data-agent-id="${actor.id}"]`)!.dataset.headDirection || undefined) as Direction | undefined,
      document.querySelector<HTMLElement>(`[data-agent-id="${actor.id}"]`)!.dataset.gesture) };
  });
}
export async function gaps(world: World) {
  await loadArt();
  return world.furniture.filter((f) => f.islandId?.startsWith("island-")).map((chair) => {
    const c = canvas(32, 48), ctx = c.getContext("2d")!;
    drawFurniture(ctx, { ...chair, x: 0, y: 0 }, 0);
    const data = ctx.getImageData(0, 0, 32, 48).data;
    let top = 48;
    for (let y = 0; y < 48; y++) for (let x = 0; x < 32; x++) if (data[(y * 32 + x) * 4 + 3]) top = Math.min(top, y);
    const desk = world.furniture.find((f) => f.id === chair.islandId)!;
    return { chair: chair.id, sourceGap: (chair.y * TILE + top - deskFrontEdge(desk)) * deskProfile(desk).height / (desk.h * TILE) };
  });
}
export async function gallery(theme: "light" | "dark", frame: number) {
  await loadArt();
  document.querySelector("#seated-gallery")?.remove();
  const c = canvas(1248, 1376), ctx = c.getContext("2d")!;
  c.id = "seated-gallery";
  Object.assign(c.style, { position: "fixed", left: "0", top: "0", width: "1248px", height: "1376px", zIndex: "99999" });
  ctx.scale(2, 2); ctx.fillStyle = theme === "light" ? "#fff8ec" : "#192231"; ctx.fillRect(0, 0, 624, 688);
  ctx.fillStyle = theme === "light" ? "#253447" : "#f2eadf"; ctx.font = "9px sans-serif";
  const labels = ["None", "Glasses", "Tie", "Glasses, tie", "Headphones", "Glasses, headphones", "Tie, headphones", "All three"];
  labels.forEach((label, i) => ctx.fillText(label, i * 78 + 3, 12, 72));
  for (let accessories = 0; accessories < 8; accessories++) for (const [index, style] of hairStyles.entries()) {
    const x = accessories * 78, y = 18 + index * 110;
    ctx.fillText(hairLabels[index], x + 3, y + 8);
    ctx.drawImage(render(appearanceFor(style, accessories), accessories % 2, frame, frame === 1), x + 7, y + 10);
  }
  document.body.append(c);
}
