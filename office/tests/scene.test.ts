import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, OFFICE_MAPS, TILE } from '../src/pixel/world.js';
import { topWallWindows, TOP_WALL_HEIGHT, rugPalette } from '../src/pixel/furniture.js';
import { CHARACTER_WIDTH, CHARACTER_HEIGHT } from '../src/pixel/characterGeometry.js';
import { demoSnapshot } from '../src/demo.js';
import { setLanguage } from '../src/i18n/index.js';

setLanguage('tr');

const seed = demoSnapshot({departments:[],agents:[],messages:[],events:[],handoffs:[],rules:''},0);
const center = (box: {x:number;w:number}) => box.x+box.w/2;
const near = (a:number,b:number,tolerance=1e-8) => assert.ok(Math.abs(a-b)<=tolerance, `${a} / ${b}`);
for (const layout of ['wide','balanced'] as const) for (const count of [0,4,14,24,32]) {
  test(`${layout}, ${count} agents: balanced grid, rooms, seats and rugs`, () => {
    const agents = Array.from({length:count},(_,i)=>({...seed.agents[i%6],id:`symmetry-${i}`}));
    const world = makeWorld(seed.departments,agents,layout), map = OFFICE_MAPS[layout];
    const tables = world.furniture.filter(f=>f.kind==='desk');
    const left = Math.min(...tables.map(f=>f.x)), right = Math.max(...tables.map(f=>f.x+f.w));
    near((left+right)/2, world.cols/2, 1);
    near(left, world.cols-right, 1);
    assert.ok(!world.furniture.some(f=>f.kind==='sofa'||f.kind==='coffee'||f.kind==='board'));
    assert.deepEqual(world.rests.filter(r=>r.breakSpot).map(r=>r.id),['water-break','reception-break']);
    assert.equal(world.rows-world.bottom,32);
    for (const [i,text] of ['GENEL MÜDÜR','GİRİŞ','TOPLANTI'].entries()) {
      near(center(world.signs.find(s=>s.text===text)!)/TILE,map.doorCenters[i]);
      near(world.doors[i].x,map.doorCenters[i]);
    }
    const find = (id:string) => world.furniture.find(f=>f.id===id)!;
    near(center(find('director-desk')),map.doorCenters[0]);
    near((center(find('guest-0'))+center(find('guest-1')))/2,map.doorCenters[0]);
    near((center(find('director-library'))+center(find('director-library-right')))/2,map.doorCenters[0]);
    near(center(find('director-picture')),map.doorCenters[0]);
    near(center(find('reception')),map.doorCenters[1]);
    near(center(find('entrance-door')),map.doorCenters[1]);
    near((center(find('water'))+center(find('entrance-plant')))/2,map.doorCenters[1]);
    near(center(find('meeting-table')),map.meetingCenter);
    near((center(find('meeting-head-0'))+center(find('meeting-head-1')))/2,map.meetingCenter);
    near((center(find('work-plant'))+center(find('work-plant-right')))/2,world.cols/2);
    for (const table of tables) {
      const chairs = world.furniture.filter(f=>f.islandId===table.id);
      near(chairs.reduce((sum,f)=>sum+center(f),0)/2,center(table));
      const room = world.rooms.find(r=>r.x===table.x&&r.y===table.y-13&&r.w===table.w);
      if (room) {
        near(center(room),center(table));
        const rug = world.rugs.find(r=>r.x===(table.x-1)*TILE)!;
        near(center(rug),center(table)*TILE);
        near(rug.x+TILE,table.x*TILE);
        near(rug.x+rug.w-TILE,(table.x+table.w)*TILE);
      }
    }
  });
}
test("Windows are at least twice as wide, evenly spaced and reflective, covering most of the wall", () => {
  for (const map of Object.values(OFFICE_MAPS)) {
    const windows = topWallWindows(map.cols);
    for (const [i,w] of windows.entries()) {
      assert.ok(w.w>=2*9.8*TILE);
      assert.ok(w.h>=TOP_WALL_HEIGHT*.85 && w.y+w.h<=TOP_WALL_HEIGHT);
      near(center(w)+center(windows[3-i]),map.cols*TILE);
      if(i>1) near(w.x-windows[i-1].x,windows[1].x-windows[0].x);
    }
  }
  assert.equal(CHARACTER_WIDTH/64,1.1875);
  assert.equal(CHARACTER_HEIGHT/96,1.1875);
});
test("Department rugs use warm floor-adjacent colors with subtle borders", () => {
  const rgb = (hex:string) => [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));
  for (const color of ['#0000ff','#00ff00','#ff8000',...seed.departments.map(d=>d.color)]) {
    const {fill,border} = rugPalette(color), actual=rgb(fill), edge=rgb(border);
    assert.ok(actual.every((v,i)=>Math.abs(v-[221,191,154][i])<=27));
    assert.ok(actual.every((v,i)=>Math.abs(v-edge[i])<=34));
  }
});
