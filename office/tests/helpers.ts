import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "../server/config.js";
import type { Fetcher } from "../server/tududi.js";
import type { Agent } from "../shared/types.js";
import { Store } from "../server/db.js";
// Most regression tests exercise an existing Turkish office. Pass null to
// exercise a genuinely fresh installation and its English default.
export function testConfig(language: 'tr' | 'en' | null = 'tr'): Config {
  const root = resolve(".test-data");
  mkdirSync(root, { recursive: true });
  const dataDir = mkdtempSync(resolve(root, "run-"));
  if (language) {
    const store = new Store(dataDir);
    store.setLanguage(language);
    store.close();
  }
  return {
    port: 9400,
    dataDir,
    ownerPassword: "yalniz-test-parolasi",
    secretKey: "ab".repeat(32),
    secureCookie: false,
    tududiUrl: "http://127.0.0.1:9393",
    tududiAdminEmail: "yonetici@example.test",
    tududiAdminPassword: "sahte-test-parolasi",
  };
}
export function cleanup(config: Config) {
  rmSync(config.dataDir, { recursive: true, force: true });
}
export function input(department_id: string) {
  return {
    name: "Deneme Ajanı",
    title: "Araştırmacı",
    department_id,
    prompt: "Kaynak göster.",
    runner: "codex" as const,
    model: "secilen-model",
    effort: "high",
    appearance: {
      skin: "#e9ba87",
      hair: "#362f42",
      shirt: "#3c948d",
      style: "kisa" as const,
    },
    desk_x: 0,
    desk_y: 0,
    status: "bosta" as const,
    current_job: "",
    active: true,
  };
}
export function fakeTududi() {
  let userId = 100;
  let counter = 0;
  let unavailable = false;
  const users: { id: number; email: string }[] = [];
  // Exclude account passwords from public user lists and call records.
  const passwords = new Map<number, string>();
  const tasks = new Map<string, any[]>();
  const notes = new Map<string, any[]>();
  const projects = new Map<string, any[]>();
  const profiles = new Map<string, {language:string;timezone:string}>();
  const calls: { path: string; method: string; auth?: string }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method || "GET";
    const headers = new Headers(init?.headers);
    const auth = headers.get("Authorization") || undefined;
    calls.push({ path, method, auth });
    if (unavailable) throw new Error("Deneme kesintisi");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const json = (data: any, status = 200, cookie?: string) =>
      new Response(JSON.stringify(data), {
        status,
        headers: {
          "Content-Type": "application/json",
          ...(cookie ? { "Set-Cookie": cookie } : {}),
        },
      });
    if (path === "/api/login") {
      const user = users.find((u) => u.email.toLowerCase() === String(body.email).toLowerCase());
      const admin = body.email === "yonetici@example.test" && body.password === "sahte-test-parolasi";
      if (!admin && (!user || passwords.get(user.id) !== body.password)) return json({}, 401);
      return json(
        { ok: true },
        200,
        `tududi_session=${encodeURIComponent(body.email)}; HttpOnly`,
      );
    }
    if (path === "/api/admin/users" && method === "GET") return json(users);
    if (path === "/api/admin/users" && method === "POST") {
      if (users.some((u) => u.email.toLowerCase() === String(body.email).toLowerCase())) return json({}, 409);
      const user = { id: ++userId, email: body.email };
      users.push(user);
      passwords.set(user.id, body.password);
      return json(user, 201);
    }
    if (path.startsWith("/api/admin/users/") && method === "PUT") {
      const user = users.find(u => String(u.id) === path.split("/").at(-1)); if (!user) return json({},404);
      if (body.email && users.some((u) => u.id !== user.id && u.email.toLowerCase() === String(body.email).toLowerCase())) return json({},409);
      if (body.password !== undefined) passwords.set(user.id,body.password);
      if (body.email !== undefined) user.email = body.email;
      return json(user);
    }
    if (path.startsWith("/api/admin/users/") && method === "DELETE") {
      const index = users.findIndex(
        (u) => String(u.id) === path.split("/").at(-1),
      );
      if (index >= 0) { passwords.delete(users[index].id); users.splice(index, 1); }
      return json({ ok: true });
    }
    if (path === "/api/profile/api-keys")
      return json(
        {
          token: `fake-token-${headers.get("cookie")}`,
          apiKey: { id: ++counter },
        },
        201,
      );
    const key = auth || "";
    if (path === "/api/profile") { if(method === "PATCH") profiles.set(key,body); return json(profiles.get(key) || {}); }
    if (!tasks.has(key)) {
      tasks.set(key, []);
      notes.set(key, []);
      projects.set(key, []);
    }
    if (path === "/api/tasks") return json({ tasks: tasks.get(key) });
    if (path === "/api/projects") return json({ projects: projects.get(key) });
    if (path === "/api/notes") return json(notes.get(key));
    if (path === "/api/task") {
      const task = { uid: `task-${++counter}`, status: 0, ...body };
      tasks.get(key)!.push(task);
      return json(task, 201);
    }
    if (path.startsWith("/api/task/")) {
      const task = tasks
        .get(key)!
        .find((t) => t.uid === path.split("/").at(-1));
      if (!task) return json({}, 404);
      Object.assign(task, body);
      return json(task);
    }
    if (path.startsWith("/api/note/")) {
      const note = notes.get(key)!.find(n => n.uid === path.split("/").at(-1)); if (!note) return json({},404); Object.assign(note,body,{updated_at:new Date().toISOString()}); return json(note);
    }
    if (path === "/api/search") { const q = new URL(String(url)).searchParams.get("q") || ""; return json({notes:notes.get(key)!.filter(n => JSON.stringify(n).includes(q)),tasks:tasks.get(key)!.filter(t => JSON.stringify(t).includes(q))}); }
    if (path === "/api/note") {
      const note = { uid: `note-${++counter}`, ...body };
      notes.get(key)!.push(note);
      return json(note, 201);
    }
    if(path.startsWith('/api/project/')){const p=projects.get(key)!.find(p=>p.uid===path.split('/').at(-1));if(!p)return json({},404);Object.assign(p,body);return json(p);}
    if (path === "/api/project") {
      const p = { uid: `project-${++counter}`, ...body };
      projects.get(key)!.push(p);
      return json(p, 201);
    }
    return json({}, 404);
  };
  return {
    fetcher,
    profiles,
    users,
    calls,
    setUnavailable: (v: boolean) => {
      unavailable = v;
    },
  };
}
export function agentBody(a: Agent) {
  const {
    id,
    created_at,
    tududi_user_id,
    tududi_email,
    tududi_state,
    workbook_uid,
    builtin,
    ...body
  } = a;
  return body;
}
