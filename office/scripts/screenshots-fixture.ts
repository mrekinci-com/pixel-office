// Publication fixtures only. Never load office data, account files or a live runner.
import { demoSnapshot } from '../src/demo.js';
import { defaultSettings } from '../shared/runtime.js';
import type { Snapshot, TududiData } from '../shared/types.js';
import type { Language } from '../shared/i18n/index.js';

export function screenshotFixture(count: number, language: Language): Snapshot {
  const text = (en: string, tr: string) => language === 'en' ? en : tr;
  const seed = demoSnapshot({ departments: [], agents: [], messages: [], events: [], handoffs: [], rules: '' }, 0);
  const departments = [
    { id: 'sample-studio', name: text('Studio', 'Stüdyo'), description: '', color: '#6574bd', sort_order: 0 },
    { id: 'sample-content', name: text('Content', 'İçerik'), description: '', color: '#b48a4b', sort_order: 1 },
    { id: 'sample-product', name: text('Product', 'Ürün'), description: '', color: '#528b7e', sort_order: 2 },
  ];
  const names = [text('Director', 'Genel Müdür'), text('Writer', 'Yazar'), text('Critic', 'Denetçi'), text('Artist', 'Çizer'), text('Scout', 'İzci'), text('Planner', 'Planlamacı'), text('Editor', 'Editör')];
  const titles = [text('Team coordination', 'Ekip koordinasyonu'), text('Launch copy', 'Tanıtım yazısı'), text('Quality review', 'Kalite denetimi'), text('Visual design', 'Görsel tasarım'), text('Audience insights', 'Hedef kitle araştırması'), text('Project planning', 'Proje planlama'), text('Content editing', 'İçerik düzenleme')];
  const jobs = ['', text('Drafting the launch post', 'Tanıtım yazısını hazırlıyorum'), text('Checking the key claims', 'Önemli bilgileri denetliyorum'), text('Preparing the cover', 'Kapak görselini hazırlıyorum'), text('Reviewing audience notes', 'Hedef kitle notlarını inceliyorum'), '', ''];
  const agents = Array.from({ length: count }, (_, i) => ({
    ...seed.agents[i % seed.agents.length],
    id: `sample-agent-${i}`, name: names[i % names.length] + (i >= names.length ? ` ${Math.floor(i / names.length) + 1}` : ''),
    title: titles[i % titles.length], department_id: departments[i === 0 || i === 5 ? 0 : i === 3 || i === 4 ? 2 : 1].id,
    ...(i === 0 ? { builtin: 'director' as const } : {}),
    model: 'gpt-6.1-sol', status: i >= 1 && i <= 4 ? 'calisiyor' as const : 'bosta' as const,
    current_job: jobs[i % jobs.length], tududi_state: 'ready' as const,
    tududi_user_id: `sample-user-${i}`, tududi_email: `sample-${i}@example.test`,
    created_at: '2026-10-13T08:00:00Z',
  }));
  return {
    ...seed, departments, agents,
    messages: [
      { sender_agent_id: null, sender_type: 'user' as const, text: text('Team, let’s prepare a clear, friendly product launch post.', 'Ekip, anlaşılır ve samimi bir ürün tanıtım yazısı hazırlayalım.') },
      { sender_agent_id: agents[0].id, text: text('Writer owns the draft. Critic will check the claims and tone.', 'Taslağı Yazar hazırlıyor. Denetçi bilgileri ve üslubu kontrol edecek.') },
      { sender_agent_id: agents[1].id, text: text('The outline is ready: the problem, three benefits, and a short call to action.', 'Taslak plan hazır: sorun, üç fayda ve kısa bir çağrı.') },
      { sender_agent_id: agents[Math.min(2, count - 1)].id, text: text('I’ll keep the claims specific and flag anything that needs a source.', 'Bilgilerin açık olmasını sağlayıp kaynak gereken yerleri işaretleyeceğim.') },
    ].map((message, i) => ({ ...message, id: `sample-message-${i}`, recipient_type: 'everyone', recipient_id: null, created_at: `2026-10-13T11:${50 + i}:00Z`, read_at: '2026-10-13T12:00:00Z', read_by: ['owner'] })),
    runtime: {
      connected: true, paused: false, availability: { codex: true, claude: false },
      settings: { ...defaultSettings, language, timeZone: 'UTC', emailDomain: 'example.test', approvalRules: [] },
      models: { codex: ['gpt-6.1-sol'], claude: [] },
      runs: [], approvals: [], links: [], artifacts: [],
      director: { agent_id: agents[0].id, auto: false, status: text('Waiting for you', 'Sizi bekliyor'), pending_events: 0, ledger: '', ledger_pending: false, owner_questions: 0, auto_tokens: 0, followup_tokens: 0, auto_runs_hour: 0 },
    },
  };
}

export function screenshotTasks(language: Language): TududiData {
  const text = (en: string, tr: string) => language === 'en' ? en : tr;
  const names = [text('Write the launch post', 'Tanıtım yazısını yaz'), text('Prepare two headlines', 'İki başlık hazırla'), text('Review the key claims', 'Önemli bilgileri denetle'), text('Confirm the release date', 'Tanıtım tarihini doğrula'), text('Collect audience notes', 'Hedef kitle notlarını topla'), text('Agree on the outline', 'Yazı planını netleştir')];
  const descriptions = [text('A friendly draft with three clear benefits.', 'Üç açık faydayı anlatan samimi bir taslak.'), text('Keep each option short and specific.', 'Her seçenek kısa ve açık olsun.'), text('Check accuracy, sources, and tone.', 'Doğruluğu, kaynakları ve üslubu kontrol et.'), text('Waiting for the final date from the owner.', 'Sahibin son tarih kararını bekliyor.'), text('Summarize the main needs in five bullets.', 'Temel ihtiyaçları beş maddede özetle.'), text('Problem, benefits, and a call to action.', 'Sorun, faydalar ve kısa bir çağrı.')];
  return { projects: [{ uid: 'sample-launch', name: text('Product launch', 'Ürün tanıtımı'), description: text('A focused team effort, from brief to review.', 'Hazırlıktan denetime ortak ekip çalışması.') }],
    tasks: names.map((name, i) => ({ uid: `sample-task-${i}`, name, description: descriptions[i], status: [1, 0, 1, 4, 2, 2][i], project_uid: 'sample-launch' })), notes: [] };
}

// These bytes are sent through a mocked browser WebSocket into the real xterm.
// Tool identifiers retain their API spelling in both languages.
export function screenshotTerminal(language: Language) {
  const lines = language === 'en' ? [
    '\x1b[1;36mOpenAI Codex\x1b[0m  ·  Director session  ·  \x1b[2mSample conversation\x1b[0m',
    'model: gpt-6.1-sol    provider: OpenAI    approval: on request', '',
    '\x1b[1m› Hire a writer and a reviewer for a product launch post\x1b[0m', '',
    'I’ll create a Content team, prepare both accounts, and assign clear tasks.', '',
    '\x1b[36m• ofis.yonetim_islem\x1b[0m',
    '  bolum_olustur  { name: "Content" }',
    '  ajan_olustur   { name: "Writer", department: "Content", runner: "codex" }',
    '  ajan_olustur   { name: "Critic", role: "Reviewer", department: "Content" }',
    '\x1b[32m  ✓ Content created · Writer ready · Critic ready\x1b[0m', '',
    '\x1b[36m• ofis.yonetim_islem\x1b[0m',
    '  ajan_calistir  Writer   → Draft a 300-word post with three clear benefits.',
    '  ajan_calistir  Critic   → Check the draft for accuracy, clarity, and tone.',
    '\x1b[32m  ✓ 2 tasks assigned · Work started\x1b[0m', '',
    '\x1b[1mTeam ready.\x1b[0m Writer is drafting the launch post; Critic has the review brief.',
    'I’ll bring you the draft and a short quality report when both are finished.',
    'Publication will wait for your approval.', '',
    '\x1b[2m2 agents hired · 2 tasks assigned · No external actions\x1b[0m', '',
    '› ',
  ] : [
    '\x1b[1;36mOpenAI Codex\x1b[0m  ·  Genel Müdür oturumu  ·  Örnek konuşma', '',
    '› Ürün tanıtım yazısı için bir yazar ve denetçi işe al', '',
    'İçerik bölümünü kurup iki ajanı hazırlayacağım.', '',
    '• ofis.yonetim_islem',
    '  bolum_olustur  İçerik',
    '  ajan_olustur   Yazar, Denetçi',
    '  ✓ Bölüm kuruldu · İki hesap hazır', '',
    '• ofis.yonetim_islem',
    '  ajan_calistir  Yazar → Üç faydayı anlatan 300 kelimelik taslak hazırla.',
    '  ajan_calistir  Denetçi → Doğruluğu, açıklığı ve üslubu kontrol et.',
    '  ✓ İki iş verildi · Çalışma başladı', '',
    'Ekip hazır. Yazar taslağı hazırlıyor; Denetçi kontrol ölçütlerini aldı.',
    'İşler bitince taslağı ve kısa denetim raporunu size sunacağım.',
    'Yayın için onayınızı bekleyeceğim.', '', '› ',
  ];
  return lines.join('\r\n');
}
