import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAppearance } from "../src/pixel/sprites.js";
import { hairStyles, type Snapshot } from "../shared/types.js";
import { readFileSync } from "node:fs";
import { agentSchema } from "../server/app.js";
import { input } from "./helpers.js";
import { demoSnapshot } from "../src/demo.js";
import { cellKey, depthSort, makeWorld, pathfind, actorVisual, actorBounds, furnitureBounds, chairPosition, emptyChairs, overlaps, ownSeatFurniture, TILE } from "../src/pixel/world.js";
import { CHAIR_BACK_TOP, SEATED_RISE, SEATED_HEAD_HEIGHT, MIN_SEATED_HEIGHT_RATIO, MAX_CHAIR_DESK_GAP, deskProfile, deskFrontEdge } from "../src/pixel/seating.js";
import { furnitureAsset, DESK_ASSETS, CHAIR_ASSETS, SHELF_ASSETS, PLANT_ASSETS, drawMonitor } from "../src/pixel/furniture.js";
import { placeNames, canShareFloor } from "../src/pixel/nameLabels.js";
import { CHARACTER_WIDTH, CHARACTER_HEIGHT, CHARACTER_SCALE, CHARACTER_X } from "../src/pixel/characterGeometry.js";
import { placeBubble } from "../src/pixel/annotations.js";
const empty: Snapshot = {
  departments: [],
  agents: [],
  messages: [],
  events: [],
  handoffs: [],
  rules: "",
};
test("Working agents occupy their assigned chair; no duplicate empty chair, vacancy after departure", () => {
  const data = demoSnapshot(empty, 0);
  for (const aspect of [undefined, 0.55, 1, 1.6, 2.1]) {
    const world = makeWorld(data.departments, data.agents, aspect);
    const assigned = new Set<string>();
    for (const desk of world.desks) {
      const agent = { ...data.agents.find((a) => a.id === desk.agentId)!, status: "calisiyor" as const };
      const entry = { x: desk.x + 1, y: desk.y + 1 };
      const seated = actorVisual(agent, entry, false, world);
      assert.equal(seated.seated, true);
      assert.ok(seated.chair);
      assert.equal(assigned.has(seated.chair.id), false, "Two agents cannot share one assigned seat.");
      assigned.add(seated.chair.id);
      assert.deepEqual(seated.point, desk.seat);
      assert.deepEqual(seated.point, chairPosition(seated.chair));
      assert.deepEqual(actorBounds(seated.point), { x: seated.chair.x * TILE + 8 - CHARACTER_X, y: seated.chair.y * TILE - SEATED_RISE, w: CHARACTER_WIDTH, h: CHARACTER_HEIGHT });
      assert.equal(emptyChairs(world, new Set([seated.chair.id])).some((c) => c.id === seated.chair!.id), false);
      assert.ok(emptyChairs(world, new Set()).some((c) => c.id === seated.chair!.id));
      assert.equal(actorVisual(agent, entry, true, world).seated, false);
      assert.equal(actorVisual({ ...agent, status: "bosta" }, entry, false, world).seated, true);
      assert.equal(actorVisual({ ...agent, status: "kapali" }, entry, false, world).seated, false);
      for (const f of world.furniture.filter((f) => !ownSeatFurniture(world, agent.id, f)))
        assert.equal(overlaps(actorBounds(seated.point), furnitureBounds(f)), false, f.id);
    }
  }
});
test("Seated heads/upper backs remain visible; all chair types sit at the desktop edge", () => {
  // Keep the upper body visible even at the lowest breathing frame.
  assert.ok((CHAIR_BACK_TOP + SEATED_RISE - CHARACTER_SCALE) / SEATED_HEAD_HEIGHT >= MIN_SEATED_HEIGHT_RATIO);
  const data = demoSnapshot(empty, 0);
  for (const count of [6, 14]) for (const departments of [1, 6]) {
    const agents = Array.from({ length: count }, (_, i) => ({ ...data.agents[i % 6], id: `seating-${i}`,
      department_id: data.departments[i % departments].id, desk_x: 0, desk_y: 0 }));
    for (const aspect of [undefined, 0.55, 0.75, 1, 1.6, 2.1]) {
      const world = makeWorld(data.departments.slice(0, departments), agents, aspect);
      for (const chair of world.furniture.filter((f) => f.islandId?.startsWith("island-"))) {
        const desk = world.furniture.find((f) => f.id === chair.islandId)!;
        const profile = deskProfile(desk);
        const sourceGap = (chair.y * TILE - deskFrontEdge(desk)) * profile.height / (desk.h * TILE);
        assert.ok(sourceGap >= 0 && sourceGap <= MAX_CHAIR_DESK_GAP, `${desk.id}/${chair.id}: ${sourceGap}`);
      }
    }
  }
});
test("Names stay centered at feet; crowding shifts at most one height and selection draws in front", () => {
  const anchor = { x: 40, y: 100, w: CHARACTER_WIDTH, h: CHARACTER_HEIGHT };
  const items = Array.from({ length: 4 }, (_, i) => ({ id: String(i), anchor: { ...anchor, x: anchor.x + i }, size: { w: 100, h: 30 }, priority: i === 3 ? 2 : 0 }));
  const result = placeNames(items, 2);
  assert.equal(result[0].id, "3");
  assert.equal(result[0].dimmed, false);
  assert.ok(result.some(r => r.dimmed));
  for (const box of result) {
    const owner = items.find(i => i.id === box.id)!;
    assert.equal(box.x + box.w / 2, owner.anchor.x + owner.anchor.w / 2);
    assert.ok(box.y >= anchor.y + anchor.h && box.y - anchor.y - anchor.h <= box.h);
  }
});
test("Characters with hidden names still constrain label displacement", () => {
  const items=[{id:"selected",anchor:{x:0,y:100,w:64,h:96},size:{w:100,h:30},priority:2},
    {id:"hovered",anchor:{x:0,y:104,w:64,h:96},size:{w:100,h:30},priority:1}];
  assert.ok(placeNames(items,2)[1].shift>0);
  const result=placeNames(items,2,[...items.map(i=>i.anchor),{x:0,y:234,w:64,h:96}]);
  assert.equal(result[1].shift,0);assert.equal(result[1].dimmed,true);assert.equal(result[0].dimmed,false);
});
test("Adjacent walking labels cannot approach other characters", () => {
  const a={x:0,y:0,w:64,h:96};
  assert.equal(canShareFloor(a,{...a,y:100},42,4),false);
  assert.equal(canShareFloor(a,{...a,y:176},42,4),true);
  assert.equal(canShareFloor(a,{...a,x:64},42,4),true);
  assert.equal(canShareFloor(a,{...a,x:10},42,4),false);
});
test("Enlarged characters match desk height; bubbles avoid signs and one another", () => {
  const data = demoSnapshot(empty, 0), world = makeWorld(data.departments, data.agents);
  for (const desk of world.furniture.filter(f => f.kind === "desk"))
    assert.ok(CHARACTER_HEIGHT / (desk.h * TILE) >= .9 && CHARACTER_HEIGHT / (desk.h * TILE) <= 1.2);
  assert.equal(CHARACTER_WIDTH, Math.round(CHARACTER_WIDTH));
  assert.equal(CHARACTER_HEIGHT, Math.round(CHARACTER_HEIGHT));
  const blockers = [...world.signs, ...world.rooms.map(r => ({ x:r.x*TILE,y:r.y*TILE,w:r.w*TILE,h:r.h*TILE }))];
  for (const desk of world.desks) {
    const anchor = actorBounds(desk.seat), area = { x:16,y:96,w:world.cols*TILE-32,h:world.rows*TILE-112 };
    const box = placeBubble(anchor, {w:100,h:40}, area, blockers)!;
    assert.ok(box); assert.ok(blockers.every(b => !overlaps(box,b))); blockers.push(box);
  }
});
test("Legacy appearances persist; six hairstyles, colors and accessories validate", () => {
  const legacy = input("00000000-0000-4000-8000-000000000001").appearance;
  for (const style of ["kisa", "uzun"] as const) {
    const a = normalizeAppearance({ ...legacy, style });
    assert.equal(a.style, style);
    assert.equal(a.pants, "#354655");
    assert.equal(a.glasses, false);
  }
  const variants = hairStyles.map((style) => {
    const appearance = {
      ...legacy,
      style,
      pants: "#494031",
      glasses: true,
      tie: true,
      headphones: true,
    };
    const parsed = agentSchema.parse({
      ...input("00000000-0000-4000-8000-000000000001"),
      appearance,
    });
    assert.deepEqual(parsed.appearance, appearance);
    return appearance.style;
  });
  assert.equal(new Set(variants).size, 6);
  assert.equal(
    agentSchema.safeParse({
      ...input("00000000-0000-4000-8000-000000000001"),
      appearance: { ...legacy, pants: "red" },
    }).success,
    false,
  );
});
test("Atlases use transparent PNGs; all furniture and direction frames fit bounds", () => {
  for (const file of ["office", "character"]) {
    const atlas = JSON.parse(
      readFileSync(`public/assets/${file}-atlas.json`, "utf8"),
    );
    const image = readFileSync(`public${atlas.image}`);
    assert.equal(image.subarray(1, 4).toString(), "PNG");
    assert.equal(image[25], 6, "PNG must have a real alpha channel.");
    const width = image.readUInt32BE(16),
      height = image.readUInt32BE(20);
    for (const f of Object.values(atlas.frames) as {
      x: number;
      y: number;
      w: number;
      h: number;
    }[]) {
      assert.ok(f.x >= 0 && f.y >= 0 && f.w > 0 && f.h > 0);
      assert.ok(f.x + f.w <= width && f.y + f.h <= height);
    }
    if (file === "office") {
      for (const name of [
        "desk-pair",
        "window",
        "painting",
        "shelf",
        "water",
        "whiteboard",
        "fridge",
        "kitchen",
        "dining",
        "sofa",
        "pouf",
        "coffee",
        "foosball",
        "vending",
        "meeting",
        "screen",
        "clock",
        "door",
        "reception",
        "tree",
        "palm",
        "shrubs",
        "divider",
        ...DESK_ASSETS, ...CHAIR_ASSETS, ...SHELF_ASSETS, ...PLANT_ASSETS,
        "painting-landscape", "painting-fern", "painting-hills", "painting-circles",
        "printer", "filing-cabinet", "bin", "floor-lamp", "coat-rack", "corkboard", "window-curtains",
      ])
        assert.ok(atlas.frames[name], name);
      for (const name of DESK_ASSETS) {
        const f = atlas.frames[name];
        assert.equal(f.h, deskProfile({ variant: DESK_ASSETS.indexOf(name) }).height, `${name}: front-edge measurements must match the source`);
        assert.equal(f.screens.length, 2);
        for (const s of f.screens)
          assert.ok(s.x >= 0 && s.y >= 0 && s.x + s.w <= f.w && s.y + s.h <= f.h, `${name}: screen must stay inside the monitor`);
      }
    } else {
      for (const style of hairStyles)
        for (const pose of ["down", "up", "left", "right", "walk", "sit"])
          for (let frame = 0; frame < 3; frame++) {
            const f = atlas.frames[`${style}:${pose}:${frame}`];
            assert.ok(f);
            assert.equal(f.w, 32);
            assert.equal(f.h, 48);
          }
      const mask = readFileSync(`public${atlas.masks}`);
      assert.equal(mask.readUInt32BE(16), width);
      assert.equal(mask.readUInt32BE(20), height);
    }
  }
});
test("Resizing preserves furniture on the fixed map", () => {
 const seed=demoSnapshot(empty,0),a=makeWorld(seed.departments,seed.agents),b=makeWorld(seed.departments,seed.agents,"wide");assert.deepEqual(a.furniture,b.furniture);assert.equal(a.furniture.filter(f=>f.kind==="desk").length,12);assert.equal(makeWorld([],[]).rooms.length,0);
});
test("Idle screens are dark and static; working screens change subtly", () => {
  const paint = (working: boolean, time: number) => {
    const marks: unknown[] = [];
    const c = { fillStyle: "", fillRect(this: { fillStyle: string }, x: number, y: number, w: number, h: number) {
      assert.ok(x >= 10 && y >= 20 && x + w <= 44 && y + h <= 40);
      marks.push([this.fillStyle, x, y, w, h]);
    } } as unknown as CanvasRenderingContext2D;
    drawMonitor(c, 10, 20, 34, 20, time, working);
    return marks;
  };
  assert.deepEqual(paint(false, 0), paint(false, 800));
  assert.notDeepEqual(paint(true, 0), paint(true, 800));
  assert.notDeepEqual(paint(false, 0), paint(true, 0));
});
test("Furniture and characters sort by their common foot baseline", () => {
  const desk = { id: "desk", depth: 100 },
    behind = { id: "behind", depth: 90 },
    front = { id: "front", depth: 110 };
  assert.deepEqual(depthSort([front, desk, behind]), [behind, desk, front]);
  assert.deepEqual(
    depthSort([
      { id: "b", depth: 1 },
      { id: "a", depth: 1 },
    ]).map((o) => o.id),
    ["a", "b"],
  );
});
test("Every desk reaches rest areas through wall doorways", () => {
  const data = demoSnapshot(empty, 0),
    world = makeWorld(data.departments, data.agents);
  for (const desk of world.desks)
    for (const target of world.stops) {
      const start = { x: desk.x + 1, y: desk.y + 1 },
        route = pathfind(start, target, world);
      assert.ok(
        route.length || (start.x === target.x && start.y === target.y),
        `${desk.agentId} → ${cellKey(target.x, target.y)}`,
      );
      let previous = start;
      for (const point of route) {
        assert.equal(world.blocked.has(cellKey(point.x, point.y)), false);
        assert.equal(
          Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y),
          1,
        );
        previous = point;
      }
    }
  const partition=world.walls.find(w=>w.w <= 2 && w.y >= world.bottom)!;
  assert.deepEqual(
    pathfind(world.stops[0], { x: Math.floor(partition.x), y: Math.ceil(partition.y + 2) }, world),
    [],
  );
  const large = makeWorld(
    data.departments,
    Array.from({ length: 60 }, (_, i) => ({
      ...data.agents[0],
      id: `agent-${i}`,
      desk_x: i % 4,
      desk_y: Math.floor(i / 4),
    })),
  );
  assert.equal(large.desks.length, 60);
  assert.ok(large.rows > world.rows);
  const last = large.desks.at(-1)!;
  assert.ok(
    pathfind({ x: last.x + 1, y: last.y + 1 }, large.lounge, large).length,
  );
});
