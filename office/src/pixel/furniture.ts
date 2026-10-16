import { rect as r, shadow } from "./sprites";
import { assetFrame, drawAssetBox, drawAssetRegion } from "./atlas";
import { CHAIR_BACK_TOP, CHAIR_BACK_HEIGHT, DESK_PROFILES } from "./seating";
import { TILE, TOP_WALL_HEIGHT, type Furniture, type World, type Wall } from "./world";
export { TOP_WALL_HEIGHT } from "./world";
type C = CanvasRenderingContext2D;
export const DESK_ASSETS = DESK_PROFILES.map((profile) => profile.asset);
export const CHAIR_ASSETS = ["chair", "chair-rust"];
export const SHELF_ASSETS = ["shelf", "shelf-full", "shelf-plants"];
export const PLANT_ASSETS = ["palm", "plant-snake", "plant-fern", "plant-rubber", "plant-cactus", "plant-monstera"];
export function topWallWindows(cols: number) {
  return Array.from({length: 4}, (_, i) => ({
    x: cols*TILE*(i+.5)/4-160, y: 8, w: 320, h: 176,
  }));
}
// Muted department tint close to the warm floor palette.
export function rugPalette(color = "#839685") {
  const rgb = [1,3,5].map(i=>parseInt(color.slice(i,i+2),16));
  const base = [221,191,154];
  const mix = (amount: number) => '#'+base.map((v,i)=>Math.round(v*(1-amount)+rgb[i]*amount).toString(16).padStart(2,'0')).join('');
  return { fill: mix(.12), border: mix(.27), stitch: mix(.20) };
}
export function furnitureAsset(f: Furniture): string {
  const variants = { desk: DESK_ASSETS, chair: CHAIR_ASSETS, shelf: SHELF_ASSETS, plant: PLANT_ASSETS };
  if (f.kind in variants) {
    const list = variants[f.kind as keyof typeof variants];
    return list[(f.variant || 0) % list.length];
  }
  if (f.kind === "executive") return "desk-pair";
  if (f.kind === "painting") return "painting-landscape";
  if (f.kind === "board") return f.w > 4 ? "screen" : "whiteboard";
  return f.kind === "cabinet" ? "filing-cabinet" : f.kind;
}
export type MonitorState = boolean | "off" | "idle" | "working" | "waiting" | "warning";
export function drawMonitor(c: C, x: number, y: number, w: number, h: number, time: number, working: MonitorState) {
  r(c, "#172b35", x, y, w, h);
  const inset=w>40?3:1;
  r(c,"#455f68",x+inset,y+1,w-2*inset,2);
  if (!working || working === "off") { r(c,"#36434b",x+inset,y+4,w-2*inset,h-7);return; }
  r(c, working === "warning" ? "#874928" : working === "waiting" ? "#756030" : "#235d74", x+inset,y+4,w-2*inset,h-7);
  r(c,"#66bcc9",x+inset+1,y+5,w-2*inset-2,3);
  if (working === "waiting" || working === "warning") {
    const cx=x+Math.floor(w/2),unit=h>30?3:1;
    r(c,"#ffe7a0",cx-2*unit,y+11,4*unit,unit);r(c,"#ffe7a0",cx+unit,y+11+unit,unit,2*unit);
    r(c,"#ffe7a0",cx,y+11+3*unit,unit,unit);r(c,"#ffe7a0",cx,y+h-7,unit,unit);return;
  }
  if (working === "idle") {
    r(c,"#528c9f",x+inset+3,y+11,w-2*inset-6,Math.max(2,h-20));
    r(c,"#bcf0e5",x+inset+4,y+h-8,Math.min(16,w-2*inset-8),2);return;
  }
  for(let line=0;line<Math.max(1,Math.min(3,Math.floor((h-14)/7)));line++)r(c,"#bcf0e5",x+inset+4,y+12+line*7,Math.min(w-2*inset-8,14+line*7),2);
  r(c,"#76d8b3",x+inset+4,y+h-8,Math.floor(time/700)%2?Math.min(14,w-2*inset-8):Math.min(24,w-2*inset-8),2);
}
export function directorMonitorBox(f: Furniture) {
  return {x:f.x*TILE+f.w*TILE-154,y:f.y*TILE-48,w:112,h:80};
}
export function drawFurniture(
  c: C,
  f: Furniture,
  time: number,
  working: readonly MonitorState[] = [],
) {
  const x = f.x * TILE,
    y = f.y * TILE;
  const name = furnitureAsset(f);
  if(f.kind === "chair" && f.direction === "down") {
    // Push the empty chair behind the desk, leaving only its back above the top.
    c.save();c.beginPath();c.rect(x,y,f.w*TILE,24);c.clip();
    drawAssetBox(c,name,x,y,f.w*TILE,f.h*TILE);c.restore();return;
  }
  // A wide desktop and short legs keep aisles open in dense layouts.
  if(f.kind!=="executive" && f.kind!=="meeting") drawAssetBox(
    c, name, x, y, f.w * TILE, f.h * TILE,
    f.kind === "desk",
  );
  if (f.kind === "executive" || f.kind === "meeting") {
    const w=f.w*TILE,h=f.h*TILE;
    // Use one plain top in the atlas wood palette; no stretched laptop or mug.
    r(c,"#513323",x,y+10,w,h-22);r(c,"#b7773d",x+4,y+12,w-8,h-28);
    for(let line=18;line<h-20;line+=10)r(c,"#c78a4c",x+8,y+line,w-16,2);
    r(c,"#e5ac64",x+4,y+12,w-8,3);r(c,"#704321",x,y+h-20,w,6);
    for(const xx of [x+12,x+w-24]){r(c,"#513323",xx,y+h-14,10,14);r(c,"#966031",xx+2,y+h-14,4,11);}
    if(f.kind === "meeting") {
      // Border, short wood grain and a few work items.
      r(c,"#f1bc79",x+6,y+15,w-12,3);
      r(c,"#925b31",x+6,y+h-26,w-12,3);
      for(let grain=0;grain<Math.floor(w/60);grain++) {
        const gx=x+20+grain*58,gy=y+28+(grain%3)*18;
        r(c,"#ad703d",gx,gy,24+grain%4*4,1);
        r(c,"#d99d59",gx+9,gy+3,30,1);
      }
      for(const ratio of [.26,.74]) {
        const px=x+Math.round(w*ratio)-18,py=y+Math.round(h*.42);
        r(c,"#886038",px+3,py+3,36,26);r(c,"#f1e8d1",px,py,36,26);
        for(let line=0;line<3;line++)r(c,"#b2ada0",px+6,py+6+line*5,22-line*4,2);
        r(c,"#3a5264",px+41,py+4,3,23);
      }
      const laptopX=x+Math.round(w/2)-27,laptopY=y+Math.round(h*.3);
      r(c,"#233b47",laptopX,laptopY,54,32);r(c,"#72a9b6",laptopX+4,laptopY+4,46,23);
      r(c,"#455f68",laptopX-3,laptopY+32,60,20);r(c,"#a1b8bb",laptopX+2,laptopY+36,50,2);
      r(c,"#233b47",laptopX+20,laptopY+43,16,6);
      // Slightly stepped corners avoid a solid slab appearance.
      for(const xx of [x,x+w-4]) {r(c,"#c9aa83",xx,y+10,4,6);r(c,"#c9aa83",xx,y+h-24,4,4);}
    }
    if(f.kind === "executive") {
      const monitor=directorMonitorBox(f);
      drawMonitor(c,monitor.x,monitor.y,monitor.w,monitor.h,time,working[0] || "working");
      r(c,"#263b46",monitor.x+50,monitor.y+monitor.h,12,12);
      r(c,"#455f68",monitor.x+30,monitor.y+monitor.h+10,52,5);
      r(c,"#263b46",monitor.x+14,y+58,88,12);
      for(let row=0;row<2;row++)for(let key=0;key<10;key++)r(c,"#aac2c6",monitor.x+18+key*8,y+60+row*4,5,2);
      r(c,"#f2e7cf",x+28,y+35,42,30);r(c,"#c2ab89",x+32,y+43,32,2);r(c,"#c2ab89",x+32,y+51,24,2);
      r(c,"#35444f",x+78,y+40,4,28);
      r(c,"#eadfc9",x+104,y+33,15,18);r(c,"#745033",x+106,y+34,11,3);
    }
    return;
  }
  if (f.kind === "desk") {
    const w=f.w*TILE, front=Math.round(f.h*TILE*82/120);
    // Reuse atlas drawers and legs; draw the desktop at its native pixel ratio.
    drawAssetRegion(c,name,82,38,x,y+front,w,f.h*TILE-front);
    r(c,"#513323",x,y,w,front+5);
    r(c,"#c88c4d",x+4,y+3,w-8,front-4);
    for(let line=10;line<front-4;line+=9)r(c,"#dca260",x+8,y+line,w-16,1);
    r(c,"#f1bb75",x+4,y+3,w-8,3);
    r(c,"#704321",x,y+front,w,5);
    for(let i=0;i<2;i++) {
      const center=x+(5.5+i*11)*TILE;
      drawMonitor(c,center-32,y-42,64,44,time,working[i]||"off");
      r(c,"#24343b",center-4,y+2,8,10);r(c,"#41515a",center-17,y+10,34,4);
      r(c,"#273b40",center-36,y+48,64,10);r(c,"#a9c0c3",center-33,y+50,58,2);
      for(let key=0;key<8;key++)r(c,"#647f87",center-32+key*7,y+54,4,2);
      r(c,"#233944",center+36,y+48,8,12);r(c,"#9cbdc0",center+39,y+49,2,4);
      const mug=i ? x+w-26 : x+18;
      r(c,"#65482d",mug,y+27,12,2);r(c,"#efe0bf",mug,y+18,10,10);
      r(c,"#62412b",mug+2,y+19,6,2);r(c,"#dfbd8c",mug+10,y+20,3,6);
    }
  }
}
export function drawChairSeat(c: C, chair: Furniture, time: number) {
  // Draw the seat and legs behind; omit the tall empty back when occupied.
  c.save();
  c.beginPath();
  c.rect(chair.x * TILE, chair.y * TILE + CHAIR_BACK_TOP, chair.w * TILE, chair.h * TILE - CHAIR_BACK_TOP);
  c.clip();
  drawFurniture(c, chair, time);
  c.restore();
}
export function drawChairBack(c: C, chair: Furniture) {
  const name = furnitureAsset(chair), frame = assetFrame(name);
  if (!frame) return;
  const ratio = Math.min(chair.w * TILE / frame.w, chair.h * TILE / frame.h);
  // Keep the chair back at waist height, exposing head, shoulders and upper back.
  drawAssetRegion(c, name, 0, Math.round(frame.h * 0.62), chair.x * TILE,
    chair.y * TILE + CHAIR_BACK_TOP, frame.w * ratio, CHAIR_BACK_HEIGHT);
}
export function drawWall(c: C, wall: Wall) {
  const x = wall.x * TILE,
    y = wall.y * TILE,
    w = wall.w * TILE,
    h = wall.h * TILE;
  shadow(c, x + 2, y + h + 6, w, 6);
  r(c, "#493321", x, y - 12, w, h + 14);
  r(c, "#99673f", x + 2, y - 10, w - 4, h + 10);
  for (let yy = 0; yy < h + 8; yy += 8)
    for (let xx = 0; xx < w - 4; xx += 24) {
      r(c, "#805132", x + 2 + xx, y - 7 + yy, 20, 1);
      r(c, "#b9844a", x + 6 + xx, y - 5 + yy, 12, 1);
    }
  r(c, "#f4d19b", x, y - 14, w, 5);
  r(c, "#c29763", x + 2, y - 9, w - 4, 3);
  r(c, "#69482e", x, y + h - 2, w, 4);
}
// The measurement tool treats only these flat palette colors as floor.
// Include grout and stone specks so they do not inflate coverage.
export const FLOOR_PALETTES = [
  ["#ddbf9a", "#dec09b", "#d5b791", "#e0c29e"],
  ["#dbc09e", "#dcc19f", "#d3b896", "#dec4a4"],
  ["#dcc2a2", "#ddc3a3", "#d4ba9a", "#dfc6a8"],
];
export function background(c: C, world: World) {
  const width = world.cols * TILE,
    height = world.rows * TILE,
    b = world.bottom * TILE;
  r(c, "#60432e", 0, 0, width, height);
  // Calm stone floor: tile tones differ by only one value per channel.
  for (let y = TOP_WALL_HEIGHT; y < height - TILE; y += 32)
    for (let x = TILE; x < width - TILE; x += 32) {
      const room = y >= b ? (x < world.walls.find(w=>w.h>1)!.x * TILE ? 1 : x >= world.walls.filter(w=>w.h>1)[1].x * TILE ? 2 : 0) : 0;
      const palette = FLOOR_PALETTES[room];
      const n = ((x - TILE) / 32 + (y - TOP_WALL_HEIGHT) / 32) % 2;
      r(c, palette[n === 0 ? 0 : 1], x, y, 32, 32);
      r(c, palette[2], x, y, 32, 1);
      r(c, palette[2], x, y, 1, 32);
      r(c, palette[3], x + 9 + n, y + 17, 1, 1);
    }
  // The outer frame belongs to the scene and does not spill into partition gaps.
  r(c, "#60432e", width - TILE, 0, TILE, height);
  r(c, "#60432e", 0, height - TILE, width, TILE);
  r(c, "#e5c395", 2, TOP_WALL_HEIGHT, 5, height - TOP_WALL_HEIGHT);
  r(c, "#e5c395", width - 7, TOP_WALL_HEIGHT, 5, height - TOP_WALL_HEIGHT);
  r(c, "#e5c395", 2, height - 7, width - 4, 5);
  r(c, "#a67b53", 0, 0, width, TOP_WALL_HEIGHT);
  for (let y = 4; y < TOP_WALL_HEIGHT-6; y += 8)
    for (let x = 4; x < width; x += 15) {
      r(c, "#c0946155", x + (y % 5), y, 5, 2);
      r(c, "#75503533", x + 5, y + 3, 3, 1);
    }
  r(c, "#493321", 0, TOP_WALL_HEIGHT-6, width, 7);
  r(c, "#edc89a", 0, TOP_WALL_HEIGHT-6, width, 2);
  const paintings = ["painting-landscape", "painting-fern", "painting-hills", "painting-circles"];
  for (const window of topWallWindows(world.cols))
    drawAssetBox(c,"window",window.x,window.y,window.w,window.h,true);
  for(let i=0;i<2;i++)drawAssetBox(c,paintings[0],width*(i ? .75 : .25)-2*TILE,58,4*TILE,76);
  for (const panel of world.wallPanels) {
    r(c, "#ad845d", panel.x, panel.y, panel.w, panel.h);
    for (let y = panel.y + 5; y < panel.y + panel.h - 6; y += 12)
      for (let x = panel.x + 6; x < panel.x + panel.w - 8; x += 20)
        r(c, "#b8906944", x + (y % 3), y, 5, 2);
    r(c, "#edc89a", panel.x, panel.y + panel.h - 5, panel.w, 2);
    r(c, "#785236", panel.x, panel.y + panel.h - 3, panel.w, 3);
  }
  for (const rug of world.rugs) {
    const palette=rugPalette(rug.color);
    // Stepped 6px corners, thin border and sparse weave marks.
    c.save();c.beginPath();
    c.moveTo(rug.x+6,rug.y);c.lineTo(rug.x+rug.w-6,rug.y);
    c.lineTo(rug.x+rug.w,rug.y+6);c.lineTo(rug.x+rug.w,rug.y+rug.h-6);
    c.lineTo(rug.x+rug.w-6,rug.y+rug.h);c.lineTo(rug.x+6,rug.y+rug.h);
    c.lineTo(rug.x,rug.y+rug.h-6);c.lineTo(rug.x,rug.y+6);c.closePath();c.clip();
    r(c,palette.border,rug.x,rug.y,rug.w,rug.h);
    r(c,palette.fill,rug.x+2,rug.y+2,rug.w-4,rug.h-4);
    for (let x = rug.x+10; x < rug.x+rug.w-10; x += 14) {
      r(c,palette.stitch,x,rug.y+7,4,1);
      r(c,palette.stitch,x,rug.y+rug.h-8,4,1);
    }
    c.restore();
  }
}
export function clock(_c: C, _time: Date, _world: World) {}
