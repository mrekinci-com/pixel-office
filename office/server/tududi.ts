import { translate, type Language } from "../shared/i18n/index.js";
import type { Config } from "./config.js";
import type { Note, Project, Task, TududiData } from "../shared/types.js";
export class TududiError extends Error {
  constructor(
    public status: number,
    public code: string = "unavailable",
    public retryAfterSeconds = 900,
    language: Language = "tr",
  ) {
    super(translate(language,
      code === 'email_conflict'
        ? 'Bu e-posta Tududi’de başka bir hesapta kullanılıyor; farklı kullanıcı adı seçin.'
        : status === 429
        ? translate(language,"Tududi kısa süreliğine girişleri sınırladı, {0} dakika sonra tekrar deneyin.",[Math.max(1, Math.ceil(retryAfterSeconds / 60))])
        : status === 401 || status === 403
        ? "Tududi giriş izni vermedi. Yönetici bilgilerini ve e-posta doğrulamasını kontrol edin."
        : "Tududi işlemi tamamlanamadı. Bağlantıyı kontrol edip tekrar deneyin.",
    ));
  }
}
export type Fetcher = typeof fetch;
export class TududiClient {
  private adminCookie = "";
  private adminLogin?: Promise<string>;
  private loginLimitedUntil = 0;
  constructor(
    private config: Config,
    private fetcher: Fetcher = fetch,
    private language: () => Language = () => "tr",
  ) {}
  private error(status: number, code = "unavailable", retryAfterSeconds = 900) { return new TududiError(status,code,retryAfterSeconds,this.language()); }
  private async request(
    path: string,
    method = "GET",
    body?: unknown,
    auth?: { cookie?: string; token?: string },
  ): Promise<{ data: any; cookie: string }> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.tududiUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(auth?.cookie ? { Cookie: auth.cookie } : {}),
          ...(auth?.token ? { Authorization: `Bearer ${auth.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
    } catch {
      throw this.error(503);
    }
    if (!response.ok) {
      const retry = response.headers.get("retry-after");
      const seconds = retry && /^\d+$/.test(retry) ? Number(retry)
        : retry ? Math.ceil((Date.parse(retry) - Date.now()) / 1000) : 900;
      throw this.error(response.status, "unavailable", Number.isFinite(seconds) ? Math.max(1, seconds) : 900);
    }
    let data: any = {};
    if (response.status !== 204) {
      try {
        data = await response.json();
      } catch {
        throw this.error(502, "invalid_response");
      }
    }
    return {
      data,
      cookie: response.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; "),
    };
  }
  async login(email: string, password: string): Promise<string> {
    if (Date.now() < this.loginLimitedUntil)
      throw this.error(429, "login_limited", Math.ceil((this.loginLimitedUntil - Date.now()) / 1000));
    let result;
    try { result = await this.request("/api/login", "POST", { email, password }); }
    catch (error) {
      if (error instanceof TududiError && error.status === 429)
        this.loginLimitedUntil = Date.now() + error.retryAfterSeconds * 1000;
      throw error;
    }
    if (!result.cookie) throw this.error(502, "missing_cookie");
    return result.cookie;
  }
  private async admin(): Promise<string> {
    if (!this.config.tududiAdminEmail || !this.config.tududiAdminPassword)
      throw this.error(503, "missing_configuration");
    if (this.adminCookie) return this.adminCookie;
    if (!this.adminLogin) {
      this.adminLogin = this.login(this.config.tududiAdminEmail, this.config.tududiAdminPassword)
        .then((cookie) => this.adminCookie = cookie)
        .finally(() => { this.adminLogin = undefined; });
    }
    return this.adminLogin;
  }
  private async adminRequest(path: string, method = "GET", body?: unknown) {
    const cookie = await this.admin();
    try { return await this.request(path, method, body, { cookie }); }
    catch (error) {
      if (!(error instanceof TududiError && error.status === 401)) throw error;
      // Concurrent stale requests share one replacement login.
      if (this.adminCookie === cookie) this.adminCookie = "";
      return this.request(path, method, body, { cookie: await this.admin() });
    }
  }
  async findUser(email: string): Promise<string | null> {
    const { data } = await this.adminRequest("/api/admin/users");
    const found = (Array.isArray(data) ? data : data.users || []).find(
      (u: any) => u.email === email,
    );
    return found ? String(found.id) : null;
  }
  async createUser(
    email: string,
    password: string,
    name: string,
    linkedUserId?: string | null,
  ): Promise<string> {
    const existing = (await this.adminRequest("/api/admin/users")).data;
    const found = (
      Array.isArray(existing) ? existing : existing.users || []
    ).find((u: any) => String(u.email).toLowerCase() === email.toLowerCase());
    if (found) {if(linkedUserId && String(found.id)===linkedUserId)return linkedUserId;throw this.error(409, 'email_conflict');}
    const { data } = await this.adminRequest(
      "/api/admin/users", "POST", { email, password, name, surname: translate(this.language(), "Ofis") },
    ).catch(error=>{if(error instanceof TududiError && error.status===409)throw this.error(409,'email_conflict');throw error;});
    const user = data.user || data;
    if (user.id === undefined) throw this.error(502, "missing_user");
    return String(user.id);
  }
  async createKey(email: string, password: string): Promise<string> {
    const cookie = await this.login(email, password);
    const { data } = await this.request(
      "/api/profile/api-keys",
      "POST",
      { name: translate(this.language(), "Piksel Ofis") },
      { cookie },
    );
    if (typeof data.token !== "string")
      throw this.error(502, "missing_token");
    return data.token;
  }
  async updateUser(id: string, body: { email?: string; password?: string }) {
    await this.adminRequest(`/api/admin/users/${encodeURIComponent(id)}`, "PUT", body);
  }
  async localizeProfile(token: string, timeZone: string, language: "tr" | "en" = "tr") {
    const current = await this.profile(token);
    if (current.language === language && current.timezone === timeZone) return;
    await this.request('/api/profile', 'PATCH', { language, timezone: timeZone }, { token });
  }
  async profile(token: string): Promise<{language:string;timezone:string}> {
    return (await this.request('/api/profile','GET',undefined,{token})).data;
  }
  async updateNote(token: string, uid: string, body: {title: string; content: string; project_uid?: string}) {
    const { data } = await this.request(`/api/note/${encodeURIComponent(uid)}`, "PATCH", body, { token }); return (data.note || data) as Note;
  }
  async updateTaskNote(token: string, uid: string, note: string) {
    const {data} = await this.request(`/api/task/${encodeURIComponent(uid)}`, "PATCH", {note}, {token}); return (data.task || data) as Task;
  }
  async search(token: string, query: string, project?: string) {
    const {data} = await this.request(`/api/search?q=${encodeURIComponent(query)}${project ? `&project_uid=${encodeURIComponent(project)}` : ""}`, "GET", undefined, {token}); return data;
  }
  async publishSummary(day: string, content: string, projectName = "Günlük özet") {
    const projects = (await this.adminRequest("/api/projects")).data;
    const projectRows = projects.projects || projects;
    let project = projectRows.find((p: any) => p.name === projectName);
    if (!project) { const result = await this.adminRequest("/api/project","POST",{name:projectName}); project = result.data.project || result.data; }
    const notes = (await this.adminRequest("/api/notes")).data;
    const old = (notes.notes || notes).find((n: any) => n.title === day && (n.project_uid || n.project?.uid || projectRows.find((p:any)=>p.id===n.project_id)?.uid) === project.uid);
    await this.adminRequest(old ? `/api/note/${encodeURIComponent(old.uid)}` : "/api/note", old ? "PATCH" : "POST", {title:day,content,project_uid:project.uid});
  }
  async deleteUser(id: string): Promise<void> {
    await this.adminRequest(
      `/api/admin/users/${encodeURIComponent(id)}`,
      "DELETE",
      undefined,
    );
  }
  async resetInventory(token:string,userId:string):Promise<Record<string,any[]>> {
    const result:Record<string,any[]>={};
    for(const kind of ['Task','Note','Project']) {
      const rows:any[]=[];let total:number|undefined;
      for(let offset=0;;offset+=100) {
        const {data}=await this.request(`/api/search?filters=${kind}&limit=100&offset=${offset}`,'GET',undefined,{token});
        const page=data.pagination;
        if(!Array.isArray(data.results) || !page || !Number.isInteger(page.total) || page.total<0 || typeof page.hasMore!=='boolean' || data.results.length>100 || page.hasMore!==(offset+data.results.length<page.total) || page.offset!==offset || page.limit!==100 || (total!==undefined && total!==page.total))throw this.error(502,'incomplete_inventory');
        total=page.total;
        for(const row of data.results) {
          if(typeof row.uid!=='string' || rows.some(r=>r.uid===row.uid))throw this.error(502,'unstable_inventory');
          const {data:detail}=await this.request(`/api/${kind.toLowerCase()}/${encodeURIComponent(row.uid)}`,'GET',undefined,{token});
          const value=detail[kind.toLowerCase()] || detail;
          if(value.uid!==row.uid)throw this.error(502,'inventory_identity_mismatch');
          if(String(value.user_id)!==String(userId))throw this.error(403,'scope_mismatch');
          rows.push(value);
        }
        if(!page.hasMore){if(rows.length!==total)throw this.error(502,'incomplete_inventory');break;}
        if(!data.results.length)throw this.error(502,'incomplete_inventory');
      }
      result[kind]=rows.sort((a,b)=>a.uid.localeCompare(b.uid));
    }
    return result;
  }
  async resetDelete(token:string,kind:string,uid:string) {
    if(!['Task','Note','Project'].includes(kind))throw this.error(400,'invalid_kind');
    await this.request(`/api/${kind.toLowerCase()}/${encodeURIComponent(uid)}`,'DELETE',undefined,{token});
  }
  async read(token: string): Promise<TududiData> {
    const [projects, tasks, notes] = await Promise.all([
      this.request("/api/projects", "GET", undefined, { token }),
      this.request(
        "/api/tasks?type=all&client_side_filtering=true",
        "GET",
        undefined,
        { token },
      ),
      this.request("/api/notes", "GET", undefined, { token }),
    ]);
    const projectRows = (projects.data.projects || projects.data) as (Project & {id?:number})[];
    const projectUid = (entry:any) => entry.project_uid || entry.project?.uid || projectRows.find(p=>p.id===entry.project_id)?.uid;
    return {
      projects: projectRows,
      tasks: ((tasks.data.tasks || tasks.data) as Task[]).map((t) => ({
        ...t,
        description: t.description ?? t.note ?? "",
        project_uid: projectUid(t),
      })),
      notes: ((notes.data.notes || notes.data) as Note[]).map(n=>({...n,project_uid:projectUid(n)})),
    };
  }
  async task(
    token: string,
    body: { name: string; description?: string; project_uid?: string },
  ): Promise<Task> {
    const { description, ...rest } = body;
    const { data } = await this.request(
      "/api/task",
      "POST",
      { ...rest, note: description },
      { token },
    );
    const task = data.task || data;
    return { ...task, description: task.description ?? task.note ?? "" };
  }
  async renameTask(token:string, uid:string, name:string) {
    const {data}=await this.request(`/api/task/${encodeURIComponent(uid)}`,"PATCH",{name},{token});
    return data.task || data;
  }
  async updateTaskFields(token:string,uid:string,body:{status?:number;name?:string;description?:string;project_uid?:string}):Promise<Task>{const {description,...rest}=body;const {data}=await this.request(`/api/task/${encodeURIComponent(uid)}`,'PATCH',{...rest,...(description===undefined?{}:{note:description})},{token});const task=data.task || data;return {...task,description:task.description ?? task.note ?? ''};}
  async updateTask(token: string, uid: string, status: number): Promise<Task> {
    const { data } = await this.request(
      `/api/task/${encodeURIComponent(uid)}`,
      "PATCH",
      { status },
      { token },
    );
    return data.task || data;
  }
  async note(
    token: string,
    body: { title: string; content: string; project_uid?: string },
  ): Promise<Note> {
    const { data } = await this.request("/api/note", "POST", body, { token });
    return { ...(data.note || data),project_uid:body.project_uid };
  }
  async updateProject(token:string,uid:string,body:{name:string;description?:string}):Promise<Project>{const {data}=await this.request(`/api/project/${encodeURIComponent(uid)}`,'PATCH',body,{token});return data.project || data;}
  async project(token: string, name: string): Promise<Project> {
    const { data } = await this.request(
      "/api/project",
      "POST",
      { name },
      { token },
    );
    return data.project || data;
  }
}
