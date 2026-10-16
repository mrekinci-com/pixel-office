import { t as tx, locale, useLanguage } from "../i18n";
import {
  useEffect,
  useRef,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import type {
  Agent,
  Department,
  Message,
  OfficeEvent,
} from "../../shared/types";
import { statusLabels } from "../../shared/types";
import {
  makeWorld,
  selectOfficeLayout,
  type OfficeLayout,
  TILE,
  DEPARTMENT_DESK_OFFSET,
  depthSort,
  actorBounds,
  overlaps,
  furnitureBounds,
  type Bounds,
  type Point,
  type Room,
} from "./world";
import { person, rect, type Direction } from "./sprites";
import {
  background,
  FLOOR_PALETTES,
  drawFurniture,
  directorMonitorBox,
  drawChairSeat,
  drawChairBack,
  drawWall,
  clock,
} from "./furniture";
import { loadArt } from "./atlas";
import { bubbleText } from "./bubbleText";
import { placeBubble, placeBubbleFallback } from "./annotations";
import { CHARACTER_SCALE, CHARACTER_WIDTH, CHARACTER_HEIGHT, CHARACTER_X, CHARACTER_Y } from "./characterGeometry";
import { placeNames, type NameAnchor } from "./nameLabels";
import { createMotion, remapMotion, type Motion, stepMotion, converse, meetChain, motionVisual, type MotionActor, type MovementMode, callMeeting, monitorState, seatedAnimation } from "./motion";
import "./office.css";

// Use one bubble strip per row; a second height is the last resort in narrow spaces.
const compactDeskBubbles = (scale: number) => scale < .65;
function departmentPlaqueBox(room: Room, scale: number): Bounds {
  const h = Math.ceil(Math.max(room.h*TILE, 12/scale*1.25+10));
  const monitorTop = (room.y+DEPARTMENT_DESK_OFFSET)*TILE-42;
  const bubbleStrip = compactDeskBubbles(scale) ? 38 : 50;
  return {x:room.x*TILE, y:monitorTop-bubbleStrip/scale-h, w:room.w*TILE, h};
}
export function Avatar({
  appearance,
  size = 44,
}: {
  appearance: Agent["appearance"];
  size?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let alive = true;
    void loadArt()
      .then(() => {
        if (!alive || !ref.current) return;
        const ctx = ref.current.getContext("2d")!;
        ctx.clearRect(0, 0, 32, 48);
        ctx.imageSmoothingEnabled = false;
        person(ctx, appearance, 0, 0);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [appearance]);
  return (
    <canvas
      ref={ref}
      width={32}
      height={48}
      style={{
        width: Math.floor((size * 2) / 3),
        height: size,
        imageRendering: "pixelated",
      }}
      aria-hidden="true"
    />
  );
}

type Walker = MotionActor & { bubble: string; bubbleUntil: number };
export function OfficeCanvas({
  departments,
  agents: allAgents,
  directorAuto=false,
  directorTerminalEnabled=true,
  directorQuestions=0,
  messages,
  events,
  selected,
  onSelect,
  onDepartment,
  queuedAgents = [],
  scheduledAgents = [],
  showNames = true,
  movement = "sakin",
  workChains = [],
}: {
  directorAuto?:boolean;
  directorTerminalEnabled?:boolean;
  directorQuestions?:number;
  showNames?: boolean;
  movement?: MovementMode;
  workChains?: {id:string;agents:string[]}[];
  queuedAgents?: string[];
  scheduledAgents?: string[];
  departments: Department[];
  agents: Agent[];
  messages: Message[];
  events: OfficeEvent[];
  selected: string | null;
  onSelect: (id: string) => void;
  onDepartment: (id: string) => void;
}) {
  const language=useLanguage();
  const manager=allAgents.find(a=>a.builtin==='director');
  const agents=allAgents.filter(a=>a.builtin!=='director');
  const [artReady, setArtReady] = useState(false);
  const [artError, setArtError] = useState("");
  const [hovered, setHovered] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void loadArt()
      .then(() => {
        if (alive) setArtReady(true);
      })
      .catch(() => {
        if (alive)
          setArtError(tx("Ofis görselleri yüklenemedi. Sayfayı yenileyin."));
      });
    return () => {
      alive = false;
    };
  }, []);
  const canvas = useRef<HTMLCanvasElement>(null),
    viewport = useRef<HTMLDivElement>(null),
    actors = useRef<HTMLDivElement>(null);
  const walkers = useRef(new Map<string, Walker>()),
    latest = useRef({ agents, messages, events, selected, hovered, onSelect, queuedAgents, scheduledAgents, showNames, movement, workChains,manager,directorAuto,directorQuestions });
  latest.current = { agents, messages, events, selected, hovered, onSelect, queuedAgents, scheduledAgents, showNames, movement, workChains,manager,directorAuto,directorQuestions };
  const signature =
    departments
      .map((d) => `${d.id}:${d.name}:${d.color}:${d.sort_order}`)
      .join("|") +
    agents
      .map((a) => `${a.id}:${a.department_id}:${a.desk_x}:${a.desk_y}`)
      .join("|");
  const [viewSize, setViewSize] = useState({
    width: 0,
    height: 0,
    mobile: false,
  });
  useEffect(() => {
    const v = viewport.current!;
    const measure = () => {
      const size = {
        width: v.clientWidth,
        height: v.clientHeight,
        mobile: matchMedia("(max-width: 900px)").matches,
      };
      setViewSize((old) =>
        old.width === size.width &&
        old.height === size.height &&
        old.mobile === size.mobile
          ? old
          : size,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(v);
    measure();
    return () => observer.disconnect();
  }, []);
  const [layout, setLayout] = useState<OfficeLayout>();
  useEffect(() => {
    if (viewSize.width && viewSize.height)
      setLayout(old => selectOfficeLayout(viewSize.width / viewSize.height, old, viewSize.mobile));
  }, [viewSize]);
  const world = useMemo(() => makeWorld(departments, agents, layout || "balanced"), [signature, layout, language]);
  const savedMotion = useRef<{ world: typeof world; motion: Motion } | null>(null);
  const [menuSlot,setMenuSlot]=useState<HTMLElement|null>(null);
  const meetingRequest=useRef(0);
  useEffect(()=>{
    const refresh=()=>setMenuSlot(viewport.current?.closest(".office-scene")?.querySelector<HTMLElement>("#office-actions")||null);
    const observer=new MutationObserver(refresh);observer.observe(viewport.current!.closest(".office-scene")!,{childList:true,subtree:true});refresh();return ()=>observer.disconnect();
  },[]);
  const width = world.cols * TILE,
    height = world.rows * TILE;
  const [camera, setCamera] = useState({ x: 0, y: 0, scale: 1 });
  const fitting = useRef(true);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const revealSelected = (c: typeof camera, id=latest.current.selected) => {
    if (!id) return c;
    const desk = world.desks.find((d) => d.agentId === id);
    const walker = walkers.current.get(id), agent = latest.current.agents.find(a => a.id === id);
    const p = id==="director" ? world.seats.find(s=>s.kind==="director")!.point : walker && agent
      ? motionVisual(world,agent,walker).point
      : desk ? desk.seat : null;
    if (!p) return c;
    const v = viewport.current!,
      box = v.getBoundingClientRect();
    const panel = v.parentElement
      ?.querySelector(".floating-chat")
      ?.getBoundingClientRect();
    const x = (p.x * TILE + 6) * c.scale + c.x,
      y = p.y * TILE * c.scale + c.y;
    const behindChat =
      panel &&
      x > panel.left - box.left - 20 &&
      x < panel.right - box.left + 20 &&
      y > panel.top - box.top - 35;
    if (
      x >= 45 &&
      x <= v.clientWidth - 45 &&
      y >= 60 &&
      y <= v.clientHeight - 60 &&
      !behindChat
    )
      return c;
    let centerX = v.clientWidth / 2,
      centerY = v.clientHeight / 2;
    if (panel) {
      if (panel.width > v.clientWidth * 0.8)
        centerY = Math.max(60, (panel.top - box.top) / 2);
      else centerX = panel.left - box.left < v.clientWidth / 2
        ? Math.min(v.clientWidth - 45, (panel.right - box.left + v.clientWidth) / 2)
        : Math.max(45, (panel.left - box.left) / 2);
    }
    return {
      ...c,
      x: Math.round(centerX - (p.x * TILE + 6) * c.scale),
      y: Math.round(centerY - p.y * TILE * c.scale),
    };
  };
  const fit = () => {
    const v = viewport.current!;
    if (!v.clientWidth || !v.clientHeight) return;
    const scale = Math.max(viewSize.mobile ? 0.3 : 0.1, Math.min(4, v.clientWidth / width, v.clientHeight / height));
    fitting.current = true;
    setCamera({
      scale,
      x: viewSize.mobile && width*scale>v.clientWidth ? 0 : (v.clientWidth-width*scale)/2,
      y: viewSize.mobile && height*scale>v.clientHeight ? 0 : (v.clientHeight-height*scale)/2,
    });
  };
  useEffect(() => {
    if(fitting.current)fit();
  }, [world,viewSize.width,viewSize.height,viewSize.mobile]);
  const zoom = (delta: number, cx?: number, cy?: number) => {
    fitting.current = false;
    setCamera((old) => {
      const v = viewport.current!,
        scale = Math.max(0.1, Math.min(5, old.scale + delta)),
        x = cx ?? v.clientWidth / 2,
        y = cy ?? v.clientHeight / 2;
      return {
        scale,
        x: Math.round(x - ((x - old.x) * scale) / old.scale),
        y: Math.round(y - ((y - old.y) * scale) / old.scale),
      };
    });
  };
  useEffect(() => {
    if (
      !fitting.current ||
      viewport.current?.parentElement?.closest(".office-expanded")
    )
      setCamera((current) => revealSelected(current));
  }, [selected, world,viewSize.width,viewSize.height]);
  useEffect(() => {
    const v = viewport.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const b = v.getBoundingClientRect();
      zoom(e.deltaY < 0 ? 0.1 : -0.1, e.clientX - b.left, e.clientY - b.top);
    };
    v.addEventListener("wheel", wheel, { passive: false });
    return () => v.removeEventListener("wheel", wheel);
  }, []);
  const pointers = useRef(new Map<number, Point>()),
    gesture = useRef({ x: 0, y: 0, distance: 0, moved: false });
  useEffect(() => {
    if (!artReady) return;
    const c = canvas.current!;
    delete c.dataset.renderedCols;
    delete c.dataset.renderedRows;
    delete c.dataset.renderedAt;
    c.width = width;
    c.height = height;
    const ctx = c.getContext("2d")!;
    const measureCanvas=document.createElement("canvas").getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    const base = document.createElement("canvas");
    base.width = width;
    base.height = height;
    background(base.getContext("2d")!, world);
    let disposed=false;
    let drawnState: typeof latest.current | undefined, drawnCamera: typeof camera | undefined;
    let frame = 0,
      previous = 0,
      rendered = 0,
      visible = true;
    const seenMessages = new Set(latest.current.messages.map((m) => m.id));
    let lastEvent = latest.current.events[0]?.id;

    const reducedQuery = matchMedia("(prefers-reduced-motion: reduce)");
    const labelHeight = () => 21 / cameraRef.current.scale;
    const nameWidths = () => {
      measureCanvas.font = `12px ${getComputedStyle(viewport.current!).getPropertyValue('--f-body')}`;
      return Object.fromEntries(latest.current.agents.map(a=>[a.id,Math.min(140,Math.ceil(measureCanvas.measureText(a.name).width)+21)]));
    };
    const initialScale = fitting.current ? Math.min(4, viewport.current!.clientWidth / width, viewport.current!.clientHeight / height) : cameraRef.current.scale;
    let motion = savedMotion.current
      ? remapMotion(savedMotion.current.motion, savedMotion.current.world, world, latest.current.agents, 21 / initialScale)
      : createMotion(world, latest.current.agents, 17, 21 / initialScale, nameWidths());
    const bubbles = new Map<string, { bubble: string; bubbleUntil: number }>();
    let lastMeetingRequest=meetingRequest.current;
    const seenChains=new Set<string>();
    const visualPosition = (a: Agent, w: Walker) => a.status==="kapali"
      ? {...motionVisual(world,a,w),point:world.desks.find(d=>d.agentId===a.id)!.seat,seated:false}
      : motionVisual(world, a, w);
    const draw = (time: number) => {
      if (disposed || canvas.current!==c || !viewport.current || !actors.current || document.hidden || !visible) return;
      frame = requestAnimationFrame(draw);
      if (time - rendered < 50 && drawnState === latest.current && drawnCamera === cameraRef.current) return;
      drawnState = latest.current; drawnCamera = cameraRef.current;
      rendered = time;
      const dt = Math.min((time - previous) / 1000, 0.1);
      previous = time;
      const still = reducedQuery.matches || latest.current.movement === "durgun";
      const team = latest.current.agents,
        chosen = latest.current.selected;
      motion = stepMotion({...motion,nameWidths:nameWidths()}, world, team, dt * 1000, reducedQuery.matches, labelHeight(), latest.current.movement);
      if(!reducedQuery.matches && latest.current.movement!=="durgun") {
        if(lastMeetingRequest!==meetingRequest.current){motion=callMeeting(motion,world,team,team.map(a=>a.id),30000);lastMeetingRequest=meetingRequest.current;}
        for(const chain of latest.current.workChains.filter(c=>c.agents.length>=3))if(!seenChains.has(chain.id)){seenChains.add(chain.id);motion=meetChain(motion,world,team,chain.agents);}
      }
      walkers.current = new Map([...motion.actors].map(([id, actor]) => [id, { ...actor, ...(bubbles.get(id) || { bubble: "", bubbleUntil: 0 }) }]));
      for (const m of latest.current.messages)
        if (!seenMessages.has(m.id)) {
          seenMessages.add(m.id);
          const receiver = team.find((a) => a.id === m.recipient_id),
            sender = team.find((a) => a.id === m.sender_agent_id);
          const recipients = team.filter(
            (a) =>
              a.id === sender?.id ||
              a.id === receiver?.id ||
              m.recipient_type === "everyone" ||
              (m.recipient_type === "department" &&
                m.recipient_id === a.department_id),
          );
          recipients.forEach((a) => {
            const w = walkers.current.get(a.id)!;
            w.bubble = m.text;
            w.bubbleUntil = time + 5500;
          });
          const mentioned=team.filter(a=>m.sender_type==="user" && m.text.includes(`@${a.name}`));
          if(mentioned.length>=2&&!reducedQuery.matches)motion=meetChain(motion,world,team,mentioned.map(a=>a.id));
          if (sender && receiver) {
            if (!reducedQuery.matches) {
              const chain=latest.current.workChains.find(c=>c.agents.includes(sender.id) && c.agents.includes(receiver.id));
              motion = chain && chain.agents.length>=3 ? meetChain(motion,world,team,chain.agents,labelHeight()) : converse(motion, world, team, sender.id, receiver.id, labelHeight());
            }
          }
        }
      const event = latest.current.events[0];
      if (event && event.id !== lastEvent) {
        lastEvent = event.id;
        const w = walkers.current.get(event.agent_id || "");
        if (w && event.kind === "agent_event") {
          w.bubble = event.text;
          w.bubbleUntil = time + 5000;
        }
      }
      for (const [id, w] of walkers.current) bubbles.set(id, {bubble:w.bubble,bubbleUntil:w.bubbleUntil});
      savedMotion.current = { world, motion };
      ctx.drawImage(base, 0, 0);
      const occupied = new Set(
        team.flatMap((a) => {
          const chair = visualPosition(a, walkers.current.get(a.id)!).chair;
          return chair ? [chair.id] : [];
        }),
      );
      occupied.add("director-chair");
      const visibleFurniture = world.furniture.filter(f=>!occupied.has(f.id)&&!f.wallMounted);
      c.dataset.emptyChairIds = JSON.stringify(
        visibleFurniture.filter((f) => f.kind === "chair").map((f) => f.id),
      );
      const objects = [
        ...visibleFurniture.map((f) => ({
          id: f.id,
          depth: f.kind==="chair" && f.direction==="down" && f.islandId
            ? (world.furniture.find(t=>t.id===f.islandId)!.y+world.furniture.find(t=>t.id===f.islandId)!.h)*TILE+1
            : f.y*TILE+(f.kind==="desk"||f.kind==="executive"?24:f.h*TILE),
          draw: () =>
            drawFurniture(
              ctx,
              f,
              time,
              (f.kind==='executive' ? [latest.current.manager?.status==='calisiyor' ? 'working' : latest.current.directorQuestions ? 'waiting' : 'idle'] : (f.seatAgentIds || []).map(
                (id) => monitorState(world,team.find(a=>a.id===id),motion.actors.get(id||"")),
              )),
            ),
        })),
        ...world.walls.map((w, i) => ({
          id: `wall-${i}`,
          depth: (w.y + w.h) * TILE + 2,
          draw: () => drawWall(ctx, w),
        })),
        ...team.filter(a=>a.status!=="kapali").map((a) => {
          const w = walkers.current.get(a.id)!,
            visual = visualPosition(a, w),
            x = Math.round(visual.point.x * TILE) - CHARACTER_X,
            y = Math.round(visual.point.y * TILE) - CHARACTER_Y;
          return {
            id: a.id,
            depth: visual.seated && visual.seat?.kind==="meeting"
              ? (world.furniture.find(f=>f.id===visual.seat!.tableId)!.y+world.furniture.find(f=>f.id===visual.seat!.tableId)!.h)*TILE+2
              : visual.seated && visual.rest?.furnitureId
                ? Math.max(y+CHARACTER_HEIGHT,(world.furniture.find(f=>f.id===visual.rest!.furnitureId)!.y+world.furniture.find(f=>f.id===visual.rest!.furnitureId)!.h)*TILE+2)
                : y+CHARACTER_HEIGHT,
            draw: () => {
              if(a.status === "kapali") return;
              if (chosen === a.id) {
                const floor = y + CHARACTER_HEIGHT - 48;
                rect(ctx, "#e8cf5f", x - 3, floor + 45, CHARACTER_WIDTH + 6, 5);
                rect(ctx, "#fff4b5", x - 1, floor + 44, CHARACTER_WIDTH + 2, 2);
                rect(ctx, "#ddb149", x - 4, floor + 46, 2, 2);
                rect(ctx, "#ddb149", x + CHARACTER_WIDTH + 2, floor + 46, 2, 2);
              }
              if (visual.chair) drawChairSeat(ctx, visual.chair, time);
              if(visual.chair && visual.direction!=="up") drawChairBack(ctx,visual.chair);
              const animation=seatedAnimation(a.id,time,a.status==="calisiyor",still,w.completedUntil);
              const participants=team.filter(a=>motion.actors.get(a.id)?.meetingId===w.meetingId && w.meetingId);
              const speaker=participants[Math.floor(motion.time/3500)%Math.max(1,participants.length)];
              const speakerPoint=speaker ? motionVisual(world,speaker,motion.actors.get(speaker.id)!).point : undefined;
              const headDirection:Direction|undefined=!still&&visual.seated
                ? speakerPoint&&speaker?.id!==a.id ? speakerPoint.x>visual.point.x ? "right" : "left"
                : animation.gesture==="look" ? Math.floor(time/9000)%2 ? "left" : "right" : undefined : undefined;
              const hit=actors.current?.querySelector<HTMLElement>(`[data-agent-id="${a.id}"]`);
              if(hit)hit.dataset.headDirection=headDirection||"";
              person(ctx,a.appearance,x,y,w.path.length ? Math.floor(time/170)%3 : animation.frame,1,
                visual.seated ? visual.direction : w.direction,visual.seated,animation.breath,CHARACTER_SCALE,headDirection,animation.gesture);
              if (visual.chair && visual.direction==="up") drawChairBack(ctx, visual.chair);
              if(visual.seated && visual.direction!=="up" && visual.seat?.tableId){
                const table=world.furniture.find(f=>f.id===visual.seat!.tableId)!;
                ctx.save();ctx.beginPath();ctx.rect(table.x*TILE,Math.max(table.y*TILE,y+39*CHARACTER_SCALE),table.w*TILE,table.h*TILE);ctx.clip();drawFurniture(ctx,table,time);ctx.restore();
              }
            },
          };
        }),
      ];
      const director=world.seats.find(s=>s.kind==="director")!,directorChair=world.furniture.find(f=>f.id===director.chairId)!;
      const directorBox=actorBounds(director.point);
      objects.push({id:"director",depth:directorBox.y+CHARACTER_HEIGHT,draw:()=>{
        drawChairSeat(ctx,directorChair,time);drawChairBack(ctx,directorChair);
        person(ctx,latest.current.manager?.appearance || {style:"kisa",skin:"#d6a27c",hair:"#343038",shirt:"#27334b",pants:"#202b40",tie:true,glasses:false,headphones:false},directorBox.x,directorBox.y,0,1,"down",true,false,CHARACTER_SCALE);
        // White shirt collar, dark jacket and burgundy tie.
        if(latest.current.manager?.appearance.tie ?? true){rect(ctx,"#e3e7e7",directorBox.x+14*CHARACTER_SCALE,directorBox.y+25*CHARACTER_SCALE,4*CHARACTER_SCALE,4*CHARACTER_SCALE);rect(ctx,"#8b3940",directorBox.x+15*CHARACTER_SCALE,directorBox.y+27*CHARACTER_SCALE,2*CHARACTER_SCALE,7*CHARACTER_SCALE);}
        const table=world.furniture.find(f=>f.id==="director-desk")!;
        ctx.save();ctx.beginPath();ctx.rect(table.x*TILE,Math.max(table.y*TILE+10,directorBox.y+39*CHARACTER_SCALE),table.w*TILE,table.h*TILE);ctx.clip();drawFurniture(ctx,table,time,[latest.current.manager?.status==='calisiyor' ? 'working' : latest.current.directorQuestions ? 'waiting' : 'idle']);ctx.restore();
      }});
      depthSort(objects).forEach((o) => o.draw());
      world.furniture.filter(f=>f.wallMounted).forEach(f=>drawFurniture(ctx,f,time));
      c.dataset.monitors=JSON.stringify(world.furniture.filter(f=>f.kind==="desk").flatMap(f=>(f.seatAgentIds||[]).map(id=>({id:id||null,state:monitorState(world,team.find(a=>a.id===id),motion.actors.get(id||""))}))));
      c.dataset.renderedCols = String(world.cols);
      c.dataset.renderedRows = String(world.rows);
      c.dataset.renderedAt = String(time);
      const executive=world.furniture.find(f=>f.id==='director-desk')!,screen=directorMonitorBox(executive);
      if(latest.current.directorAuto)rect(ctx,'#67e2a4',screen.x+screen.w-14,screen.y+screen.h-12,7,7);
      if(latest.current.directorQuestions){rect(ctx,'#ffe094',screen.x+screen.w+8,screen.y+8,6,22);rect(ctx,'#ffe094',screen.x+screen.w+8,screen.y+35,6,6);}
      c.dataset.directorStatus=latest.current.manager?.status || 'bosta';c.dataset.directorAuto=String(latest.current.directorAuto);c.dataset.directorQuestions=String(latest.current.directorQuestions);
      clock(ctx, new Date(), world);
      const bubbleObstacles:Bounds[]=[...world.signs,...world.rooms.map(r=>departmentPlaqueBox(r,cameraRef.current.scale)),...world.wallPanels,...world.furniture.filter(f=>f.kind==="desk").flatMap(f=>[0,1].map(i=>({x:(f.x+5.75+i*8.75)*TILE-32,y:f.y*TILE-42,w:64,h:56}))),...team.map(a=>actorBounds(visualPosition(a,walkers.current.get(a.id)!).point))];
      const fixedBubbleObstacles = bubbleObstacles.length;
      const pendingBubbles: { anchor: Bounds; place: (short: boolean) => boolean }[] = [];
      const pendingLabels: NameAnchor[] = [];
      for (const a of team) {
        const w = walkers.current.get(a.id)!,
          visual = visualPosition(a, w),
          x = Math.round(visual.point.x * TILE) - CHARACTER_X,
          y = Math.round(visual.point.y * TILE) - CHARACTER_Y;
        const button = actors.current?.querySelector<HTMLButtonElement>(
          `[data-agent-id="${a.id}"]`,
        );
        if (button) {
          const bx = x, by = y;
          button.style.left = `${bx}px`;
          button.style.top = `${by}px`;
          button.style.width = `${CHARACTER_WIDTH}px`;
          button.style.height = `${CHARACTER_HEIGHT}px`;
          button.dataset.x = String(visual.point.x);
          button.dataset.y = String(visual.point.y);
          button.dataset.walking = String(Boolean(w.path.length));
          button.dataset.seated = String(visual.seated);
          button.dataset.chairId = visual.chair?.id || "";
          button.dataset.restId = visual.rest?.id || "";
          button.dataset.restFurnitureId = visual.rest?.furnitureId || "";
          button.dataset.arrivals = String(w.arrivals);
          button.dataset.retargets = String(w.retargets);
          button.dataset.emptyChair = String(!visual.seated);
          button.dataset.direction = visual.seated ? visual.direction : w.direction;
          button.dataset.passive=String(a.status==="kapali");
          const anim=seatedAnimation(a.id,time,a.status==="calisiyor",still,w.completedUntil);
          button.dataset.gesture=anim.gesture;button.dataset.animationFrame=String(anim.frame);button.dataset.breath=String(anim.breath);
          const cam = cameraRef.current,
            v = viewport.current!,
            scale = cam.scale;
          const label = button.querySelector<HTMLSpanElement>(".agent-label");
          const bubble = button.querySelector<HTMLSpanElement>(".agent-bubble");
          if (label) {
            const focused = chosen === a.id || latest.current.hovered === a.id;
            const show = latest.current.showNames || focused;
            const compactLabel = scale < .36;
            label.style.display = show ? "flex" : "none";
            label.style.fontSize = `${12 / scale}px`;
            label.style.lineHeight = "1.2";
            label.style.padding = `${2 / scale}px ${(compactLabel ? 1 : 4) / scale}px`;
            label.style.borderWidth = `${1 / scale}px`;
            const labelTableId = visual.seat?.kind === "desk" ? visual.seat.tableId
              : a.status === "kapali" ? world.desks.find(d=>d.agentId===a.id)?.islandId : undefined;
            const table = labelTableId ? world.furniture.find(f=>f.id===labelTableId) : undefined;
            // Keep names on their own half-island; show long names in full tooltips.
            label.style.maxWidth = `${table ? Math.min(140/scale,Math.max(24/scale,table.w*TILE/2-(compactLabel ? 1 : 4)/scale)) : 140/scale}px`;
            label.style.gap = `${(compactLabel ? 2 : 4) / scale}px`;
            label.style.visibility = "visible";
            label.style.opacity=a.status==="kapali" ? "0.55" : "1";
            label.style.setProperty("--name-dot-size", `${5 / scale}px`);
            label.style.setProperty("--name-link-width", `${1 / scale}px`);
            if (show) pendingLabels.push({ id: a.id, anchor: actorBounds(visual.point),
              size: { w: label.offsetWidth, h: label.offsetHeight }, priority: chosen === a.id ? 2 : focused ? 1 : 0 });
          }
          if (bubble) {
            const focused = chosen === a.id || latest.current.hovered === a.id;
            const meeting=!!w.meetingId && visual.seated;
            const participants=team.filter(a=>motion.actors.get(a.id)?.meetingId===w.meetingId && w.meetingId);
            const speaking=participants[Math.floor(motion.time/3500)%Math.max(1,participants.length)]?.id===a.id;
            const persistent = meeting ? speaking ? tx("Birlikte değerlendiriyoruz") : "" :
              latest.current.queuedAgents.includes(a.id) ? tx("sırada") : a.status === "bekliyor"
                ? focused ? `? ${a.current_job || tx("Onay bekleniyor")}` : "?"
                : a.status === "calisiyor"
                  ? a.current_job || tx("Çalışıyorum")
                  : "";
            if (persistent) w.bubble = persistent;
            const show =
              !!persistent || (!meeting && focused && time < w.bubbleUntil);
            bubble.textContent = show
              ? w.bubble.slice(0, 85) + (w.bubble.length > 85 ? "…" : "")
              : "";
            bubble.title = show ? w.bubble : "";
            if (show) pendingBubbles.push({anchor:{x:bx,y:by,w:CHARACTER_WIDTH,h:CHARACTER_HEIGHT},place:short => {
              // Compensating for scene zoom keeps text at 12 screen pixels.
              bubble.style.fontSize=`${12/scale}px`;
              const compact=compactDeskBubbles(scale) && visual.seated && visual.seat?.kind==='desk';
              bubble.style.lineHeight='1.2';
              bubble.style.padding=compact?`${1/scale}px ${4/scale}px`:`${4/scale}px ${6/scale}px`;
              bubble.style.borderWidth=`${1/scale}px`;
              bubble.style.maxWidth='none';bubble.style.visibility='visible';
              const clock=latest.current.scheduledAgents.includes(a.id) ? '◷ ' : '';
              measureCanvas.font=`${12/scale}px ${getComputedStyle(bubble).fontFamily}`;
              const left=Math.max(2,-cam.x/scale),top=Math.max(2,-cam.y/scale);
              const anchor={x:bx,y:by,w:CHARACTER_WIDTH,h:CHARACTER_HEIGHT};
              const visibleArea={x:left,y:top,w:Math.min(width-2,(v.clientWidth-cam.x)/scale)-left,h:Math.min(height-2,(v.clientHeight-cam.y)/scale)-top};
              // Keep off-camera bubbles attached to their owners in scene coordinates;
              // do not move them into view and crowd visible bubbles.
              const area=overlaps(anchor,visibleArea) ? visibleArea : {x:2,y:2,w:width-4,h:height-4};
              let position:Bounds|undefined;
              const word=w.bubble.trim().split(/\s+/).find(word=>word.length>0) || tx("Çalışıyorum");
              const widths=short ? [0] : [...(visual.seated && visual.seat?.kind==="desk" ? [120,110,100,90,82,75,68] : [180,150,120,90,68]),0];
              for(const screenWidth of widths) {
                const available=Math.max(48,Math.min(screenWidth,area.w*scale-24));
                const text=screenWidth===0 ? word+"…" : bubbleText(w.bubble,(available-14)/scale,value=>measureCanvas.measureText(value).width);
                bubble.textContent=clock+text;
                bubble.dataset.clock=String(!!clock);
                const table=visual.seated && visual.seat?.kind==="desk" ? world.furniture.find(f=>f.id===visual.seat!.tableId) : undefined;
                if(table) {
                  const size={w:bubble.offsetWidth,h:bubble.offsetHeight},center=bx+CHARACTER_WIDTH/2;
                  const baseY=table.y*TILE-42-(compact?2:5)/scale-size.h;
                  const tableCenter=(table.x+table.w/2)*TILE;
                  const xs=[tableCenter+(visual.seat!.screenIndex===1 ? 2/scale : -size.w-2/scale),center-size.w/2,table.x*TILE+(visual.seat!.screenIndex===1?table.w*TILE-size.w+6/scale:-6/scale)];
                  for(const y of [baseY,baseY-size.h-(compact?1:3)/scale]) {
                    for(const x of xs) {
                      const candidate={x,y,...size};
                      if(x>=area.x && x+size.w<=area.x+area.w && y>=area.y && y+size.h<=area.y+area.h && !bubbleObstacles.some(o=>overlaps(candidate,o))) {position=candidate;break;}
                    }
                    if(position)break;
                  }
                }
                position ||= placeBubble(anchor,{w:bubble.offsetWidth,h:bubble.offsetHeight},area,bubbleObstacles);
                if(position)break;
              }
              position ||= placeBubbleFallback(anchor,{w:bubble.offsetWidth,h:bubble.offsetHeight},area,bubbleObstacles);
              if(!position) return false;
              bubble.style.left=`${position.x-bx}px`;bubble.style.top=`${position.y-by}px`;bubble.style.bottom='auto';bubble.style.transform='none';
              const tipX=Math.max(8/scale,Math.min(position.w-8/scale,bx+CHARACTER_WIDTH/2-position.x));
              bubble.style.setProperty('--bubble-tip-x',`${tipX}px`);
              bubble.style.setProperty('--bubble-tip-size',`${4/scale}px`);
              const tipY=Math.max(8/scale,Math.min(position.h-8/scale,by+CHARACTER_HEIGHT*11/48-position.y));
              bubble.style.setProperty('--bubble-tip-y',`${tipY}px`);
              bubble.dataset.tail=position.y+position.h<=by ? 'down' : position.y>=by+CHARACTER_HEIGHT ? 'up' : position.x<bx ? 'right' : 'left';
              bubbleObstacles.push({...position,bubble:true});
              return true;
            }});
          }
        }
      }
      // Try full text first. If crowded, shorten the nearest preceding bubble too,
      // then place all boxes again without hiding any.
      const shortened = new Set<number>();
      for(let attempt=0;attempt<=pendingBubbles.length;attempt++) {
        bubbleObstacles.length=fixedBubbleObstacles;
        const failed=pendingBubbles.findIndex((request,i)=>!request.place(shortened.has(i)));
        if(failed<0)break;
        const blocked=pendingBubbles[failed];
        const candidates=pendingBubbles.map((request,i)=>({i,distance:Math.hypot(request.anchor.x-blocked.anchor.x,request.anchor.y-blocked.anchor.y)}))
          .filter(({i})=>i<=failed && !shortened.has(i)).sort((a,b)=>a.distance-b.distance);
        if(candidates.length)shortened.add(candidates[0].i);
        else {
          // Place the most constrained box first; neighbors use the remaining space.
          pendingBubbles.unshift(...pendingBubbles.splice(failed,1));
          shortened.clear();
          pendingBubbles.forEach((_,i)=>shortened.add(i));
        }
      }
      for (const placement of placeNames(pendingLabels, 2 / cameraRef.current.scale, team.map(a => actorBounds(visualPosition(a, walkers.current.get(a.id)!).point)))) {
        const button = actors.current!.querySelector<HTMLElement>(`[data-agent-id="${placement.id}"]`)!;
        const label = button.querySelector<HTMLElement>(".agent-label")!;
        label.style.left = `${placement.x - parseFloat(button.style.left)}px`;
        label.style.top = `${placement.y - parseFloat(button.style.top)}px`;
        label.style.bottom = "auto";
        label.style.transform = "none";
        label.style.opacity = placement.dimmed || latest.current.agents.find(a=>a.id===placement.id)?.status==="kapali" ? "0.5" : "1";
        label.style.zIndex = placement.dimmed ? "6" : "7";
        label.dataset.shifted = String(placement.shift > 0);
        label.style.setProperty("--name-link-height", `${placement.shift + 2 / cameraRef.current.scale}px`);
      }
    };
    const start = () => {
      cancelAnimationFrame(frame);
      previous = performance.now();
      if (!document.hidden && visible) frame = requestAnimationFrame(draw);
    };
    const visibility = () => start();
    document.addEventListener("visibilitychange", visibility);
    const observer = new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting;
      start();
    });
    observer.observe(c);
    start();
    return () => {
      disposed=true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [world, artReady]);
  return (
    <div
      ref={viewport}
      className="canvas-scroll office-viewport"
      style={{"--office-scene-floor":FLOOR_PALETTES[0][0]} as CSSProperties}
      data-layout={world.layout}
      data-scale={camera.scale}
      data-label-height={world.rooms[0]?.h || 2.7}
      data-cols={world.cols}
      data-rows={world.rows}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        gesture.current = {
          x: e.clientX,
          y: e.clientY,
          distance: 0,
          moved: false,
        };
      }}
      onPointerMove={(e) => {
        if (!pointers.current.has(e.pointerId)) return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const points = [...pointers.current.values()];
        if (points.length === 2) {
          const d = Math.hypot(
            points[0].x - points[1].x,
            points[0].y - points[1].y,
          );
          if (
            gesture.current.distance &&
            Math.abs(d - gesture.current.distance) > 35
          ) {
            zoom(d > gesture.current.distance ? 1 : -1);
            gesture.current.distance = d;
          } else if (!gesture.current.distance) gesture.current.distance = d;
          return;
        }
        const dx = e.clientX - gesture.current.x,
          dy = e.clientY - gesture.current.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) {
          gesture.current.moved = true;
          fitting.current = false;
          setCamera((old) => ({
            ...old,
            x: Math.round(old.x + dx),
            y: Math.round(old.y + dy),
          }));
          gesture.current.x = e.clientX;
          gesture.current.y = e.clientY;
        }
      }}
      onPointerUp={(e) => pointers.current.delete(e.pointerId)}
      onPointerCancel={(e) => pointers.current.delete(e.pointerId)}
    >
      <div
        className="pixel-stage"
        style={{
          width,
          height,
          transform: `translate(${camera.x}px,${camera.y}px) scale(${camera.scale})`,
        }}
      >
        <canvas
          ref={canvas}
          className="office-canvas"
          role="img"
          aria-label={tx("Piksel ofis. {0} ajan. Ajanlara ve bölüm tabelalarına tıklayarak sohbet açabilirsiniz.", [agents.length])}
        />
        <div ref={actors} className="scene-targets">
          {agents.map((a) => (
            <button
              key={a.id}
              data-agent-id={a.id}
              className="agent-hit"
              aria-label={tx("{0} ile sohbet, {1}", [a.name, tx(statusLabels[a.status])])}
              aria-pressed={selected === a.id}
              title={a.name}
              onMouseEnter={() => setHovered(a.id)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => {setHovered(a.id);setCamera(c=>revealSelected(c,a.id));}}
              onBlur={() => setHovered(null)}
              onClick={() => onSelect(a.id)}
            >
              <span className="agent-label" data-status={a.status}><span className="agent-name-dot" aria-hidden="true" /><span className="agent-name-text">{a.name}{queuedAgents.includes(a.id) ? tx(" · sırada") : ""}</span></span>
              <span className="agent-bubble" aria-hidden="true" />
            </button>
          ))}
        </div>
        {world.furniture.filter(f => f.kind === "executive").map(f => <button key={f.id} className="director-screen" disabled={!directorTerminalEnabled} aria-label={tx("Genel Müdür masası ekranı")} title={directorTerminalEnabled?tx("Genel Müdür — terminali aç"):tx("Terminali açmak için deneme modundan çıkın.")} style={{left:directorMonitorBox(f).x,top:directorMonitorBox(f).y,width:directorMonitorBox(f).w,height:directorMonitorBox(f).h}} onFocus={()=>setCamera(c=>revealSelected(c,"director"))} onClick={() => viewport.current?.dispatchEvent(new CustomEvent("office:director-screen", {bubbles:true,detail:{id:f.id}}))} />)}
        {world.seats.filter(s=>s.kind==="director").map(s=><button key={s.id} className="director-character" disabled={!directorTerminalEnabled} aria-label={tx("Genel Müdür")} title={directorTerminalEnabled?tx("Genel Müdür — terminali aç"):tx("Terminali açmak için deneme modundan çıkın.")} data-agent-id={manager?.id} style={{left:actorBounds(s.point).x,top:actorBounds(s.point).y,width:CHARACTER_WIDTH,height:CHARACTER_HEIGHT}} onClick={()=>viewport.current?.dispatchEvent(new CustomEvent("office:director-screen",{bubbles:true,detail:{id:"director-desk"}}))}></button>)}
        {menuSlot && createPortal(<button disabled={agents.filter(a=>a.status!=="kapali").length>3 || agents.filter(a=>a.status!=="kapali").length<2} title={agents.filter(a=>a.status!=="kapali").length>3 ? tx("Kalabalık ekibin güvenli toplantı hareketi hazırlanıyor.") : undefined} onClick={()=>{meetingRequest.current++;}}>{agents.filter(a=>a.status!=="kapali").length>3 ? tx("Büyük toplantı · yakında") : tx("Toplantıya çağır")}</button>,menuSlot)}
        {world.signs.map((sign) => (
          <span
            key={sign.text}
            className="scene-sign"
            style={{
              left: sign.x,
              top: sign.y,
              width: sign.w,
              height: sign.h,
              fontSize: Math.max(
                10,
                Math.min(
                  sign.h - 6,
                  (sign.w - 8) / (sign.text.length * 0.55),
                  12 / camera.scale,
                ),
              ),
            }}
          >
            {sign.text}
          </span>
        ))}
        {world.rooms.map((room) => (
          <button
            key={`${room.department.id}-${room.x}-${room.y}`}
            className="department-hit"
            aria-label={tx("{0} bölüm sohbeti", [room.department.name])}
            title={room.department.name}
            style={
              {
                left: departmentPlaqueBox(room,camera.scale).x,
                top: departmentPlaqueBox(room,camera.scale).y,
                width: departmentPlaqueBox(room,camera.scale).w,
                height: departmentPlaqueBox(room,camera.scale).h,
                fontSize: Math.max(16, 12 / camera.scale),
                "--department-color": room.department.color,
              } as CSSProperties
            }
            onClick={() => onDepartment(room.department.id)}
          >
            <span className="department-plaque">
              <span className="department-name">{room.department.name}</span>
            </span>
          </button>
        ))}
      </div>
      {!artReady && (
        <div className="art-loading" role="status">
          {artError || tx("Ofis görselleri hazırlanıyor…")}
        </div>
      )}
      <div className="camera-controls" aria-label={tx("Ofis görünümü")}>
        <button
          aria-label={tx("Uzaklaştır")}
          onClick={() => zoom(-0.1)}
          disabled={camera.scale <= 0.1}
        >
          −
        </button>
        <span>{camera.scale.toLocaleString(locale(),{minimumFractionDigits:2,maximumFractionDigits:2})}×</span>
        <button
          aria-label={tx("Yakınlaştır")}
          onClick={() => zoom(0.1)}
          disabled={camera.scale === 5}
        >
          +
        </button>
        <button onClick={fit}>{tx("Sığdır")}</button>
      </div>

    </div>
  );
}
