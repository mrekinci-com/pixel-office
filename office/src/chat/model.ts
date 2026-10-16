import { translate } from "../../shared/i18n/index";
import { t as tx, locale } from "../i18n";
import type { Agent, Message, Snapshot } from "../../shared/types";
export type Recipient = {
  recipient_type: Message["recipient_type"];
  recipient_id: string | null;
};
export function recipientFor(
  target: string,
  data: Pick<Snapshot, "agents" | "departments">,
): Recipient {
  if (target === "everyone")
    return { recipient_type: "everyone", recipient_id: null };
  const separator = target.indexOf(":"),
    type = target.slice(0, separator),
    id = target.slice(separator + 1);
  if (type === "agent" && data.agents.some((a) => a.id === id))
    return { recipient_type: "agent", recipient_id: id };
  if (type === "department" && data.departments.some((d) => d.id === id))
    return { recipient_type: "department", recipient_id: id };
  return { recipient_type: "everyone", recipient_id: null };
}
export function inConversation(m: Message, target: string): boolean {
  if (target === "everyone") return m.recipient_type === "everyone";
  const [type, id] = target.split(":");
  return type === "department"
    ? m.recipient_type === "department" && m.recipient_id === id
    : m.recipient_type === "agent" &&
        (m.recipient_id === id || m.sender_agent_id === id);
}
export function isIncoming(m: Message) {
  return Boolean(m.sender_type === "agent" || m.sender_type === "system" || m.sender_agent_id);
}
export function unreadMessages(messages: Message[], localRead: Set<string>) {
  return messages.filter(
    (m) =>
      isIncoming(m) && !m.read_by?.includes("owner") && !localRead.has(m.id),
  );
}
export function mentionSuggestions(
  text: string,
  caret: number,
  agents: Agent[],
) {
  const match = text.slice(0, caret).match(/@([\p{L}\p{N}_ -]*)$/u);
  if (!match) return [];
  const query = match[1].toLocaleLowerCase(locale());
  if (
    query.endsWith(" ") &&
    agents.some((a) => a.name.toLocaleLowerCase(locale()) === query.trim())
  )
    return [];
  return agents
    .filter((a) => a.name.toLocaleLowerCase(locale()).includes(query))
    .slice(0, 6);
}
export function insertMention(text: string, caret: number, name: string) {
  const at = text.lastIndexOf("@", caret - 1);
  if (at < 0) return text;
  return text.slice(0, at) + `@${name} ` + text.slice(caret);
}

export function messageResponses(message: Message, data: Snapshot): {agent_id:string;text:string;retry:boolean;saveRun?:string;setting?:'usage'|'agents'|'links'}[] {
  const runtime = data.runtime;
  const latest = new Map<string, import('../../shared/runtime').Run | import('../../shared/runtime').MessageRunStatus>();
  for (const run of [...(runtime?.messageRuns || runtime?.runs || [])].reverse()) if (run.message_id === message.id) latest.set(run.agent_id, run);
  return [...latest.values()].map((run) => {
    const name = data.agents.find((a) => a.id === run.agent_id)?.name || tx("Ajan");
    if (run.state === "failed" && ["tr","en"].some(language=>run.reason.startsWith(translate(language as "tr"|"en","Kod klasöründe kaydedilmemiş değişiklikler var.")))) return {agent_id:run.agent_id,text:tx("{0}: kod klasöründeki değişiklikler kaydedilmeyi bekliyor.", [name]),retry:false,saveRun:run.id};
    if (run.state === "budget_exceeded") return {agent_id:run.agent_id,text:tx("{0}: bütçede kesildi · iş yarıda kalmış olabilir", [name]),retry:true};
    if (run.state === "completed") return { agent_id: run.agent_id, text: tx("{0}: cevaplandı", [name]), retry: false };
    if (run.state === "running") return { agent_id: run.agent_id, text: tx("{0} çalışıyor…", [name]), retry: false };
    if (run.state === "waiting") return { agent_id: run.agent_id, text: tx("{0}: onay bekliyor", [name]), retry: false };
    if (run.state === "queued") {
      const block = runtime?.queueBlocks?.find(b=>b.agent_id === run.agent_id);
      if (block) return {agent_id:run.agent_id,text:block.reason,retry:false,setting:block.setting};
      if (runtime?.paused) return { agent_id: run.agent_id, text: tx("Ofis durduruldu — bekliyor"), retry: false };
      if (!runtime?.connected || runtime.protocolError) return { agent_id: run.agent_id, text: runtime?.protocolError || tx("Çalıştırıcı bağlı değil — bekliyor"), retry: false };
      if (run.reason) return {agent_id:run.agent_id,text:run.reason,retry:false};
      const queue = [...(runtime.runs || [])].filter((r) => r.agent_id === run.agent_id && ["queued", "running"].includes(r.state))
        .sort((a, b) => Number(b.state === "running") - Number(a.state === "running") || (b.priority || 0) - (a.priority || 0) || a.created_at.localeCompare(b.created_at));
      return { agent_id: run.agent_id, text: tx("{0}: sırada (önünde {1} iş var)", [name, "ahead" in run ? run.ahead : Math.max(0, queue.findIndex((r) => r.id === run.id))]), retry: false };
    }
    return { agent_id: run.agent_id, text: tx("{0}: başarısız: {1}", [name, run.reason || tx("Çalışma durduruldu")]), retry: true };
  });
}

// Use the system record type; never infer errors from ordinary message text.
export function legacyEvent(m: Message, _data: Snapshot) { return m.sender_type === "system"; }
export type ChatEvent = {
  id: string; kind: string; text: string; created_at: string;
  agent_id: string | null; run_id?: string | null; message_id?: string | null;
};
export type TimelineItem = { type: "message"; message: Message } | { type: "events"; events: ChatEvent[] };
export function chatTimeline(data: Snapshot, target: string): TimelineItem[] {
  const records: ({ type: "message"; message: Message } | { type: "event"; event: ChatEvent })[] =
    data.messages.filter((m) => inConversation(m, target)).map((m) => legacyEvent(m, data)
      ? { type: "event", event: { ...m, agent_id: m.sender_agent_id, kind: m.sender_type === "system" ? "system" : "run_failed" } }
      : { type: "message", message: m });
  for (const e of data.events) {
    if (!e.conversation_type || !["run_failed", "run_stopped", "run_interrupted", "run_budget_exceeded"].includes(e.kind)) continue;
    if (!inConversation({ recipient_type: e.conversation_type, recipient_id: e.conversation_id || null, sender_agent_id: e.agent_id } as Message, target)) continue;
    records.push({ type: "event", event: e });
  }
  records.sort((a, b) => (a.type === "message" ? a.message : a.event).created_at.localeCompare(
    (b.type === "message" ? b.message : b.event).created_at));
  const result: TimelineItem[] = [];
  for (const record of records) {
    const previous = result.at(-1);
    if (record.type === "event") {
      if (previous?.type === "events" && previous.events[0].kind === record.event.kind
        && dayKey(previous.events[0].created_at) === dayKey(record.event.created_at)) previous.events.push(record.event);
      else result.push({ type: "events", events: [record.event] });
    } else result.push(record);
  }
  return result;
}
export function dayKey(date: string) { return new Date(date).toLocaleDateString("sv-SE"); }
export function dayLabel(date: string, today = new Date()) {
  if (dayKey(date) === dayKey(today.toISOString())) return tx("Bugün");
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey(date) === dayKey(yesterday.toISOString())) return tx("Dün");
  return new Date(date).toLocaleDateString(locale(), { day: "numeric", month: "long", year: "numeric" });
}
export function sameSender(a: Message, b: Message) {
  return dayKey(a.created_at) === dayKey(b.created_at) && isIncoming(a) === isIncoming(b)
    && a.sender_agent_id === b.sender_agent_id
    && (Boolean(a.sender_agent_id) || a.sender_name === b.sender_name);
}
export function senderName(m: Pick<Message, "sender_agent_id" | "sender_name">, agents: Agent[]) {
  return agents.find((a) => a.id === m.sender_agent_id)?.name || tx("Silinmiş ajan");
}
export function shortReason(text: string) {
  const first = text.split(/[\n.!?]/)[0] || text;
  return first.length > 70 ? `${first.slice(0, 67)}…` : first;
}
