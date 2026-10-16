import type { Appearance } from "../../shared/types";
import { characterSprite } from "./atlas";
const scaledSprites = new WeakMap<HTMLCanvasElement, Map<number, HTMLCanvasElement>>();
function scaledSprite(sprite: HTMLCanvasElement, scale: number) {
  if (scale === 1) return sprite;
  let sizes = scaledSprites.get(sprite);
  if (!sizes) { sizes = new Map(); scaledSprites.set(sprite, sizes); }
  const cached = sizes.get(scale);
  if (cached) return cached;
  const result = document.createElement("canvas");
  result.width = Math.round(sprite.width * scale);
  result.height = Math.round(sprite.height * scale);
  const ctx = result.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sprite, 0, 0, result.width, result.height);
  sizes.set(scale, result);
  return result;
}
export type Direction = "down" | "up" | "left" | "right";
export function normalizeAppearance(a: Appearance): Required<Appearance> {
  return {
    ...a,
    pants: a.pants || "#354655",
    glasses: a.glasses ?? false,
    tie: a.tie ?? false,
    headphones: a.headphones ?? false,
  };
}
export function rect(
  ctx: CanvasRenderingContext2D,
  color: string,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}
export function shadow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h = 5,
) {
  rect(ctx, "#321a1420", x + 2, y, w - 4, h);
  rect(ctx, "#321a1412", x, y + 1, w, h - 2);
}
export function person(
  ctx: CanvasRenderingContext2D,
  input: Appearance,
  x: number,
  y: number,
  frame = 0,
  alpha = 1,
  direction: Direction = "down",
  seated = false,
  breath = false,
  scale = 1,
  headDirection?: Direction,
  gesture?: string,
) {
  const pose = seated
    ? direction === "up" ? "sit-back" : `sit-${direction}`
    : direction === "down" && frame
      ? "walk"
      : direction;
  const sprite = characterSprite(normalizeAppearance(input), pose, frame, headDirection, gesture);
  if (!sprite) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = false;
  if (!seated) shadow(ctx, x, y + 46 * scale, 32 * scale, 3 * scale);
  // Sample fractional scaling once at (0,0), preventing distant GPU half-pixel
  // rounding from producing different hair or hat edges.
  ctx.drawImage(
    scaledSprite(sprite, scale),
    Math.round(x),
    Math.round(y + (breath ? (seated ? scale : 1) : 0)),
  );
  ctx.restore();
}
