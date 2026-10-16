import type { Agent } from '../../shared/types';
import { canShareFloor } from './characterGeometry';
import type { Direction } from './sprites';
import { actorBounds, actorVisual, cellKey, overlaps, pathfind, TILE, type Point, type World, type Seat } from './world';
export type MovementMode = 'sakin' | 'canli' | 'durgun';
export const breakLimit = (count: number) => Math.max(1, Math.floor(count / 4));
export type MotionActor = {
    position: Point;
    cell: Point;
    target: Point;
    path: Point[];
    until: number;
    direction: Direction;
    seated: boolean;
    restId?: string;
    breakArea?: string;
    wait: number;
    arrivals: number;
    retargets: number;
    talkUntil: number;
    partner?: string;
    nameWidth: number;
    meetingId?: string;
    returning?: boolean;
    previousStatus?: Agent['status'];
    completedUntil?: number;
};
export type Motion = {
    actors: Map<string, MotionActor>;
    seed: number;
    time: number;
    nameWidths?: Record<string, number>;
    movementMode?: MovementMode;
    labelHeight?: number;
    meetingDuration?: number;
};
const home = (world: World, id: string) => { const d = world.desks.find(d => d.agentId === id); return d ? { x: d.x + 1, y: d.y + 1 } : world.lounge; };
const random = (s: Motion) => { s.seed = (Math.imul(s.seed, 1664525) + 1013904223) >>> 0; return s.seed / 4294967296; };
export function motionVisual(world: World, agent: Agent, actor: MotionActor) {
    const rest = world.rests.find(r => r.id === actor.restId), seat = world.seats.find(s => s.id === rest?.seatId);
    if (actor.seated && rest?.seat && actor.position.x===rest.point.x && actor.position.y===rest.point.y)
        return { point: rest.seat, seated: true, chair: seat ? world.furniture.find(f => f.id === seat.chairId) : undefined, rest, direction: rest.direction || 'down' as Direction, seat };
    return { ...actorVisual(agent, actor.position, !actor.seated, world), rest: undefined };
}
export function floorClear(a: Point, b: Point, _labelHeight = 42, gap = TILE) { const box = actorBounds(a); return canShareFloor(actorBounds(a),actorBounds(b),_labelHeight,_labelHeight*2/21) && !overlaps({ ...box, x: box.x - gap, y: box.y - gap, w: box.w + 2 * gap, h: box.h + 2 * gap }, actorBounds(b)); }
export function createMotion(world: World, team: Agent[], seed = 17, _labelHeight = 42, widths?: Record<string, number>): Motion {
    const s: Motion = { actors: new Map(), seed, time: 0, nameWidths: widths, labelHeight:Math.max(96,_labelHeight) };
    for (const a of team) {
        const p = home(world, a.id);
        s.actors.set(a.id, { position: p, cell: p, target: p, path: [], until: 240000 + random(s) * 240000, direction: 'up', seated: a.status !== 'kapali', wait: 0, arrivals: 0, retargets: 0, talkUntil: 0, nameWidth: widths?.[a.id] || 100, previousStatus: a.status });
    }
    return s;
}
const clone = (s: Motion): Motion => ({ ...s, actors: new Map([...s.actors].map(([id, a]) => [id, { ...a, position: { ...a.position }, cell: { ...a.cell }, target: { ...a.target }, path: [...a.path] }])) });
// Seated agents move to the new seat with the same ID. Walking agents find
// a route from the closest open, unreserved tile toward their existing goal.
export function remapMotion(input: Motion, previous: World, world: World, team: Agent[], labelHeight = 42): Motion {
    const s = createMotion(world, team, input.seed, labelHeight, input.nameWidths);
    s.time = input.time;
    s.movementMode = input.movementMode;
    s.meetingDuration = input.meetingDuration;
    for (const [id,w] of s.actors) {
        const old = input.actors.get(id);
        if (old) Object.assign(w,{until:Math.max(s.time+1000,old.until),arrivals:old.arrivals,retargets:old.retargets,completedUntil:old.completedUntil});
        else w.until += s.time;
    }
    // Reactivated seats are placed directly; they do not count as walking agents.
    const walking = team.filter(a => input.actors.has(a.id) && !input.actors.get(a.id)!.seated && input.actors.get(a.id)!.previousStatus !== 'kapali' && a.status !== 'kapali');
    for (const a of walking) {
        const old = input.actors.get(a.id)!;
        const candidates: Point[] = [];
        for (let y = 7; y < world.rows - 1; y++)
            for (let x = 1; x < world.cols - 1; x++)
                if (!world.blocked.has(cellKey(x,y)) && !(y >= world.bottom && x <= world.walls.find(w=>w.h>1)!.x))
                    candidates.push({x,y});
        candidates.sort((a,b)=>Math.hypot(a.x-old.position.x,a.y-old.position.y)-Math.hypot(b.x-old.position.x,b.y-old.position.y) || a.y-b.y || a.x-b.x);
        const p = candidates.find(p=>clear(s,world,team,a.id,p));
        const fallback = home(world,a.id);
        const w = { ...old, position: p || fallback, cell: p || fallback, path: [], wait: 0, seated: !p, target: fallback };
        s.actors.set(a.id,w);
        const rest = world.rests.find(r=>r.id===old.restId);
        const oldHome = home(previous,a.id);
        const wasReturning = old.returning || (old.target.x===oldHome.x && old.target.y===oldHome.y);
        const target = wasReturning || !rest ? fallback : rest.point;
        if (wasReturning || !rest)
            Object.assign(w,{restId:undefined,breakArea:undefined,meetingId:undefined,partner:undefined,returning:true});
        if (!p || !route(s,world,team,a.id,target)) {
            Object.assign(w,{position:fallback,cell:fallback,target:fallback,seated:true,restId:undefined,breakArea:undefined,meetingId:undefined,partner:undefined,returning:false});
        }
    }
    return s;
}
// Reserve every tile covered by the body. Pathfinding and stepping use
// the same reservations, with no separate collision or avoidance rules.
export function reservedPoints(state: Motion, world: World, team: Agent[], except: string): Point[] {
    return team.filter(a=>a.id!==except).flatMap(a=>{
        const w=state.actors.get(a.id);
        if(!w)return [];
        // Keep the inactive seat label and leave its space free for reactivation.
        if(a.status==='kapali' || w.previousStatus==='kapali') {
            const seat=world.desks.find(d=>d.agentId===a.id)?.seat;
            return seat ? [seat] : [];
        }
        return w.seated ? [motionVisual(world,a,w).point] : [w.position,w.cell,...(w.path.length && (w.position.x!==w.cell.x || w.position.y!==w.cell.y) ? [w.path[0]] : [])];
    });
}
function clear(state: Motion, world: World, team: Agent[], id: string, p: Point) { return reservedPoints(state, world, team, id).every(q => floorClear(p, q, state.labelHeight||42, 0)); }
function route(state: Motion, world: World, team: Agent[], id: string, target: Point) {
    const w = state.actors.get(id)!;
    if (!clear(state, world, team, id, target) || !clear(state, world, team, id, w.cell))return false;
    if (w.path.length) {
        w.position = { ...w.cell };
        w.path = [];
    }
    const blocked = new Set(world.blocked);
    for (const q of reservedPoints(state, world, team, id))
        for (let y = Math.floor(q.y) - Math.ceil(8+(state.labelHeight||42)/TILE); y <= Math.ceil(q.y) + Math.ceil(8+(state.labelHeight||42)/TILE); y++)
            for (let x = Math.floor(q.x) - Math.ceil(4+(state.labelHeight||42)/TILE); x <= Math.ceil(q.x) + Math.ceil(4+(state.labelHeight||42)/TILE); x++)
                if (!floorClear({ x, y }, q, state.labelHeight||42, 0))
                    blocked.add(cellKey(x, y));
    // Employees cannot take shortcuts through the Director room.
    for (let y = world.bottom; y < world.rows; y++)
        for (let x = 0; x < world.walls.find(w=>w.h>1)!.x + 1; x++)
            blocked.add(cellKey(x, y));
    const path = pathfind(w.cell, target, { ...world, blocked });
    if (!path.length && !(w.cell.x === target.x && w.cell.y === target.y))return false;
    w.path = path;
    w.target = target;
    w.wait = 0;
    return true;
}
function settle(w: MotionActor, world: World, a: Agent) {
    const rest = world.rests.find(r => r.id === w.restId), p = home(world, a.id);
    w.seated = a.status !== 'kapali' && ((rest?.seat !== undefined && w.position.x === rest.point.x && w.position.y === rest.point.y) || (w.position.x === p.x && w.position.y === p.y && !w.restId));
    if (w.seated)
        w.direction = rest?.direction || 'up';
}
export function stepMotion(input: Motion, world: World, team: Agent[], milliseconds: number, reduced = false, _labelHeight = 42, mode: MovementMode = 'sakin'): Motion {
    const s = clone(input);
    s.time += milliseconds;
    // Include enlarged labels in walking reservations at normal screen sizes.
    s.labelHeight=Math.max(96,_labelHeight);
    s.movementMode = mode;
    const active = team.filter(a => a.status !== 'kapali');
    // Queue four agents for entry/return without crowding one doorway.
    const travel=team.filter(a=>{const w=s.actors.get(a.id);return w?.path.length && (w.meetingId||(w.returning&&!w.breakArea));});
    const admitted=new Set([...travel.filter(a=>!s.actors.get(a.id)!.seated),...travel.filter(a=>s.actors.get(a.id)!.seated)].slice(0,4).map(a=>a.id));
    if (mode === 'canli' && input.movementMode !== mode)
        for (const w of s.actors.values())
            w.until = Math.min(w.until, s.time + 60000 + random(s) * 120000);
    for (const a of team) {
        const w = s.actors.get(a.id);
        if (!w)
            continue;
        if (w.previousStatus === 'calisiyor' && a.status === 'bosta')
            w.completedUntil = s.time + 1600;
        w.previousStatus = a.status;
        if (a.status === 'kapali') {
            w.path = [];
            w.restId = undefined;
            w.meetingId = undefined;
            w.seated = false;
            w.position = w.cell = home(world, a.id);
            continue;
        }
        const p = home(world, a.id), atHome = w.position.x === p.x && w.position.y === p.y && !w.path.length;
        if (reduced || mode === 'durgun') {
            // Disabling motion returns agents to fixed seats without unfinished walks.
            w.position = w.cell = w.target = p;
            w.path = [];
            w.restId = w.breakArea = w.partner = w.meetingId = undefined;
            w.seated = true;
            w.direction = 'up';
            continue;
        }
        const rest = world.rests.find(r => r.id === w.restId);
        const meetingDone = w.meetingId && w.talkUntil > 0 && s.time >= w.talkUntil;
        const breakDone = rest?.breakSpot && (a.status !== 'bosta' || (!w.path.length && s.time >= w.until));
        if ((meetingDone || breakDone || (!atHome && !w.restId && !w.path.length)) && !w.returning) {
            if (route(s, world, team, a.id, p)) {
                w.returning = true;
                if(breakDone&&!w.seated)w.restId=undefined;
            }
        }
        if (atHome) {
            w.returning = false;
            w.breakArea = undefined;
        }
        if (a.status === 'bosta' && atHome && !w.meetingId && s.time >= w.until) {
            const away = active.filter(a => s.actors.get(a.id)?.breakArea).length;
            if (away < breakLimit(active.length)) {
                const spots = world.rests.filter(r => r.breakSpot && !active.some(a => s.actors.get(a.id)?.breakArea === r.id));
                const r = spots[Math.floor(random(s) * spots.length)];
                if (r && route(s, world, team, a.id, r.point)) {
                    w.restId = r.id;
                    w.breakArea = r.id;
                }
            }
            w.until = s.time + (mode === 'canli' ? 60000 : 240000) + random(s) * (mode === 'canli' ? 120000 : 240000);
        }
        if (!w.path.length && (w.cell.x !== w.target.x || w.cell.y !== w.target.y)) {
            w.wait += milliseconds;
            if (w.wait >= 1000) {
                w.wait = 0;
                route(s, world, team, a.id, w.target);
            }
        }
        if(w.path.length&&(w.meetingId||(w.returning&&!w.breakArea))&&!admitted.has(a.id))continue;
        if (w.path.length) {
            const next = w.path[0], dx = next.x - w.position.x, dy = next.y - w.position.y, d = Math.hypot(dx, dy), advance = Math.min(d, milliseconds / 1000 * 7), candidate = d ? { x: w.position.x + dx / d * advance, y: w.position.y + dy / d * advance } : next;
            if ((!w.seated || clear(s,world,team,a.id,w.cell)) && clear(s, world, team, a.id, next) && clear(s, world, team, a.id, candidate)) {
                w.seated=false;
                if(w.returning)w.restId=w.partner=w.meetingId=undefined;
                w.direction = Math.abs(dx) > Math.abs(dy) ? dx > 0 ? 'right' : 'left' : dy > 0 ? 'down' : 'up';
                w.position = candidate;
                w.wait = 0;
                if (advance >= d) {
                    w.position = w.cell = next;
                    w.path.shift();
                }
                if (!w.path.length) {
                    w.arrivals++;
                    w.until = s.time + (w.breakArea ? 20000 + random(s) * 40000 : 240000 + random(s) * 240000);
                    settle(w, world, a);
                    if (w.seated && !clear(s, world, team, a.id, motionVisual(world, a, w).point))
                        w.seated = false;
                }
            }
            else {
                w.wait += milliseconds;
                if (w.wait >= 4000) {
                    w.position = { ...w.cell };
                    w.path = [];
                    w.retargets++;
                    w.wait = 0;
                    route(s, world, team, a.id, w.target);
                }
            }
        }
        else {
            settle(w, world, a);
            if (w.seated && !clear(s, world, team, a.id, motionVisual(world, a, w).point))
                w.seated = false;
        }
    }
    // Start conversation timing only after all participants are seated.
    const meetings = new Set([...s.actors.values()].map(w => w.meetingId).filter(Boolean));
    for (const id of meetings) {
        const participants = [...s.actors.values()].filter(w => w.meetingId === id);
        if (participants.every(w => !w.path.length && w.seated) && participants.every(w => w.talkUntil === 0))
            for (const w of participants)
                w.talkUntil = s.time + (s.meetingDuration || 15000);
    }
    return s;
}
export function callMeeting(input: Motion, world: World, team: Agent[], ids: string[], duration = 30000): Motion {
    if (input.movementMode === 'durgun')
        return input;
    const s = clone(input), participants = team.filter(a => ids.includes(a.id) && a.status !== 'kapali');
    if (participants.length < 2 || participants.length > 3)
        return input;
    // Assign pairs to opposing table edges before using the end seats.
    const seats = world.seats.filter(s => s.kind === 'meeting'), id = `meeting-${s.time}`, reserved = new Set([...s.actors.values()].filter(w => !participants.some(a => s.actors.get(a.id) === w)).map(w => w.restId));
    const available = seats.filter(seat => !reserved.has(seat.id));
    const chosen:Seat[]=[];
    for(let i=0;i<participants.length;i++) {
        const candidates=available.filter(seat=>!chosen.includes(seat) && seat.direction===(i%2 ? 'up' : 'down'));
        const next=candidates.find(seat=>chosen.every(other=>floorClear(seat.point,other.point,s.labelHeight||96,0)));
        if(!next)return input;
        chosen.push(next);
    }
    if (available.length < participants.length)
        return input;
    s.meetingDuration = duration;
    for (let i = 0; i < participants.length; i++) {
        const a = participants[i], w = s.actors.get(a.id)!, seat = chosen[i];
        w.restId = seat.id;
        w.meetingId = id;
        w.talkUntil = 0;
        w.partner = participants[(i + 1) % participants.length].id;
        w.returning = false;
        w.breakArea = undefined;
        if (!route(s, world, team, a.id, seat.approach)) return input;
    }
    return s;
}
export function converse(input: Motion, world: World, team: Agent[], first: string, second: string, _labelHeight = 42) { return callMeeting(input, world, team, [first, second], 10000 + (input.seed % 10001)); }
export function meetChain(input: Motion, world: World, team: Agent[], ids: string[], _labelHeight = 42) { return callMeeting(input, world, team, ids, 30000); }
export function monitorState(world: World, agent: Agent | undefined, actor: MotionActor | undefined): 'off' | 'idle' | 'working' | 'waiting' | 'warning' {
    if (!agent || !actor || agent.status === 'kapali' || !actor.seated || actor.position.x!==home(world,agent.id).x || actor.position.y!==home(world,agent.id).y)
        return 'off';
    if (agent.status === 'bekliyor')
        return 'waiting';
    if (/engel|hata|başarısız/i.test(agent.current_job || ''))
        return 'warning';
    return agent.status === 'calisiyor' ? 'working' : 'idle';
}
// Use an ID-based phase so neighbors do not breathe or type in sync.
export function seatedAnimation(id: string, time: number, working: boolean, reduced: boolean, completedUntil = 0) {
    if (reduced)
        return { frame: 0, breath: false, gesture: 'still' };
    const phase = [...id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0), t = time + phase % 17000;
    const pause = working && Math.floor(t / 14000) % 5 === 4;
    return { frame: working && !pause ? Math.floor(t / 380) % 3 : 0, breath: Math.floor(t / 1700) % 2 === 1, gesture: time < completedUntil ? 'done' : pause ? 'think' : working ? 'type' : Math.floor(t / 9000) % 3 === 1 ? 'look' : 'breathe' };
}
