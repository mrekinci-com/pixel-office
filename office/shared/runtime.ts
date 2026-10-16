import { defaultDirectorSettings, type DirectorSettings, type DirectorSnapshot } from "./director.js";
export interface AgentPolicy {
  permission: "chat" | "workspace" | "folders";
  commands: boolean;
  network: boolean;
  // Duration caps apply to headless work; persistent Director terminals are exempt by default.
  timeoutMinutes: number;
  maxCalls: number;
  dailyRuns: number;
  dailyMinutes: number;
  inputTokenBudget: number;
  sessionTurnLimit?: number | null;
  sessionTokenLimit?: number | null;
}
export const defaultPolicy: AgentPolicy = {
  permission: "workspace",
  commands: false,
  network: false,
  timeoutMinutes: 15,
  maxCalls: 80,
  dailyRuns: 50,
  dailyMinutes: 120,
  inputTokenBudget: 100000,
};
export interface RuntimeSettings {
  language?: import("./i18n/index.js").Language;
  director?: DirectorSettings;
  defaultRunner?: "claude" | "codex";
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  timeZone: string;
  emailDomain: string;
  dailyTokenBudget: number;
  budgetUncached?: boolean; // Legacy input only; budgets always use weighted tokens.
  cachedInputWeight?: number;
  chatTurnLimit?: number;
  sessionTurnLimit: number;
  sessionTokenLimit: number;
  defaultModel: string;
  defaultEffort: "low" | "medium" | "high" | "xhigh" | "max";
  sharedWriters: string[];
  concurrency: number;
  maxDepth: number;
  chainRuns: number;
  dailyRuns: number;
  dailyMinutes: number;
  approvalRules: string[];
  chainTokenBudget: number;
  greeterAgentId: string | null;
}
export const defaultSettings: RuntimeSettings = {
  language: "en",
  director: defaultDirectorSettings, defaultRunner: "codex", inputPricePerMillion: 0, outputPricePerMillion: 0,
  timeZone: 'Europe/Istanbul',
  emailDomain: "piksel-ofis.local",
  dailyTokenBudget: 750000,
  sessionTurnLimit: 12,
  sessionTokenLimit: 150000,
  budgetUncached: false,
  cachedInputWeight: 0.1,
  chatTurnLimit: 12,
  defaultModel: "gpt-6.1-sol",
  defaultEffort: "high",
  sharedWriters: [],
  concurrency: 2,
  maxDepth: 6,
  chainRuns: 12,
  dailyRuns: 200,
  dailyMinutes: 480,
  chainTokenBudget: 375000,
  greeterAgentId: null,
  approvalRules: ["Şirket dışına çıkan işlemler (e-posta, yayın, dış sisteme yazma, para harcama) için onay iste. Sahibe cevap/teslim ve ajanlar arası iş devri buna dahil değildir."],
};
export type RunState =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "budget_exceeded"
  | "failed"
  | "stopped"
  | "interrupted";
export const runLabels: Record<RunState, string> = {
  queued: "Sırada",
  running: "Çalışıyor",
  waiting: "Onay bekliyor",
  completed: "Bitti",
  budget_exceeded: "Bütçede kesildi",
  failed: "Başarısız",
  stopped: "Durduruldu",
  interrupted: "Yarıda kaldı",
};
export function toolSummary(text: string): string {
  const labels: Record<string, string> = {
    yonetim_durum:"Ofis durumunu okudu",yonetim_islem:"Yönetim işlemi yaptı",yonetim_defteri:"Durum defterini güncelledi",yonetim_izle:"İşi takibe aldı",
    komut_calistir:"Kayıtlı komutu çalıştırdı",engel_bildir:"Engel bildirdi",yayina_hazir:"Yayına hazır onayı istedi",is_notu_yaz:"İş notunu yazdı",sohbet_gecmisi:"Sohbet geçmişini okudu",
    mesaj_gonder: "Mesaj gönderdi",
    gelen_kutusu: "Gelen kutusunu okudu",
    gorev_devret: "Görev devretti",
    gorev_durumu: "Görevin durumunu değiştirdi",
    tududi_gorevler: "Tududi görevlerini okudu",
    tududi_gorev_ekle: "Tududi'ye görev ekledi",
    tududi_gorev_guncelle: "Tududi görevini güncelledi",
    tududi_notlar: "Tududi notlarını okudu",
    tududi_not_yaz: "Tududi'ye not yazdı",
    hafiza_oku: "Hafıza notunu okudu",
    hafiza_yaz: "Hafıza notunu yazdı",
    durum_bildir: "Yaptığı işi bildirdi",
    onay_iste: "Onay istedi",
    teslim_et: "Çıktı teslim etti",
  };
  return labels[text.split(":")[0].replace(/^mcp__ofis__/,"")] || "Araç kullandı";
}
export interface Run {
  director_auto?:boolean;
  director_followup?:boolean;
  id: string;
  agent_id: string;
  chain_id: string;
  depth: number;
  scheduled_task_id?: string | null;
  parent_run_id?:string|null;
  trigger: string;
  summary: string;
  conversation_type: "agent" | "department" | "everyone";
  conversation_id: string | null;
  state: RunState;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  output: string;
  reason: string;
  calls: number;
  retry: number;
  duration_ms: number;
  usage: Record<string, number>;
  work_item_id?: string | null;
  session_generation?: number | null;
  smoke_timeout_seconds?: number | null;
  message_id?: string | null;
  handoff_id?: string | null;
  priority?: number;
  not_before?: number;
  startup_retry?: number;
}
export interface RunLog {
  id: number;
  run_id: string;
  kind: string;
  text: string;
  created_at: string;
}
export interface FolderLink {
  documents?:string[];
  documents_truncated?:boolean;
  id: string;
  name: string;
  path: string;
  access: "read" | "write";
  approved_write: boolean;
  agent_ids: string[];
  validation: "pending" | "valid" | "invalid";
  detail: string;
}
export interface ProposedFile {
  path: string;
  content: string;
  before_hash: string | null;
  after_hash: string;
  diff: string;
}
export interface Approval {
  id: string;
  agent_id: string;
  run_id: string;
  title: string;
  detail: string;
  type: string;
  state:
    | "pending"
    | "approved"
    | "rejected"
    | "applying"
    | "applied"
    | "apply_failed";
  note: string;
  created_at: string;
  decided_at: string | null;
  link_id: string | null;
  files: ProposedFile[];
}
export interface Artifact {
  id: string;
  agent_id: string;
  run_id: string;
  title: string;
  summary: string;
  name: string;
  mime: string;
  size: number;
  created_at: string;
}
export interface RuntimeSnapshot {
  director?: DirectorSnapshot;
  dailyUsage?: { day: string; input_tokens: number; uncached_input_tokens: number; cached_input_tokens?:number; total_tokens?:number; weighted_tokens?:number };
  queueBlocks?: { agent_id: string; reason: string; setting: 'usage' | 'agents' | 'links' }[];
  sessions?: AgentSession[];
  providerPauses?: ProviderPause[];
  commands?: CommandLink[];
  messageRuns?: MessageRunStatus[];
  protocolError?: string;
  chains?: ChainUsage[];
  smoke?: boolean;
  stoppedChains?: { id: string; reason: string; stopped_at: string; message_id: string; event_id: string }[];
  pendingDeletions?: { id: string; name: string; state: string; detail: string; next_at: number; attempts: number }[];
  activity?: RunLog[];
  connected: boolean;
  connecting?: boolean;
  availability?: { claude: boolean; codex: boolean };
  claudeLoginCommand?: string;
  paused: boolean;
  models: { claude: string[]; codex: string[] };
  settings: RuntimeSettings;
  runs: Run[];
  approvals: Approval[];
  links: FolderLink[];
  artifacts: Artifact[];
}
export interface Lease {
  language?: import("./i18n/index.js").Language;
  terminalInstructions?: string;
  toolNames?: string[];
  acceptanceCommands?: CommandLink[];
  saveWorkspaceBeforeStart?: boolean;
  session?: AgentSession;
  commands?: CommandLink[];
  task_uid?: string | null;
  incoming?: IncomingFile[];
  smokeTimeoutSeconds?: number;
  run: Run;
  agent: import("./types.js").Agent;
  policy: AgentPolicy;
  key: string;
  prompt: string;
  links: FolderLink[];
}
export const PROTOCOL_VERSION = 11;
export interface IncomingFile {
  transfer_id: string;
  index: number;
  path: string;
  size: number;
  hash: string;
}
export interface ChainUsage {
  id: string;
  runs: Pick<Run, "id" | "agent_id" | "summary" | "state" | "usage" | "duration_ms" | "started_at" | "depth" | "chain_id">[];
  input_tokens: number;
  cached_input_tokens?:number;
  uncached_input_tokens?:number;
  output_tokens: number;
  weighted_tokens?:number;
  duration_ms: number;
}
// Claude input excludes cache fields; Codex input includes cached_input_tokens.
export function usageTotals(usage: Record<string, number>) {
  const input_tokens = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  const output_tokens = usage.output_tokens || 0;
  const cached_input_tokens = Math.min(input_tokens, (usage.cached_input_tokens || 0) + (usage.cache_read_input_tokens || 0));
  const uncached_input_tokens = input_tokens - cached_input_tokens;
  return { input_tokens, cached_input_tokens, uncached_input_tokens, output_tokens, total_tokens: input_tokens + output_tokens };
}

// Cache creation is full-priced input. Missing cache fields are full-priced too.
export function weightedTokens(usage: Record<string, number>, cachedInputWeight = 0.1) {
  const t = usageTotals(usage);
  const weight = Number.isFinite(cachedInputWeight) ? Math.max(0, Math.min(1, cachedInputWeight)) : 0.1;
  return t.uncached_input_tokens + t.output_tokens + t.cached_input_tokens * weight;
}

export type MessageRunStatus = Pick<Run, "id" | "agent_id" | "message_id" | "state" | "reason" | "priority" | "created_at"> & { ahead: number };

export interface AgentSession {
  session_key?: string;
  work_item_id?: string | null;
  last_input_at?: string;
  last_input_tokens?: number;
  last_input_tokens_known?:boolean;
  cached_input_tokens?: number;
  counted_cached_tokens?:Record<string,number>;
  closed?: boolean;
  agent_id: string;
  generation: number;
  provider_id: string | null;
  runner: "claude" | "codex";
  created_at: string;
  turns: number;
  input_tokens: number;
  renewals: number;
  bytes: number;
  rules_hash: string;
  renewing: boolean;
  renew_error?: boolean;
}
export interface ProviderPause {
  provider: "claude" | "codex";
  reason: string;
  until: number | null;
}
export interface CommandLink {
  id: string;
  name: string;
  folder_id: string;
  directory: string;
  command: string;
  timeout_seconds: number;
  write: boolean;
  approval: boolean;
  agent_ids: string[];
}
export interface CommandJob {
  id: string;
  run_id: string;
  agent_id: string;
  command: CommandLink;
  folder: FolderLink;
  state: "pending" | "running" | "completed";
  exit_code: number | null;
  output: string;
}
