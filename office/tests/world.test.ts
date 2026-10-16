import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld as buildWorld, OFFICE_MAPS, selectOfficeLayout, pathfind, cellKey, actorBounds, furnitureBounds, overlaps, chairUnderOwnDesk, TILE } from '../src/pixel/world';
import { demoSnapshot } from '../src/demo';
const seed = demoSnapshot({ departments: [], agents: [], messages: [], events: [], handoffs: [], rules: '' }, 0);
for (const layout of ["wide", "balanced"] as const) {
const OFFICE_MAP = OFFICE_MAPS[layout];
const makeWorld: typeof buildWorld = (departments,agents,_aspect,_height) => buildWorld(departments,agents,layout,_height);
for (const count of [0, 4, 14, 24, 32])
    test(`${layout}: ${count} agents: fixed map, reachable seats and allowed furniture`, () => {
        const agents = Array.from({ length: count }, (_, i) => ({ ...seed.agents[i % 6], id: `map-${i}`, department_id: seed.departments[i % 6].id }));
        const w = makeWorld(seed.departments, agents), other = makeWorld(seed.departments, agents, .4, 8);
        assert.equal(w.cols, OFFICE_MAP.cols);
        assert.deepEqual(w.furniture, other.furniture);
        assert.deepEqual(w.walls, other.walls);
        assert.equal(w.furniture.filter(f => f.kind === 'desk').length, Math.max(12, Math.ceil(seed.departments.reduce((sum,d)=>sum+Math.ceil(agents.filter(a=>a.department_id===d.id).length/2),0)/12)*12));
        assert.equal(w.desks.length, count);
        assert.equal(new Set(w.desks.map(d => d.seatId)).size, count);
        assert.equal(w.seats.filter(s => s.kind === 'meeting').length, count <= 14 ? 12 : Math.min(Math.ceil(count/2)*2, 24));
        assert.equal(w.rows-w.bottom, OFFICE_MAP.rows-OFFICE_MAP.bottom);
        assert.ok(w.furniture.filter(f => f.kind === 'plant').length <= 4);
        for (const seat of w.seats) {
            assert.ok(!w.blocked.has(cellKey(seat.approach.x, seat.approach.y)), seat.id);
            assert.ok(pathfind(seat.approach, w.lounge, w).length, `${seat.id}: access`);
            assert.deepEqual(seat.layers, ['chair-seat', 'character', 'chair-back']);
        }
        for (const p of w.stops)
            for (const f of w.furniture.filter(f => !f.wallMounted))
                assert.ok(!overlaps(actorBounds(p), furnitureBounds(f)), `${cellKey(p.x, p.y)}/${f.id}`);
        for (const f of w.furniture) {
            assert.ok(f.x >= 1 && f.x + f.w <= w.cols - 1 && f.y >= 1 && f.y + f.h <= w.rows - 1, f.id);
            for (const b of w.furniture.filter(o => o.id > f.id))
                assert.ok(chairUnderOwnDesk(f, b) || !overlaps(furnitureBounds(f), furnitureBounds(b)), `${f.id}/${b.id}`);
            for (const wall of w.walls)
                assert.ok(!overlaps(furnitureBounds(f), { x: wall.x * TILE, y: wall.y * TILE, w: wall.w * TILE, h: wall.h * TILE }), `${f.id}/duvar`);
        }
        assert.equal(w.doors.length, 3);
        assert.ok(w.walls.filter(w => w.h > 1).every(wall => wall.y === OFFICE_MAP.bottom + (w.rows-OFFICE_MAP.rows)));
        assert.ok(w.rests.filter(r => r.breakSpot).every(r => r.point.x > OFFICE_MAP.partitions[0] && r.point.x < OFFICE_MAP.partitions[1] && r.point.y > w.bottom));
    });
test(layout + ': ' + "Empty offices still have 12 islands; screen ratios and identity do not change geometry", () => {
    const empty = makeWorld([], []), full = makeWorld(seed.departments, seed.agents), shape = (w: typeof empty) => w.furniture.filter(f => f.kind === 'desk').map(({ x, y, w, h }) => ({ x, y, w, h }));
    assert.deepEqual(shape(empty), shape(full));
    assert.equal(empty.rooms.length, 0);
});
test(layout + ': ' + "A* uses open neighboring tiles and stays in place when the target is blocked", () => {
    const w = makeWorld([], []), start = w.seats[0].approach, path = pathfind(start, w.lounge, w);
    assert.ok(path.length);
    let previous = start;
    for (const p of path) {
        assert.equal(Math.abs(p.x - previous.x) + Math.abs(p.y - previous.y), 1);
        assert.ok(!w.blocked.has(cellKey(p.x, p.y)));
        previous = p;
    }
    assert.deepEqual(pathfind(start, { x: OFFICE_MAP.partitions[0], y: w.bottom + 4 }, w), []);
});

test(layout + ': ' + "Odd-sized departments get whole rug/sign islands and leave the paired seat empty", () => {
  const agents=seed.agents.slice(0,3).map((a,i)=>({...a,department_id:seed.departments[i].id}));
  const world=makeWorld(seed.departments,agents);
  assert.equal(world.rooms.length,3);
  for(const room of world.rooms) assert.equal(room.w,22);
  for(const table of world.furniture.filter(f=>f.kind==='desk' && f.seatAgentIds?.some(Boolean))) {
    assert.equal(table.seatAgentIds!.filter(Boolean).length,1);
    assert.ok(!table.seatAgentIds![1]);
  }
});
test(layout + ': ' + "Meetings start with 12 seats; larger teams extend the table while preserving chair scale", () => {
  const small=makeWorld([],[]),large=makeWorld(seed.departments,Array.from({length:24},(_,i)=>({...seed.agents[0],id:`capacity-${i}`})));
  assert.equal(small.seats.filter(s=>s.kind==='meeting').length,12);
  assert.equal(large.seats.filter(s=>s.kind==='meeting').length,24);
  assert.ok(large.furniture.find(f=>f.kind==='meeting')!.w>small.furniture.find(f=>f.kind==='meeting')!.w);
  assert.ok(large.furniture.filter(f=>f.kind==='chair').every(f=>f.w===2 && f.h===3));
});

for (const count of [6, 14, 24]) test(`${layout}: ${count} agents: seated meeting bodies never overlap opposite chairs`, () => {
  const agents = Array.from({length: count}, (_, i) => ({...seed.agents[i % 6], id: `meeting-box-${i}`}));
  const world = makeWorld(seed.departments, agents);
  for (const seat of world.seats.filter(s => s.kind === 'meeting')) {
    for (const furniture of world.furniture) {
      if (furniture.id === seat.chairId || furniture.id === seat.tableId) continue;
      assert.ok(!overlaps(actorBounds(seat.point), furnitureBounds(furniture)), `${seat.id}/${furniture.id}`);
    }
    // Departure frames and walking routes must also stay outside chair boxes.
    const path = [seat.approach, ...pathfind(seat.approach, world.lounge, world)];
    for (let i = 0; i < path.length; i++) {
      const from = path[Math.max(0, i - 1)], to = path[i];
      for (const part of [0, .25, .5, .75, 1]) {
        const box = actorBounds({x: from.x + (to.x - from.x) * part, y: from.y + (to.y - from.y) * part});
        for (const chair of world.furniture.filter(f => f.kind === 'chair'))
          assert.ok(!overlaps(box, furnitureBounds(chair)), `${seat.id}: walking/${chair.id}`);
      }
    }
  }
});

}
test("Layout hysteresis prevents switching; phones always use balanced layout",()=>{
 assert.equal(selectOfficeLayout(1.6), 'wide');
 assert.equal(selectOfficeLayout(1.53,'wide'), 'wide');
 assert.equal(selectOfficeLayout(1.51,'wide'), 'balanced');
 assert.equal(selectOfficeLayout(1.67,'balanced'), 'balanced');
 assert.equal(selectOfficeLayout(1.69,'balanced'), 'wide');
 assert.equal(selectOfficeLayout(2,'wide',true), 'balanced');
 const wide=buildWorld(seed.departments,seed.agents,'wide'), balanced=buildWorld(seed.departments,seed.agents,'balanced');
 assert.deepEqual(wide.seats.map(s=>s.id),balanced.seats.map(s=>s.id));
 assert.deepEqual(wide.furniture.map(f=>[f.id,f.kind,f.w,f.h]),balanced.furniture.map(f=>[f.id,f.kind,f.w,f.h]));
});

for(const count of [14,24,32]) test(`${count} agents: both layouts share the same seat and desk sets`,()=>{
 const agents=Array.from({length:count},(_,i)=>({...seed.agents[i%6],id:`identity-${i}`,department_id:seed.departments[i%6].id}));
 const wide=buildWorld(seed.departments,agents,'wide'),balanced=buildWorld(seed.departments,agents,'balanced');
 assert.deepEqual(wide.seats.map(s=>[s.id,s.agentId,s.chairId,s.tableId,s.kind,s.screenIndex]),balanced.seats.map(s=>[s.id,s.agentId,s.chairId,s.tableId,s.kind,s.screenIndex]));
 assert.deepEqual(wide.furniture.map(f=>[f.id,f.kind,f.w,f.h]),balanced.furniture.map(f=>[f.id,f.kind,f.w,f.h]));
});
