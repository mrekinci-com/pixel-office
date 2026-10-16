import { t as tx } from "./i18n";
import { hairStyles, type Snapshot, type Agent } from "../shared/types";
export function demoSnapshot(real: Snapshot, tick: number): Snapshot {
  const departments = real.departments.length
    ? real.departments
    : [
        {
          id: "demo-yonetim",
          name: tx("Yönetim"),
          description: tx("Planlama ve ekip koordinasyonu"),
          color: "#6574bd",
          sort_order: 0,
        },
        {
          id: "demo-arastirma",
          name: tx("Araştırma"),
          description: tx("Kaynaklar ve bulgular"),
          color: "#528b7e",
          sort_order: 1,
        },
        {
          id: "demo-yazilim",
          name: tx("Yazılım"),
          description: tx("Ürün geliştirme"),
          color: "#558db1",
          sort_order: 2,
        },
        {
          id: "demo-tasarim",
          name: tx("Tasarım"),
          description: tx("Görseller ve kullanıcı deneyimi"),
          color: "#ab7894",
          sort_order: 3,
        },
        {
          id: "demo-icerik",
          name: tx("İçerik"),
          description: tx("Yazı ve iletişim"),
          color: "#b48a4b",
          sort_order: 4,
        },
        {
          id: "demo-operasyon",
          name: tx("Operasyon"),
          description: tx("Günlük işlerin takibi"),
          color: "#7c9461",
          sort_order: 5,
        },
      ];
  const names = ["Deniz", "Ece", "Mert", "Ada", "Can", "Selin"];
  const samples: Agent[] = names.map((name, i) => ({
    id: `demo-${i}`,
    name,
    title: [
      tx("Ekip koordinatörü"),
      tx("Araştırma uzmanı"),
      tx("Yazılım uzmanı"),
      tx("Tasarımcı"),
      tx("İçerik editörü"),
      tx("Operasyon uzmanı"),
    ][i],
    department_id: departments[i % departments.length].id,
    prompt: "",
    runner: "codex",
    model: tx("Deneme"),
    effort: "high",
    appearance: {
      skin: i % 2 ? "#e5b88f" : "#c98c69",
      hair: ["#3c3445", "#7b553b", "#353d43"][i % 3],
      shirt: ["#4b9690", "#af758c", "#7c87b6", "#bb9949"][i % 4],
      style: hairStyles[i],
      pants: ["#334657", "#695042", "#495838"][i % 3],
      glasses: i === 0 || i === 3,
      tie: i === 2,
      headphones: i === 5,
    },
    desk_x: 0,
    desk_y: 0,
    status: "bosta",
    current_job: "",
    active: true,
    tududi_user_id: null,
    tududi_email: "",
    tududi_state: "pending",
    created_at: "",
  }));
  const team = [...real.agents, ...samples.slice(real.agents.length)];
  const states = [
    "calisiyor",
    "bosta",
    "bekliyor",
    "calisiyor",
    "kapali",
    "bosta",
  ] as const;
  const agents = team.map((a, i) => ({
    ...a,
    status: states[(i + Math.floor(tick / 3)) % states.length],
    current_job: [
      tx("Kaynakları inceliyorum"),
      tx("Notları hazırlıyorum"),
      tx("Bulguları karşılaştırıyorum"),
    ][i % 3],
  }));
  const messages = [...real.messages];
  if (tick > 0 && agents.length > 1)
    messages.push({
      id: `demo-message-${tick}`,
      sender_agent_id: agents[tick % agents.length].id,
      recipient_type: "agent",
      recipient_id: agents[(tick + 1) % agents.length].id,
      text: [
        tx("Notlarım hazır, birlikte bakalım."),
        tx("Kaynağı kontrol eder misin?"),
        tx("Toplantıda buluşalım."),
      ][tick % 3],
      created_at: new Date().toISOString(),
      read_at: null,
    });
  return { ...real, departments, agents, messages };
}
