import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoSnapshot } from '../src/demo';
import { canShareFloor } from '../src/pixel/characterGeometry';
import { makeWorld as buildWorld, actorBounds, overlaps, furnitureBounds, cellKey } from '../src/pixel/world';
import { createMotion, remapMotion, stepMotion, motionVisual, converse, meetChain, breakLimit, monitorState, seatedAnimation, callMeeting } from '../src/pixel/motion';
const seed = demoSnapshot({ departments: [], agents: [], messages: [], events: [], handoffs: [], rules: '' }, 0);
const fixture = (n: number) => Array.from({ length: n }, (_, i) => ({ ...seed.agents[i % 6], id: `motion-${i}`, status: 'bosta' as typeof seed.agents[0]['status'], department_id: seed.departments[i % 3].id }));
for (const layout of ["wide", "balanced"] as const) {
const makeWorld: typeof buildWorld = (departments,agents) => buildWorld(departments,agents,layout);
for (const count of [14, 24])
    test(`${layout}: ${count} agents: ten minutes at 100ms frames, reservations, furniture and break limits`, () => {
        const team = fixture(count), world = makeWorld(seed.departments, team);
        let s = createMotion(world, team), moves = 0, seated = 0;
        const before = JSON.stringify([...s.actors]);
        stepMotion(s, world, team, 100);
        assert.equal(JSON.stringify([...s.actors]), before);
        for (let frame = 0; frame < 6000; frame++) {
            s = stepMotion(s, world, team, 100);
            const cells = new Set<string>();
            assert.ok([...s.actors.values()].filter(a => a.breakArea).length <= breakLimit(count));
            for (let i = 0; i < team.length; i++) {
                const a = team[i], w = s.actors.get(a.id)!, v = motionVisual(world, a, w);
                if (w.path.length)
                    moves++;
                if (w.seated && !w.restId)
                    seated++;
                const key = cellKey(Math.round(v.point.x), Math.round(v.point.y));
                assert.ok(!cells.has(key), `${frame}: ${key}`);
                cells.add(key);
                if (!v.seated)
                    assert.ok(!world.blocked.has(cellKey(Math.round(w.position.x), Math.round(w.position.y))));
                for (const b of team.slice(i + 1))
                    assert.ok(!overlaps(actorBounds(v.point), actorBounds(motionVisual(world, b, s.actors.get(b.id)!).point)), `${frame}: ${a.id}/${b.id}`);
                for (const f of world.furniture) {
                    if (v.seated && (f.id === v.chair?.id || f.id === v.rest?.furnitureId || f.id === v.seat?.tableId))
                        continue;
                    assert.ok(!overlaps(actorBounds(v.point), furnitureBounds(f)), `${frame}: ${a.id}/${f.id}`);
                }
            }
        }
        assert.ok(moves > 0);
        assert.ok(seated / (6000 * count) > .8);
    });
test(layout + ': ' + "Handoffs use opposing seats, start timing once seated and return both agents home", () => {
    const team = fixture(4), world = makeWorld(seed.departments, team);
    let s = converse(createMotion(world, team), world, team, team[0].id, team[1].id);
    assert.ok(s.actors.get(team[0].id)!.path.length);
    assert.ok(s.actors.get(team[1].id)!.path.length);
    assert.equal(world.rests.find(r => r.id === s.actors.get(team[0].id)!.restId)!.direction, 'down');
    assert.equal(world.rests.find(r => r.id === s.actors.get(team[1].id)!.restId)!.direction, 'up');
    let met = false;
    for (let i = 0; i < 2500; i++) {
        s = stepMotion(s, world, team, 100);
        const people = team.slice(0, 2).map(a => s.actors.get(a.id)!);
        if (people.every(a => a.seated && a.meetingId))
            met = true;
        if (met && people.every(a => a.seated && !a.restId))
            break;
    }
    assert.ok(met);
    assert.ok(team.slice(0, 2).every(a => s.actors.get(a.id)!.seated && !s.actors.get(a.id)!.restId));
});
for (const count of [3])
    test(`${layout}: ${count}-person meeting: seat reservations and safe return`, () => {
        const team = fixture(count), world = makeWorld(seed.departments, team);
        let s = meetChain(createMotion(world, team), world, team, team.map(a => a.id));
        assert.equal([...s.actors.values()].filter(a => a.meetingId).length, count);
        assert.equal(new Set([...s.actors.values()].map(a => a.restId)).size, count);
        let met = false;
        for (let i = 0; i < 4000; i++) {
            s = stepMotion(s, world, team, 100);
            for (let j = 0; j < team.length; j++) {
                const actor = s.actors.get(team[j].id)!, v = motionVisual(world, team[j], actor);
                for (const other of team.slice(j + 1))
                    assert.ok(!overlaps(actorBounds(v.point), actorBounds(motionVisual(world, other, s.actors.get(other.id)!).point)), `Meeting ${i}: bodies`);
                if (v.seated && v.rest)
                    assert.equal(actor.direction, v.rest.direction);
            }
            if ([...s.actors.values()].every(a => a.seated && a.meetingId))
                met = true;
            if (met && [...s.actors.values()].every(a => a.seated && !a.restId))
                break;
        }
        assert.ok(met, 'Herkes oturabilmeli');
        assert.ok([...s.actors.values()].every(a => a.seated && !a.restId), "Everyone must be able to return");
    });
test(layout + ': ' + "Reduced/still motion is fixed; inactive agents and empty desk screens stay off", () => {
    const team = fixture(4), world = makeWorld(seed.departments, team);
    let s = createMotion(world, team);
    for (let i = 0; i < 600; i++)
        s = stepMotion(s, world, team, 1000, true);
    assert.ok([...s.actors.values()].every(a => a.seated && !a.path.length));
    s = stepMotion(s, world, team, 0, false, 42, 'durgun');
    assert.equal(callMeeting(s, world, team, team.map(a => a.id)), s);
    for (const status of ['calisiyor', 'bekliyor', 'bosta', 'kapali'] as const) {
        team[0].status = status;
        s = stepMotion(s, world, team, 100, true);
        assert.equal(monitorState(world, team[0], s.actors.get(team[0].id)), ({ calisiyor: 'working', bekliyor: 'waiting', bosta: 'idle', kapali: 'off' } as const)[status]);
    }
    assert.equal(monitorState(world, undefined, undefined), 'off');
});
test(layout + ': ' + "New work immediately interrupts breaks and returns the agent home", () => {
    const team = fixture(4), world = makeWorld(seed.departments, team);
    let s = createMotion(world, team);
    for (const w of s.actors.values())
        w.until = 0;
    s = stepMotion(s, world, team, 100);
    const away = [...s.actors].find(([, w]) => w.breakArea)!;
    assert.ok(away);
    team.find(a => a.id === away[0])!.status = 'calisiyor';
    s = stepMotion(s, world, team, 100);
    assert.equal(s.actors.get(away[0])!.restId, undefined);
    for (let i = 0; i < 1000; i++)
        s = stepMotion(s, world, team, 100);
    assert.ok(s.actors.get(away[0])!.seated);
});
test(layout + ': ' + "Typing/breathing phases differ; reduced motion remains fixed", () => { assert.notDeepEqual(seatedAnimation('a', 10000, true, false), seatedAnimation('başka', 10000, true, false)); assert.deepEqual(seatedAnimation('a', 10000, true, true), seatedAnimation('a', 20000, true, true)); });

for(const count of [14,24])test(`${layout}: ${count}-person call: unfinished group walks never start; everyone stays seated`,()=>{
 const team=fixture(count),world=makeWorld(seed.departments,team),initial=createMotion(world,team);
 assert.equal(callMeeting(initial,world,team,team.map(a=>a.id)),initial);
 assert.ok([...initial.actors.values()].every(a=>a.seated&&!a.path.length&&!a.restId));
});


test(layout + ': ' + "Activation, handoffs, layout changes and enlarged names preserve bodies and label ownership over 12000 frames",()=>{
 const initial={...seed,departments:seed.departments.slice(0,1),agents:fixture(14).map(a=>({...a,department_id:seed.departments[0].id}))};
 let world=makeWorld(initial.departments,initial.agents);
 let team=demoSnapshot(initial,0).agents,s=createMotion(world,team,17,47);
 for(let frame=0;frame<12000;frame++) {
  const tick=Math.floor(frame/200);
  team=demoSnapshot(initial,tick).agents;
  const height=[47,77,92][Math.floor(frame/600)%3];
  if(frame>0 && frame%600===0) {
   const next=buildWorld(initial.departments,initial.agents,world.layout==='wide' ? 'balanced' : 'wide');
   s=remapMotion(s,world,next,team,height);world=next;
  }
  if(frame%200===0 && frame>0)s=converse(s,world,team,team[tick%team.length].id,team[(tick+1)%team.length].id);
  s=stepMotion(s,world,team,100,false,height,'canli');
  const active=team.filter(a=>a.status!=='kapali');
  for(let i=0;i<active.length;i++) {
   const actor=s.actors.get(active[i].id)!,visual=motionVisual(world,active[i],actor),a=actorBounds(visual.point);
   if(!visual.seated)assert.ok(!world.blocked.has(cellKey(Math.round(actor.position.x),Math.round(actor.position.y))),`${frame}: open floor`);
   for(const other of active.slice(i+1)) {
    const b=actorBounds(motionVisual(world,other,s.actors.get(other.id)!).point);
    assert.ok(!overlaps(a,b),`${frame}: bodies`);
    assert.ok(canShareFloor(a,b,height,height*2/21),`${frame}: ad sahibi`);
   }
  }
 }
});

}
for(const [from,to] of [['wide','balanced'],['balanced','wide']] as const) test(`${from} → ${to}: preserve seated identity and ongoing walks`,()=>{
 const team=fixture(4),old=buildWorld(seed.departments,team,from),world=buildWorld(seed.departments,team,to);
 let input=converse(createMotion(old,team),old,team,team[0].id,team[1].id);
 input=stepMotion(input,old,team,1000);
 const changed=remapMotion(input,old,world,team);
 for(const a of team){
  const w=changed.actors.get(a.id)!;
  assert.ok(!world.blocked.has(cellKey(w.cell.x,w.cell.y)));
  if(input.actors.get(a.id)!.seated) assert.equal(motionVisual(world,a,w).seat?.agentId,a.id);
  else if(!w.seated){
   assert.notDeepEqual(w.position,w.target,"Walking agents must not teleport to their destination");
   let previous=w.cell;
   for(const p of w.path){assert.equal(Math.abs(previous.x-p.x)+Math.abs(previous.y-p.y),1);assert.ok(!world.blocked.has(cellKey(p.x,p.y)));previous=p;}
  }
 }
 let s=changed;
 for(let frame=0;frame<4000;frame++) s=stepMotion(s,world,team,100);
 assert.ok([...s.actors.values()].every(a=>a.seated || a.path.length));
});

test.todo("Both layouts: safe entry, seating and return for 14/24-person meetings");
