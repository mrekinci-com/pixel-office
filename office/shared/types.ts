export const statuses = ["bosta", "calisiyor", "bekliyor", "kapali"] as const;
export type Status = (typeof statuses)[number];
export const statusLabels: Record<Status, string> = {
  bosta: "Boşta",
  calisiyor: "Çalışıyor",
  bekliyor: "Bekliyor",
  kapali: "Kapalı",
};
export interface Department {
  responsible_agent_id?: string | null;
  id: string;
  name: string;
  description: string;
  color: string;
  sort_order: number;
}
export const hairStyles = [
  "kisa",
  "uzun",
  "topuz",
  "kivircik",
  "kel",
  "sapkali",
] as const;
export const hairLabels = [
  "Kısa",
  "Uzun",
  "Topuz",
  "Kıvırcık",
  "Kel",
  "Şapkalı",
];
export interface Appearance {
  skin: string;
  hair: string;
  shirt: string;
  style: (typeof hairStyles)[number];
  pants?: string;
  glasses?: boolean;
  tie?: boolean;
  headphones?: boolean;
}
export interface Agent {
  builtin?: "director";
  tool_groups?: import("./director.js").ToolGroup[];
  username?: string;
  session_mode?: "work" | "persistent" | "single";
  watch_tasks?: boolean;
  watch_due?: boolean;
  workbook_uid?: string | null;
  policy?: import("./runtime.js").AgentPolicy;
  id: string;
  name: string;
  title: string;
  department_id: string;
  prompt: string;
  runner: "claude" | "codex";
  model: string;
  effort: string;
  appearance: Appearance;
  desk_x: number;
  desk_y: number;
  status: Status;
  current_job: string;
  active: boolean;
  tududi_user_id: string | null;
  tududi_email: string;
  tududi_state: "pending" | "ready";
  created_at: string;
}
export interface Message {
  response_note?: string;
  artifact_ids?: string[];
  owner_only?: boolean;
  id: string;
  sender_agent_id: string | null;
  sender_type?: "user" | "agent" | "system";
  sender_name?: string;
  recipient_type: "agent" | "department" | "everyone";
  recipient_id: string | null;
  text: string;
  created_at: string;
  read_at: string | null;
  read_by?: string[];
}
export interface OfficeEvent {
  conversation_type?: Message["recipient_type"] | null;
  conversation_id?: string | null;
  run_id?: string | null;
  message_id?: string | null;
  sender_name?: string;
  id: string;
  agent_id: string | null;
  department_id: string | null;
  kind: string;
  text: string;
  created_at: string;
}
export interface Handoff {
  id: string;
  from_agent_id: string | null;
  to_agent_id: string;
  title: string;
  description: string;
  status: "pending" | "created" | "completed" | "failed" | "not_started";
  run_id?: string | null;
  note?: string;
  tududi_task_uid: string | null;
  created_at: string;
}
export interface Snapshot {
  runtime?: import("./runtime.js").RuntimeSnapshot;
  departments: Department[];
  agents: Agent[];
  messages: Message[];
  events: OfficeEvent[];
  handoffs: Handoff[];
  rules: string;
}
export interface Task {
  uid: string;
  name: string;
  status: number | string;
  description?: string;
  note?: string;
  project_uid?: string;
  due_date?: string;
}
export interface Project {
  uid: string;
  name: string;
  description?: string;
}
export interface Note {
  locked?: boolean;
  invalid?: boolean;
  verified_at?: string | null;
  stale?: boolean;
  uid: string;
  title: string;
  content: string;
  project_uid?: string;
  updated_at?: string;
  tags?: { name: string }[];
}
export interface TududiData {
  tasks: Task[];
  projects: Project[];
  notes: Note[];
}
