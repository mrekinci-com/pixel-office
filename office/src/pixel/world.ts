import { t as tx } from "../i18n";
import type { Agent, Department } from "../../shared/types";
import { CHAIR_DESK_GAP, SEATED_RISE, deskFrontEdge } from "./seating";
import { CHARACTER_WIDTH, CHARACTER_HEIGHT, CHARACTER_X, CHARACTER_Y } from "./characterGeometry";
import type { Direction } from "./sprites";
export const TILE = 16;
export const TOP_WALL_HEIGHT = 192;
export type Point = {
    x: number;
    y: number;
};
export type Bounds = Point & {
    w: number;
    h: number;
    bubble?: boolean;
};
export const overlaps = (a: Bounds, b: Bounds) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
export const actorBounds = (p: Point): Bounds => ({ x: Math.round(p.x * TILE) - CHARACTER_X, y: Math.round(p.y * TILE) - CHARACTER_Y, w: CHARACTER_WIDTH, h: CHARACTER_HEIGHT });
export const furnitureBounds = (f: Furniture): Bounds => ({ x: f.x * TILE, y: f.y * TILE - (f.kind === "desk" ? 44 : f.kind === "executive" ? 48 : 0), w: f.w * TILE, h: f.h * TILE + (f.kind === "desk" ? 44 : f.kind === "executive" ? 48 : 0) });
export const chairPosition = (chair: Furniture): Point => ({ x: chair.x + .5, y: chair.y + (CHARACTER_Y - SEATED_RISE) / TILE });
export type FurnitureKind = "desk" | "chair" | "executive" | "painting" | "shelf" | "plant" | "water" | "cabinet" | "printer" | "sofa" | "coffee" | "meeting" | "reception" | "door" | "board";
export interface Furniture {
    id: string;
    kind: FurnitureKind;
    x: number;
    y: number;
    w: number;
    h: number;
    agentId?: string;
    seatAgentIds?: (string | undefined)[];
    islandId?: string;
    anchorId?: string;
    variant?: number;
    direction?: Direction;
    wallMounted?: boolean;
}
export interface Wall {
    x: number;
    y: number;
    w: number;
    h: number;
}
export interface Room {
    department: Department;
    x: number;
    y: number;
    w: number;
    h: number;
}
export interface SceneSign extends Bounds {
    text: string;
}
export type Seat = {
    id: string;
    point: Point;
    approach: Point;
    direction: Direction;
    chairId: string;
    tableId?: string;
    screenIndex?: number;
    agentId?: string;
    kind: "desk" | "meeting" | "director" | "guest" | "sofa";
    layers: readonly [
        "chair-seat",
        "character",
        "chair-back"
    ];
};
export type Desk = {
    agentId: string;
    x: number;
    y: number;
    seat: Point;
    islandId: string;
    seatIndex: number;
    seatId: string;
};
export type RestPoint = {
    id: string;
    name: string;
    point: Point;
    seat?: Point;
    furnitureId?: string;
    agentId?: string;
    breakSpot?: boolean;
    direction?: Direction;
    seatId?: string;
};
export type OfficeLayout = "wide" | "balanced";
export interface World {
    layout: OfficeLayout;
    cols: number;
    rows: number;
    bottom: number;
    rooms: Room[];
    desks: Desk[];
    furniture: Furniture[];
    walls: Wall[];
    signs: SceneSign[];
    rugs: (Bounds & {
        color?: string;
    })[];
    wallPanels: Bounds[];
    blocked: Set<string>;
    lounge: Point;
    meeting: Point;
    stops: Point[];
    rests: RestPoint[];
    seats: Seat[];
    doors: Point[];
}
export const cellKey = (x: number, y: number) => `${x},${y}`;
export const positionSeed = (x: number, y: number) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0;
export function depthSort<T extends {
    depth: number;
    id: string;
}>(objects: T[]): T[] { return [...objects].sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id)); }
export function ownSeatFurniture(world: World, id: string, f: Furniture) { return (f.kind === "chair" && f.agentId === id) || world.desks.some(d => d.agentId === id && d.islandId === f.id); }
export function chairUnderOwnDesk(a: Furniture, b: Furniture) { return a.islandId === b.id || b.islandId === a.id || a.anchorId === b.id || b.anchorId === a.id; }
export function actorVisual(agent: Agent, position: Point, moving: boolean, world: World) {
    const desk = world.desks.find(d => d.agentId === agent.id), seat = world.seats.find(s => s.id === desk?.seatId);
    const seated = Boolean(seat && agent.status !== "kapali" && !moving && position.x === seat.approach.x && position.y === seat.approach.y);
    return { point: seated ? seat!.point : position, seated, chair: seated ? world.furniture.find(f => f.id === seat!.chairId) : undefined, direction: seat?.direction || "up" as Direction, seat: seated ? seat : undefined };
}
export function emptyChairs(world: World, occupied: ReadonlySet<string>) { return world.furniture.filter(f => f.kind === "chair" && !occupied.has(f.id)); }
// Two hand-drawn layouts share desk, chair and furniture IDs.
export const OFFICE_MAPS = {
    wide: { cols: 226, rows: 114, bottom: 82, columns: [9, 46, 83, 120, 157, 194], rowOrigins: [26, 58], partitions: [47, 79], doorCenters: [24, 63, 152], meetingCenter: 152 },
    balanced: { cols: 152, rows: 132, bottom: 100, columns: [8, 46, 84, 122], rowOrigins: [26, 53, 80], partitions: [43, 69], doorCenters: [22, 56, 110], meetingCenter: 110 },
} as const;
export const OFFICE_MAP = OFFICE_MAPS.wide;
// Small measurement changes near 1.60 do not switch layouts.
export function selectOfficeLayout(aspect: number, previous?: OfficeLayout, mobile = false): OfficeLayout {
    if (mobile) return "balanced";
    if (previous === "wide") return aspect < 1.52 ? "balanced" : "wide";
    if (previous === "balanced") return aspect > 1.68 ? "wide" : "balanced";
    return aspect >= 1.60 ? "wide" : "balanced";
}
export const DEPARTMENT_DESK_OFFSET = 13;
export function makeWorld(departments: Department[], agents: Agent[], layoutOrAspect: OfficeLayout | number = "wide", _labelHeight = 2.7): World {
    const layout = typeof layoutOrAspect === "string" ? layoutOrAspect : selectOfficeLayout(layoutOrAspect);
    const map = OFFICE_MAPS[layout], columnCount = map.columns.length;
    const groups: {
        department?: Department;
        agents: Agent[];
    }[] = [];
    const ordered = [...departments].sort((a, b) => a.sort_order - b.sort_order);
    // Start a new island at department boundaries; do not share spare paired seats.
    for (const department of [...ordered, undefined]) {
        const members=agents.filter(a=>department ? a.department_id===department.id : !ordered.some(d=>d.id===a.department_id));
        for(let i=0;i<members.length;i+=2)groups.push({department,agents:members.slice(i,i+2)});
    }
    const rowStep = map.rowOrigins[1] - map.rowOrigins[0];
    // Use a multiple of both 4 and 6 columns so added rows keep the same seat set.
    const islandCount = Math.max(12, Math.ceil(groups.length / 12) * 12);
    const extraRows = islandCount / columnCount - map.rowOrigins.length, bottom = map.bottom + extraRows * rowStep, rows = map.rows + extraRows * rowStep;
    const furniture: Furniture[] = [], seats: Seat[] = [], desks: Desk[] = [], rooms: Room[] = [], rugs: World['rugs'] = [], walls: Wall[] = [], signs: SceneSign[] = [], rests: RestPoint[] = [];
    const add = (id: string, kind: FurnitureKind, x: number, y: number, w: number, h: number, more: Partial<Furniture> = {}) => { const f = { id, kind, x, y, w, h, variant: 0, ...more }; furniture.push(f); return f; };
    const seat = (id: string, chair: Furniture, approach: Point, direction: Direction, kind: Seat['kind'], tableId?: string, agentId?: string, screenIndex?: number) => {
        chair.direction = direction;
        const s: Seat = { id, point: chairPosition(chair), approach, direction, kind, chairId: chair.id, tableId, agentId, screenIndex, layers: ["chair-seat", "character", "chair-back"] };
        seats.push(s);
        return s;
    };
    for (let i = 0; i < islandCount; i++) {
        const x = map.columns[i % columnCount], y = map.rowOrigins[0] + Math.floor(i / columnCount) * rowStep, group = groups[i];
        const table = add(`island-${i}`, "desk", x, y, 22, 6, { seatAgentIds: [group?.agents[0]?.id, group?.agents[1]?.id] });
        if (group?.department) {
            rooms.push({ department: group.department, x, y: y - DEPARTMENT_DESK_OFFSET, w: 22, h: 2.7 });
            rugs.push({ x: (x - 1) * TILE, y: (y - 1) * TILE, w: 24 * TILE, h: 14 * TILE, color: group.department.color });
        }
        for (let j = 0; j < 2; j++) {
            const a = group?.agents[j], cx = x + 4.5 + j * 11;
            const chair = add(`island-${i}-chair-${j}`, "chair", cx, (deskFrontEdge(table) + CHAIR_DESK_GAP) / TILE, 2, 3, { agentId: a?.id, islandId: table.id, variant: 0 });
            // Depart through the side aisle without crossing the lower-row sign at narrow scales.
            const s = seat(`desk-${i}-${j}`, chair, { x: j ? x + 25 : x - 4, y: y + 10 }, "up", "desk", table.id, a?.id, j);
            if (a)
                desks.push({ agentId: a.id, x: s.approach.x - 1, y: s.approach.y - 1, seat: s.point, islandId: table.id, seatIndex: j, seatId: s.id });
        }
    }
    // Continuous partitions; each room has just one upper doorway.
    for (const [i, left] of [1, ...map.partitions].entries()) {
        const right = [...map.partitions, map.cols - 1][i], door = map.doorCenters[i];
        // Leave passages on both sides for the centered sign and enlarged body.
        const halfDoor = i === 1 ? 8 : 12;
        walls.push({ x: left, y: bottom, w: door - halfDoor - left, h: 1 }, { x: door + halfDoor, y: bottom, w: right - door - halfDoor, h: 1 });
    }
    for (const x of map.partitions)
        walls.push({ x, y: bottom, w: 1, h: rows - bottom - 1 });
    const [directorCenter, entranceCenter, meetingCenter] = map.doorCenters;
    for (const [text, center, width] of [[tx("GENEL MÜDÜR"), directorCenter, 14], [tx("GİRİŞ"), entranceCenter, 6], [tx("TOPLANTI"), meetingCenter, 14]] as const)
        signs.push({ text, x: (center-width/2)*TILE, y: bottom*TILE-16, w: width*TILE, h: 30 });
    // Balanced corners; the printer group sits on the center axis between islands.
    add("work-plant", "plant", 2, 13, 3, 5, { variant: 3 });
    add("work-plant-right", "plant", map.cols-5, 13, 3, 5, { variant: 3 });
    for (const [suffix, center] of [["", directorCenter-19.375], ["-right", directorCenter+19.375]] as const)
        add(`director-library${suffix}`, "shelf", center-1.5, bottom+2, 3, 7);
    add("director-picture", "painting", directorCenter-2.5, bottom+1, 5, 3, { wallMounted: true });
    const directorDesk = add("director-desk", "executive", directorCenter-13, bottom+12, 26, 6);
    const directorChair = add("director-chair", "chair", directorCenter-1, directorDesk.y-1, 2, 3, { anchorId: directorDesk.id });
    seat("director", directorChair, { x: map.partitions[0]-3, y: bottom+18 }, "down", "director", directorDesk.id);
    for (const [j, cx] of [directorCenter-6.5, directorCenter+4.5].entries()) {
        const ch = add(`guest-${j}`, "chair", cx, directorDesk.y+directorDesk.h-18/TILE, 2, 3, { anchorId: directorDesk.id });
        seat(`guest-seat-${j}`, ch, { x: Math.round(cx+1), y: bottom+27 }, "up", "guest", directorDesk.id);
    }
    add("water", "water", entranceCenter-10, bottom+4, 2, 6);
    add("entrance-plant", "plant", entranceCenter+7.5, bottom+4.5, 3, 5, { variant: 2 });
    const reception = add("reception", "reception", entranceCenter-7, bottom+13, 14, 8);
    signs.push({ text: tx("PİKSEL OFİS"), x: (entranceCenter-6.5)*TILE, y: (reception.y+5)*TILE, w: 13*TILE, h: 30 });
    add("entrance-door", "door", entranceCenter-3.5, rows-7, 7, 6);
    rests.push({ id: "water-break", name: tx("Su sebili"), point: { x: entranceCenter-6, y: bottom+11 }, breakSpot: true, direction: "left" },
        { id: "reception-break", name: tx("Banko önü"), point: { x: entranceCenter, y: bottom+12 }, breakSpot: true, direction: "down" });
    // Opposing sides of the long table; end seats face inward.
    const capacity = agents.length <= 14 ? 12 : Math.min(24, Math.ceil(agents.length/2)*2), perSide = (capacity - 2) / 2, tableWidth = 42 + (perSide-5)*4, tableLeft = map.meetingCenter-tableWidth/2;
    const meetingTable = add("meeting-table", "meeting", tableLeft, bottom + 13, tableWidth, 9);
    // Omit the small freestanding presentation board to keep the upper door clear.
    for (let j = 0; j < perSide; j++)
        for (const side of [0, 1]) {
            // Place the upper chair one tile behind the table edge; otherwise the body
            // of the opposite occupant overlaps it by six pixels.
            const cx = tableLeft + 4 + j * ((tableWidth-10) / (perSide-1)), cy = bottom + (side ? 20 : 12), direction = side ? "up" : "down";
            const ch = add(`meeting-chair-${side}-${j}`, "chair", cx, cy, 2, 3, { islandId: meetingTable.id });
            const s = seat(`meeting-${side}-${j}`, ch, { x: Math.round(cx + 1), y: bottom + (side ? 30 : 11) }, direction, "meeting", meetingTable.id);
            rests.push({ id: s.id, name: tx("Toplantı"), point: s.approach, seat: s.point, furnitureId: meetingTable.id, direction, seatId: s.id });
        }
    for (const [j, cx, dir] of [[0, tableLeft-7, "right"], [1, tableLeft+tableWidth+5, "left"]] as const) {
        const ch = add(`meeting-head-${j}`, "chair", cx, bottom + 17, 2, 3, { islandId: meetingTable.id });
        const s = seat(`meeting-head-seat-${j}`, ch, { x: Math.round(j ? Math.min(map.cols-4,tableLeft+tableWidth+6) : Math.max(map.partitions[1]+4,tableLeft-11)), y: bottom + 30 }, dir, "meeting", meetingTable.id);
        rests.push({ id: s.id, name: tx("Toplantı"), point: s.approach, seat: s.point, furnitureId: meetingTable.id, direction: dir, seatId: s.id });
    }
    // Keep signs, the two-line bubble strip and all monitors out of the aisle.
    const plaqueStrips = rooms.map(r => ({ x: r.x * TILE, y: (r.y + DEPARTMENT_DESK_OFFSET - 18) * TILE, w: r.w * TILE, h: 18 * TILE }));
    const obstacles = [...furniture.map(furnitureBounds), ...walls.map(w => ({ x: w.x * TILE, y: w.y * TILE - 14, w: w.w * TILE, h: w.h * TILE + 18 })), ...plaqueStrips, ...signs.filter(s => s.text !== tx("PİKSEL OFİS")), { x: 0, y: 0, w: map.cols * TILE, h: TOP_WALL_HEIGHT }, { x: 0, y: 0, w: 16, h: rows * TILE }, { x: (map.cols - 1) * TILE, y: 0, w: 16, h: rows * TILE }, { x: 0, y: (rows - 1) * TILE, w: map.cols * TILE, h: 16 }];
    const blocked = new Set<string>();
    for (let y = 0; y < rows; y++)
        for (let x = 0; x < map.cols; x++)
            if (obstacles.some(o => overlaps(actorBounds({ x, y }), o)))
                blocked.add(cellKey(x, y));
    const lounge = rests[0].point, meeting = rests.find(r => r.name === tx("Toplantı"))!.point;
    return { layout, cols: map.cols, rows, bottom, rooms, desks, furniture, walls, signs, rugs, wallPanels: [], blocked, lounge, meeting, stops: [...seats.filter(s => s.kind === "desk").map(s => s.approach), ...rests.map(r => r.point)], rests, seats, doors: map.doorCenters.map(x => ({ x, y: bottom + 7 })) };
}
// A*: four neighbors, no corner cutting. Reservations use the same closed grid.
export function pathfind(start: Point, end: Point, world: World): Point[] {
    const origin={x:Math.round(start.x),y:Math.round(start.y)},goal={x:Math.round(end.x),y:Math.round(end.y)};
    const first=cellKey(origin.x,origin.y),last=cellKey(goal.x,goal.y);
    if(first===last || world.blocked.has(last))return [];
    type Node={key:string;point:Point;score:number;order:number};
    const heap:Node[]=[],cost=new Map([[first,0]]),parents=new Map<string,string>(),closed=new Set<string>();
    let order=0;
    const before=(a:Node,b:Node)=>a.score<b.score || (a.score===b.score&&a.order<b.order);
    const push=(point:Point,g:number)=>{
        const node={key:cellKey(point.x,point.y),point,score:g+Math.abs(point.x-goal.x)+Math.abs(point.y-goal.y),order:order++};
        heap.push(node);let i=heap.length-1;
        while(i>0){const p=Math.floor((i-1)/2);if(!before(heap[i],heap[p]))break;[heap[i],heap[p]]=[heap[p],heap[i]];i=p;}
    };
    const pop=()=>{
        const result=heap[0],tail=heap.pop()!;
        if(heap.length){heap[0]=tail;let i=0;while(true){const left=i*2+1,right=left+1;let next=i;if(left<heap.length&&before(heap[left],heap[next]))next=left;if(right<heap.length&&before(heap[right],heap[next]))next=right;if(next===i)break;[heap[i],heap[next]]=[heap[next],heap[i]];i=next;}}
        return result;
    };
    push(origin,0);
    while(heap.length){
        const node=pop();if(closed.has(node.key))continue;closed.add(node.key);
        if(node.key===last){const path:Point[]=[];let key=last;while(key!==first){const [x,y]=key.split(',').map(Number);path.unshift({x,y});key=parents.get(key)!;}return path;}
        const p=node.point,g=cost.get(node.key)!+1;
        for(const next of [{x:p.x-1,y:p.y},{x:p.x+1,y:p.y},{x:p.x,y:p.y-1},{x:p.x,y:p.y+1}]){
            const key=cellKey(next.x,next.y);
            if(next.x<1||next.y<7||next.x>=world.cols-1||next.y>=world.rows-1||world.blocked.has(key)||closed.has(key)||g>=(cost.get(key)??Infinity))continue;
            cost.set(key,g);parents.set(key,node.key);push(next,g);
        }
    }
    return [];
}
