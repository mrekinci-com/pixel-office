import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inConversation,
  insertMention,
  mentionSuggestions,
  recipientFor,
  unreadMessages,
  chatTimeline, legacyEvent, dayLabel, sameSender, senderName,
} from "../src/chat/model.js";
import { demoSnapshot } from "../src/demo.js";
import type { Message, Snapshot } from "../shared/types.js";
import { setLanguage } from "../src/i18n/index.js";
setLanguage('tr');
const data = demoSnapshot(
  {
    departments: [],
    agents: [],
    messages: [],
    events: [],
    handoffs: [],
    rules: "",
  } satisfies Snapshot,
  0,
);
test("General, direct and department chat use the correct recipient; deleted recipients open general chat", () => {
  assert.deepEqual(recipientFor("everyone", data), {
    recipient_type: "everyone",
    recipient_id: null,
  });
  assert.deepEqual(recipientFor(`agent:${data.agents[0].id}`, data), {
    recipient_type: "agent",
    recipient_id: data.agents[0].id,
  });
  assert.deepEqual(recipientFor(`department:${data.departments[0].id}`, data), {
    recipient_type: "department",
    recipient_id: data.departments[0].id,
  });
  assert.deepEqual(recipientFor("agent:silindi", data), {
    recipient_type: "everyone",
    recipient_id: null,
  });
});

test("A3: notification types render as events; matching ordinary message text remains unchanged", () => {
  const base: Message = { id: "legacy", sender_agent_id: null, sender_type: "system", sender_name: "Eski deneme",
    recipient_type: "everyone", recipient_id: null, text: "Komut satırı çalışmayı tamamlayamadı. Kimlik doğrulamayı, modeli ve izinleri kontrol edin.",
    created_at: "2026-10-10T10:00:00Z", read_at: null };
  const normal = { ...base, sender_type:'agent' as const, id: "normal", created_at: "2026-10-10T10:02:00Z" };
  const snapshot = { ...data, messages: [base, { ...base, id: "legacy2", created_at: "2026-10-10T10:01:00Z" }, normal],
    events: [{ id: "new", agent_id: data.agents[0].id, department_id: null, kind: "run_failed", text: "Süre sınırı",
      created_at: "2026-10-10T10:01:30Z", conversation_type: "everyone" as const, conversation_id: null },
    { id: "elsewhere", agent_id: data.agents[0].id, department_id: null, kind: "run_failed", text: "Başka sohbet",
      created_at: "2026-10-10T10:01:30Z", conversation_type: "department" as const, conversation_id: data.departments[0].id }] };
  const timeline = chatTimeline(snapshot, "everyone");
  assert.equal(timeline.length, 3);
  assert.equal(timeline[0].type, "events");
  if (timeline[0].type === "events") assert.equal(timeline[0].events.length, 2);
  assert.equal(timeline[1].type, "events");
  assert.equal(timeline[2].type, "message");
  assert.equal(legacyEvent(normal, snapshot), false);
  assert.equal(legacyEvent({...base,sender_type:'agent'}, snapshot),false);
  assert.equal(legacyEvent({ ...base, sender_type: "user" }, snapshot), false);
});

test("A2.4: consecutive messages group by sender and day; renaming preserves identity", () => {
  const m = { id: "one", sender_agent_id: data.agents[0].id, created_at: "2026-10-10T10:00:00Z" } as Message;
  assert.equal(sameSender(m, { ...m, created_at: "2026-10-10T10:01:00Z" }), true);
  assert.equal(sameSender(m, { ...m, sender_agent_id: data.agents[1].id }), false);
  assert.equal(sameSender(m, { ...m, created_at: "2026-10-11T10:00:00Z" }), false);
  assert.equal(sameSender(m, { ...m, created_at: "2026-10-10T10:06:00Z" }), true);
  assert.equal(sameSender(m, { ...m, sender_name: "Yeni ad" }), true);
  assert.equal(dayLabel(m.created_at, new Date("2026-10-10T12:00:00Z")), "Bugün");
  assert.equal(dayLabel(m.created_at, new Date("2026-10-11T12:00:00Z")), "Dün");
});
test("Mention suggestions support Turkish characters, caret position and name selection", () => {
  const agents = [
    ...data.agents,
    { ...data.agents[0], id: "isik", name: "Işık İpek" },
  ];
  assert.equal(mentionSuggestions("@ış", 3, agents)[0]?.id, "isik");
  assert.equal(mentionSuggestions("@İp", 3, agents)[0]?.id, "isik");
  assert.deepEqual(mentionSuggestions("sıradan mesaj", 13, agents), []);
  assert.equal(
    mentionSuggestions("Merhaba @Den gerisi", 12, agents)[0]?.name,
    "Deniz",
  );
  assert.equal(
    insertMention("Merhaba @Den gerisi", 12, "Deniz"),
    "Merhaba @Deniz  gerisi",
  );
  assert.deepEqual(mentionSuggestions("@Deniz ", 7, agents), []);
});
test("General and department messages stay out of direct history; read state belongs to the owner", () => {
  const a = data.agents[0],
    b = data.agents[1];
  const m: Message = {
    id: "1",
    sender_agent_id: a.id,
    sender_type: "agent",
    recipient_type: "agent",
    recipient_id: b.id,
    text: "Merhaba",
    created_at: "",
    read_at: null,
    read_by: [b.id],
  };
  assert.equal(inConversation(m, `agent:${a.id}`), true);
  assert.equal(inConversation(m, `agent:${b.id}`), true);
  assert.equal(inConversation(m, "everyone"), false);
  assert.equal(
    inConversation({ ...m, recipient_type: "everyone" }, `agent:${a.id}`),
    false,
  );
  assert.equal(
    inConversation(
      { ...m, recipient_type: "department", recipient_id: a.department_id },
      `department:${a.department_id}`,
    ),
    true,
  );
  assert.equal(unreadMessages([m], new Set()).length, 1);
  assert.equal(
    unreadMessages([{ ...m, read_by: ["owner"] }], new Set()).length,
    0,
  );
  assert.equal(unreadMessages([m], new Set(["1"])).length, 0);
});

test("A2.3: message outcomes show connection, queue, running, reply and retry state", async () => {
  const { messageResponses } = await import('../src/chat/model.js');
  const { defaultSettings } = await import('../shared/runtime.js');
  const message = { id: 'owner-message', sender_type: 'user', sender_agent_id: null } as Message;
  const run = { id: 'run', agent_id: data.agents[0].id, message_id: message.id, priority: 1, state: 'queued', created_at: '2026-10-10T10:00:00Z', reason: '' } as import('../shared/runtime.js').Run;
  const snapshot: Snapshot = { ...data, runtime: { connected: false, paused: false, settings: {...defaultSettings, language: 'tr' as const}, runs: [run], approvals: [], artifacts: [], links: [], models: { codex: [], claude: [] } } };
  assert.match(messageResponses(message, snapshot)[0].text, /bağlı değil/);
  snapshot.runtime!.connected = true;
  snapshot.runtime!.runs.push({ ...run, id: 'background', message_id: null, priority: 0, state: 'running' });
  assert.match(messageResponses(message, snapshot)[0].text, /önünde 1 iş/);
  run.state = 'running'; assert.match(messageResponses(message, snapshot)[0].text, /çalışıyor/);
  run.state = 'completed'; assert.match(messageResponses(message, snapshot)[0].text, /cevaplandı/);
  run.state = 'failed'; run.reason = 'Başlatılamadı'; assert.equal(messageResponses(message, snapshot)[0].retry, true);
  snapshot.runtime!.runs.unshift({ ...run, id: 'retry', state: 'queued', created_at: '2026-10-10T10:01:00Z' });
  assert.equal(messageResponses(message, snapshot)[0].retry, false);
});
