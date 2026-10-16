// Measure each desktop front edge in its own source pixels.
// Drawer and leg bottoms do not determine chair distance.
export const DESK_PROFILES = [
  { asset: "desk-pair", height: 120, front: 82 },
  { asset: "desk-papers", height: 124, front: 80 },
  { asset: "desk-headphones", height: 124, front: 80 },
  { asset: "desk-laptop", height: 90, front: 62 },
  { asset: "desk-lamp", height: 122, front: 78 },
] as const;
export const CHAIR_DESK_GAP = 2;
export const MAX_CHAIR_DESK_GAP = 3; // Desk image source pixels.
// Expand the body upward while keeping the foot/seat point fixed.
export const SEATED_RISE = 70;
export const SEATED_HEAD_HEIGHT = 52.25;
export const CHAIR_BACK_TOP = 24;
export const CHAIR_BACK_HEIGHT = 14;
export const MIN_SEATED_HEIGHT_RATIO = 1.6;
export function deskProfile(desk: { variant?: number }) {
  return DESK_PROFILES[(desk.variant || 0) % DESK_PROFILES.length];
}
export function deskFrontEdge(desk: { y: number; h: number; variant?: number }) {
  const profile = deskProfile(desk);
  return Math.round(desk.y * 16 + desk.h * 16 * profile.front / profile.height);
}
