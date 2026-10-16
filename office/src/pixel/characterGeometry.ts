// B1.9: 18.75% growth; 76×114 scene pixels without smoothing.
export const CHARACTER_SCALE = 2.375;
export const CHARACTER_WIDTH = 32 * CHARACTER_SCALE;
export const CHARACTER_HEIGHT = 48 * CHARACTER_SCALE;
export const CHARACTER_X = CHARACTER_WIDTH / 2 - 8;
export const CHARACTER_Y = CHARACTER_HEIGHT - 16;

type CharacterBox = { x:number; y:number; w:number; h:number };
// Keep foot labels associated with their owners as two people pass.
export function canShareFloor(a: CharacterBox, b: CharacterBox, labelHeight: number, gap: number) {
  if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) return false;
  const center = (box: CharacterBox) => ({x: box.x + box.w / 2, y: box.y + box.h / 2});
  const ca = center(a), cb = center(b);
  const owns = (owner: CharacterBox, own: {x:number;y:number}, other: {x:number;y:number}) => {
    const label = {x:own.x, y:owner.y + owner.h + gap + labelHeight / 2};
    return Math.hypot(label.x-own.x,label.y-own.y) <= Math.hypot(label.x-other.x,label.y-other.y);
  };
  return owns(a,ca,cb) && owns(b,cb,ca);
}
