import { overlaps, type Bounds } from "./world";
export type NameAnchor = { id: string; anchor: Bounds; size: { w: number; h: number }; priority: number };
export function placeNames(items: NameAnchor[], gap: number, owners: Bounds[] = items.map(item => item.anchor)) {
  const placed: (Bounds & { id: string; dimmed: boolean; shift: number })[] = [];
  for (const item of [...items].sort((a, b) => b.priority - a.priority)) {
    const x = item.anchor.x + item.anchor.w / 2 - item.size.w / 2;
    const y = item.anchor.y + item.anchor.h + gap;
    const base = { x, y, ...item.size };
    // Allow at most one label height of displacement; keep the horizontal center fixed.
    const shifted = { ...base, y: y + item.size.h - gap };
    const clear = (box: Bounds) => !placed.some(other => overlaps(box, other));
    const distance = (box: Bounds, anchor: Bounds) => Math.hypot(box.x + box.w / 2 - anchor.x - anchor.w / 2, box.y + box.h / 2 - anchor.y - anchor.h / 2);
    const nearest = (box: Bounds) => owners.every(other => distance(box, item.anchor) <= distance(box, other));
    const box = clear(base) ? base : clear(shifted) && nearest(shifted) ? shifted : base;
    placed.push({ ...box, id: item.id, shift: box.y - y, dimmed: !clear(box) });
  }
  return placed;
}

export { canShareFloor } from "./characterGeometry";
