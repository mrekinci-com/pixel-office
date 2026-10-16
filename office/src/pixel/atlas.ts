import { t as tx } from "../i18n";
import type { Appearance } from "../../shared/types";
type Frame = { x: number; y: number; w: number; h: number; screens?: { x: number; y: number; w: number; h: number }[] };
type Atlas = { image: string; masks?: string; frames: Record<string, Frame> };
let office: Atlas,
  characters: Atlas,
  officeImage: HTMLImageElement,
  characterImage: HTMLImageElement;
let characterPixels: ImageData, maskPixels: ImageData;
let pending: Promise<void> | undefined;
const variants = new Map<string, HTMLCanvasElement>();
const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(tx("Ofis görselleri yüklenemedi.")));
    image.src = src;
  });
const pixels = (image: HTMLImageElement) => {
  const c = document.createElement("canvas");
  c.width = image.width;
  c.height = image.height;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
};
export function loadArt(): Promise<void> {
  if (!pending)
    pending = (async () => {
      const read = async (url: string): Promise<Atlas> => {
        const r = await fetch(url);
        if (!r.ok) throw new Error(tx("Ofis görselleri yüklenemedi."));
        return r.json();
      };
      [office, characters] = await Promise.all([
        read("/assets/office-atlas.json"),
        read("/assets/character-atlas.json"),
      ]);
      const mask = await loadImage(characters.masks!);
      [officeImage, characterImage] = await Promise.all([
        loadImage(office.image),
        loadImage(characters.image),
      ]);
      characterPixels = pixels(characterImage);
      maskPixels = pixels(mask);
    })().catch((e) => {
      pending = undefined;
      throw e;
    });
  return pending;
}
export function drawAsset(
  ctx: CanvasRenderingContext2D,
  name: string,
  x: number,
  baseline: number,
  width?: number,
) {
  const frame = office?.frames[name];
  if (!frame || !officeImage) return;
  // Use integer scales to preserve native proportions and the pixel grid.
  const scale = width ? Math.max(1, Math.floor(width / frame.w)) : 1;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    officeImage,
    frame.x,
    frame.y,
    frame.w,
    frame.h,
    Math.round(x),
    Math.round(baseline - frame.h * scale),
    frame.w * scale,
    frame.h * scale,
  );
}
export function drawAssetBox(
  ctx: CanvasRenderingContext2D,
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fill = false,
) {
  const frame = office?.frames[name];
  if (!frame || !officeImage) return;
  const ratio = Math.min(width / frame.w, height / frame.h);
  const w = fill ? width : Math.floor(frame.w * ratio),
    h = fill ? height : Math.floor(frame.h * ratio);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    officeImage,
    frame.x,
    frame.y,
    frame.w,
    frame.h,
    Math.round(x + (width - w) / 2),
    Math.round(y),
    w,
    h,
  );
}
export function assetFrame(name: string): Frame | undefined {
  return office?.frames[name];
}
export function drawAssetRegion(ctx: CanvasRenderingContext2D, name: string,
  sourceY: number, sourceHeight: number, x: number, y: number, width: number, height: number) {
  const frame = office?.frames[name];
  if (!frame || !officeImage) return;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(officeImage, frame.x, frame.y + sourceY, frame.w, sourceHeight,
    Math.round(x), Math.round(y), Math.floor(width), Math.floor(height));
}
const rgb = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
export function characterSprite(
  a: Required<Appearance>,
  pose: string,
  frame: number,
  headDirection?: string,
  gesture?: string,
): HTMLCanvasElement | undefined {
  if (!characters || !characterPixels) return;
  const sitting = pose.startsWith("sit-");
  const facing = pose === "sit-back" ? "up" : sitting ? pose.slice(4) : pose;
  const name = `${a.style}:${facing}:${sitting ? 0 : frame % 3}`,
    f = characters.frames[name];
  if (!f) return;
  const key = `${pose}:${headDirection || ""}:${gesture || ""}:${frame % 3}:${name}:${a.skin}:${a.hair}:${a.shirt}:${a.pants}:${a.glasses}:${a.tie}:${a.headphones}`;
  const cached = variants.get(key);
  if (cached) return cached;
  const c = document.createElement("canvas");
  c.width = f.w;
  c.height = f.h;
  const ctx = c.getContext("2d")!,
    data = ctx.createImageData(f.w, f.h);
  const colors = [[], rgb(a.skin), rgb(a.hair), rgb(a.shirt), rgb(a.pants)];
  for (let y = 0; y < f.h; y++)
    for (let x = 0; x < f.w; x++) {
      const from = ((y + f.y) * characterPixels.width + x + f.x) * 4,
        to = (y * f.w + x) * 4;
      data.data.set(characterPixels.data.subarray(from, from + 4), to);
      const kind = maskPixels.data[from],
        light = maskPixels.data[from + 1];
      if (kind > 0 && kind <= 4 && maskPixels.data[from + 3]) {
        // Preserve shade differences, shadows and highlights when tinting.
        const factor = 0.55 + light / 200;
        for (let i = 0; i < 3; i++)
          data.data[to + i] = Math.min(
            255,
            Math.round(colors[kind][i] * factor),
          );
      }
    }
  ctx.putImageData(data, 0, 0);
  if (sitting && facing === "up") {
    // Reuse the same atlas pixels for the rear head, neck, hair and upper back.
    // Remove standing legs and bend both arms toward the keyboard.
    ctx.clearRect(0, 36, 32, 12);
    const tone = (hex: string, factor: number) => `rgb(${rgb(hex).map((v) => Math.round(v * factor)).join(",")})`;
    for (const [x, step] of [[4, frame % 3 === 1 ? 1 : 0], [24, frame % 3 === 2 ? 1 : 0]]) {
      ctx.fillStyle = "#20232b";
      ctx.fillRect(x, 20 + step, 4, 14 - step);
      ctx.fillRect(x + (x < 16 ? 2 : -2), 29, 4, 5);
      ctx.fillStyle = tone(a.shirt, 0.7);
      ctx.fillRect(x + 1, 23 + step, 2, 9 - step);
      ctx.fillRect(x + (x < 16 ? 3 : -1), 30, 2, 3);
      ctx.fillStyle = a.skin;
      ctx.fillRect(x + 1, 20 + step, 2, 3);
    }
    ctx.fillStyle = tone(a.pants, 0.7);
    ctx.fillRect(9, 35, 6, 6);
    ctx.fillRect(18, 35, 6, 6);
  }
  if (sitting && facing !== "up") {
    ctx.clearRect(0, 36, 32, 12);
    ctx.fillStyle = a.pants;
    if (facing === "down") { ctx.fillRect(9, 35, 6, 7); ctx.fillRect(18, 35, 6, 7); }
    else { ctx.fillRect(facing === "left" ? 5 : 17, 34, 10, 5); ctx.fillRect(facing === "left" ? 5 : 23, 38, 4, 4); }
    ctx.fillStyle = a.shirt;
    const arm = facing === "left" ? 4 : facing === "right" ? 23 : 6;
    ctx.fillRect(arm, 25, 3, 8);
    ctx.fillStyle = a.skin;
    ctx.fillRect(arm + (facing === "left" ? -2 : 1), 29 + frame % 2, 4, 3);
    if (facing === "down") ctx.fillRect(23, 29 + Number(frame === 2), 3, 3);
  }
  if (facing !== "up") {
    if (a.glasses) {
      ctx.fillStyle = "#202b39";
      ctx.fillRect(7, 16, 8, 2);
      ctx.fillRect(18, 16, 8, 2);
      ctx.fillRect(15, 17, 3, 1);
      ctx.fillStyle = "#a4d4d7";
      ctx.fillRect(8, 17, 5, 2);
      ctx.fillRect(19, 17, 5, 2);
    }
    if (a.tie) {
      ctx.fillStyle = "#d58b4b";
      ctx.fillRect(15, 27, 3, 7);
      ctx.fillStyle = "#ffe1a2";
      ctx.fillRect(15, 26, 3, 2);
    }
  }
  if (sitting && facing === "up" && a.glasses) {
    // From behind, show only the two glasses arms above the ears.
    ctx.fillStyle = "#202b39";
    ctx.fillRect(6, 16, 2, 2);
    ctx.fillRect(25, 16, 2, 2);
  }
  if (a.headphones) {
    ctx.fillStyle = "#253447";
    ctx.fillRect(6, 7, 21, 2);
    ctx.fillRect(5, 10, 3, 10);
    ctx.fillRect(25, 10, 3, 10);
    ctx.fillStyle = "#f0b657";
    ctx.fillRect(5, 14, 3, 5);
    ctx.fillRect(25, 14, 3, 5);
  }
  if (sitting && headDirection && headDirection !== facing) {
    const head=characterSprite(a,headDirection,0);
    if(head){ctx.clearRect(0,0,32,22);ctx.drawImage(head,0,0,32,22,0,0,32,22);}
  }
  if(sitting && gesture === "done") {
    ctx.fillStyle=a.shirt;ctx.fillRect(24,20,3,11);
    ctx.fillStyle=a.skin;ctx.fillRect(24,17,3,4);
  }
  if (variants.size > 1200) variants.clear();
  variants.set(key, c);
  return c;
}
