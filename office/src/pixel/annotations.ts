import { overlaps, type Bounds } from "./world";

// The head-to-bubble link must stay clear, including when a plaque is above us.
function cutsLink(start:{x:number;y:number},end:{x:number;y:number},box:Bounds) {
  let lo=0,hi=1;
  for(const axis of ['x','y'] as const) {
    const d=end[axis]-start[axis],min=box[axis],max=min+(axis==='x'?box.w:box.h);
    if(d===0) { if(start[axis]<min || start[axis]>max)return false; }
    else { const a=(min-start[axis])/d,b=(max-start[axis])/d;lo=Math.max(lo,Math.min(a,b));hi=Math.min(hi,Math.max(a,b)); }
  }
  return lo<=hi && hi>0 && lo<1;
}

// Bubbles may cover desk tops. Prefer the nearest clear position to the head.
export function placeBubble(anchor:Bounds,size:{w:number;h:number},area:Bounds,obstacles:Bounds[],fallback=false):Bounds|undefined {
  const gap=5, clampX=(x:number)=>Math.max(area.x+gap,Math.min(area.x+area.w-size.w-gap,x)),clampY=(y:number)=>Math.max(area.y+gap,Math.min(area.y+area.h-size.h-gap,y));
  const head={x:anchor.x+anchor.w/2,y:anchor.y+anchor.h*11/48},above=anchor.y-size.h-gap;
  const xs=new Set([clampX(head.x-size.w/2),clampX(anchor.x-size.w-gap),clampX(anchor.x+anchor.w+gap),area.x+gap,area.x+area.w-size.w-gap]);
  const ys=new Set([clampY(above),clampY(head.y-size.h/2),clampY(anchor.y),clampY(anchor.y+anchor.h+gap),area.y+gap,area.y+area.h-size.h-gap]);
  // The owner's body may contain the beginning of its own link.
  const linkObstacles=obstacles.filter(b=>!b.bubble && !(b.x===anchor.x && b.y===anchor.y && b.w===anchor.w && b.h===anchor.h));
  for(const b of obstacles){xs.add(clampX(b.x-size.w-gap));xs.add(clampX(b.x+b.w+gap));ys.add(clampY(b.y-size.h-gap));ys.add(clampY(b.y+b.h+gap));}
  let best:Bounds|undefined,cost=Infinity;
  for(const x of xs)for(const y of ys){
    const box={x,y,...size};
    if(box.x<area.x || box.y<area.y || box.x+box.w>area.x+area.w || box.y+box.h>area.y+area.h || obstacles.some(b=>overlaps(box,b)))continue;
    const nearest={x:Math.max(x,Math.min(head.x,x+size.w)),y:Math.max(y,Math.min(head.y,y+size.h))};
    if(linkObstacles.some(b=>cutsLink(head,nearest,b)))continue;
    if(!fallback && (y>head.y || Math.hypot(nearest.x-head.x,nearest.y-head.y)>anchor.w/2+gap))continue;
    const distance=Math.hypot(nearest.x-head.x,nearest.y-head.y)+(fallback || y+size.h<=anchor.y?0:2);
    if(distance<cost){best=box;cost=distance;}
  }
  return best;
}

// Relax distance/above-head limits only; keep both the box and its link clear.
// No safe candidate is possible when obstacles enclose the head completely.
export function placeBubbleFallback(anchor:Bounds,size:{w:number;h:number},area:Bounds,obstacles:Bounds[]):Bounds|undefined {
  const visible=placeBubble(anchor,size,area,obstacles,true);
  if(visible)return visible;
  return undefined;
}
