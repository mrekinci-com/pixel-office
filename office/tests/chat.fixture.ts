import type { Snapshot, Message } from "../shared/types.js";
export function longChatFixture(base: Snapshot): Snapshot {
  const artifacts = base.runtime?.artifacts.length ? base.runtime.artifacts : [{ id: "chat-output", agent_id: "chat-agent-0", run_id: "chat-run",
    title: "İnceleme sonucu", summary: "Notlar hazır.", name: "sonuc.txt", mime: "text/plain", size: 64, created_at: "2026-10-10T10:33:00Z" }];
  const departments = Array.from({ length: 10 }, (_, i) => ({ ...base.departments[i % base.departments.length],
    id: `chat-department-${i}`, name: `Bölüm ${i + 1}`, responsible_agent_id: null }));
  const agents = Array.from({ length: 20 }, (_, i) => ({ ...base.agents[i % base.agents.length],
    id: `chat-agent-${i}`, name: i === 0 ? "Defne" : `Çalışan ${i + 1}`, title: "Ekip sorumlusu",
    department_id: departments[i % 10].id, status: "bosta" as const, current_job: "" }));
  const message: Message = { id: "", sender_agent_id: null, sender_type: "user", recipient_type: "everyone",
    recipient_id: null, text: "", created_at: "", read_at: null, read_by: [agents[0].id, "owner"] };
  const messages: Message[] = Array.from({ length: 60 }, (_, i) => ({ ...message,
    id: `chat-message-${i}`, sender_type: i % 4 < 2 ? "agent" : "user",
    sender_agent_id: i % 4 < 2 ? agents[0].id : null,
    text: i % 4 < 2 ? `İnceleme ${i + 1} tamamlandı. Sonuçları birlikte değerlendirebiliriz.` : `Not ${i + 1}: sıradaki işi birlikte inceleyelim.`,
    created_at: `2026-10-${i < 30 ? "09" : "10"}T10:${String(i % 30).padStart(2, "0")}:00Z` }));
  messages.push({ ...message, id: "deleted-normal", sender_type: "agent", sender_name: "Eski deneme ajanı",
    text: "Eski çalışmadan kalan normal bir cevap.", created_at: "2026-10-10T10:31:00Z" });
  const events = Array.from({length:4},(_,i)=>({id:`run-failure-${i}`,agent_id:null,department_id:null,kind:"run_failed",conversation_type:"everyone" as const,conversation_id:null,text: "Komut satırı çalışmayı tamamlayamadı. Kimlik doğrulamayı, modeli ve izinleri kontrol edin.",
    created_at: `2026-10-10T10:32:0${i}Z` }));
  messages.push({ ...message, id: "chat-markdown", sender_type: "agent", sender_agent_id: agents[0].id,
    text: '**DÜZELTME GEREK**\n\n- İlk adımı kontrol edin.\n- `sonuc.txt` dosyası hazır.\n\n```text\nSonuç: işler tamamlandı.\nUzunSözcük' + 'çokuzun'.repeat(30) + '\n```\n\n[Kaynak](https://example.com)\n\n' + Array.from({ length: 16 }, (_, i) => `${i + 1}. İnceleme notu; ekiple paylaşılacak bilgi.`).join('\n') + '\n\n<img src=x onerror=alert(1)>',
    artifact_ids: artifacts.slice(0, 1).map((a) => a.id), created_at: "2026-10-10T10:33:00Z" });
  return { ...base, departments, agents, messages, events, handoffs: [], runtime: base.runtime && {
    ...base.runtime, artifacts, connected: true, paused: false, runs: [], messageRuns: [], approvals: [], stoppedChains: [], protocolError: "", settings: { ...base.runtime.settings, greeterAgentId: null },
  } };
}
