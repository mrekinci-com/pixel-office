import { t as tx } from "./i18n.js";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { readSafe, proposal, sha } from "./files.js";
import { redact } from "./diagnostics.js";
import { toolsForNames } from "./tools.js";
import type { FolderLink } from "../../office/shared/runtime.js";
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  env = process.env,
  fetcher = fetch,
  onNotice?: (notice:string)=>void,
) {
  const available=toolsForNames(env.OFIS_AGENT_TOOLS ? JSON.parse(env.OFIS_AGENT_TOOLS) : undefined);
  if (!available.some((t) => t.name === name)) throw new Error(tx("Araç bulunamadı."));
  if (!/^http:\/\/127\.0\.0\.1:(9400|9401)$/.test(env.OFIS_URL || ""))
    throw new Error(tx("Ofis adresi geçersiz."));
  let files: unknown;
  if (name === "teslim_et" || (["mesaj_gonder", "gorev_devret"].includes(name) && args.dosyalar) || (name === "onay_iste" && !args.baglanti && args.dosyalar))
    files = filePaths(args.dosyalar).map((path) => {
      const bytes = readSafe(env.OFIS_AGENT_WORK!, path);
      return { path, content: bytes.toString("base64"), ...(name === "onay_iste" ? { before_hash: null, after_hash: sha(bytes), diff: "" } : {}) };
    });
  if (name === "onay_iste" && args.baglanti) {
    const links = JSON.parse(env.OFIS_AGENT_LINKS_FILE ? readFileSync(env.OFIS_AGENT_LINKS_FILE, "utf8") : env.OFIS_AGENT_LINKS || "[]") as FolderLink[];
    const l = links.find((l) => l.id === args.baglanti);
    if (!l) throw new Error(tx("Klasör bağlantısı bulunamadı. Atanmış baglanti kimliğini kullanın; sahibe dosya vermek için teslim_et kullanın."));
    files = proposal(env.OFIS_AGENT_WORK!, l, filePaths(args.dosyalar));
  }
  const response = await fetcher(`${env.OFIS_URL}/api/agent-tools/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OFIS_AGENT_KEY}`,
    },
    body: JSON.stringify({ arguments: args, files }),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  const result = (await response.json()) as {
    result?: unknown;
    error?: string;
    notice?: string;
  };
  if (!response.ok)
    throw new Error(result.error || tx("Ofis aracı tamamlanamadı."));
  if(result.notice)onNotice?.(result.notice);
  if (name === "komut_calistir" && (result.result as any)?.komut_is) {
    const id = (result.result as any).komut_is;
    const end = Date.now() + 610000;
    while (Date.now() < end) {
      const status = await fetcher(`${env.OFIS_URL}/api/agent-tools/command-result/${id}`, { headers:{Authorization:`Bearer ${env.OFIS_AGENT_KEY}`},signal:AbortSignal.timeout(10000),redirect:"error" });
      const job = await status.json() as any;
      if (!status.ok) throw new Error(job.error || tx("Komut sonucu alınamadı."));
      if (job.state === "completed") return { cikis_kodu:job.exit_code,cikti:job.output };
      await new Promise(resolve => setTimeout(resolve,250));
    }
    throw new Error(tx("Komut sonucu bekleme süresi doldu."));
  }
  return result.result;
}
function filePaths(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 20 || !value.every((p) => typeof p === "string"))
    throw new Error(tx("dosyalar alanına kendi klasörünüzdeki 1–20 göreli dosya yolunu yazın."));
  return value;
}
export function toolError(name: string, error: unknown, env = process.env) {
  const actions: Record<string, string> = {
    teslim_et: tx("Dosyayı önce kendi çalışma klasörünüzde hazırlayın; dosyalar alanında göreli yolunu verin."),
    onay_iste: tx("Sahibe dosya vermek için teslim_et kullanın. Klasöre yazmak için atanmış baglanti kimliğini ve dosyalar alanını verin; genel onayda ekler isteğe bağlıdır."),
    gorev_devret: tx("Şirket rehberinden alıcı ajanın kimliğini seçin."),
    gorev_durumu: tx("gelen_kutusu ile size devredilen görevin kimliğini alın."),
    tududi_gorev_guncelle: tx("tududi_gorevler ile kendi görevinizin kimliğini alın."),
    mesaj_gonder: tx("Alıcı olarak ajan/bölüm kimliğini, genel veya sahip yazın."),
  };
  const raw = error instanceof Error ? error.message : "";
  const reason = /[çğıöşüÇĞİÖŞÜ]/.test(raw) && !/ENOENT|EACCES|SyntaxError|TypeError/.test(raw)
    ? raw.slice(0, 1000) : tx("Ofis aracı tamamlanamadı. Alanlar, izin veya bağlantı geçersiz olabilir.");
  return redact(reason + " " + (actions[name] || tx("Alanları araç kılavuzuna göre doldurun. Sınır veya bağlantı sorunu varsa durumu sahibe bildirin.")), [env.OFIS_AGENT_KEY || ""]);
}
export function serve() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let serial = Promise.resolve();
  lines.on("line", (line) => {
    serial = serial
      .then(async () => {
        if (line.length > 200000) return;
        let request: any;
        try {
          request = JSON.parse(line);
        } catch {
          return;
        }
        if (request.id === undefined) return;
        const answer = (result: unknown) =>
          process.stdout.write(
            JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
          );
        switch (request.method) {
          case "initialize":
            answer({
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "ofis", version: "0.2.0" },
            });
            break;
          case "ping":
            answer({});
            break;
          case "tools/list":
            {
              try {
                if(!/^http:\/\/127\.0\.0\.1:(9400|9401)$/.test(process.env.OFIS_URL || ""))throw new Error(tx("Ofis adresi geçersiz."));
                const r=await fetch(`${process.env.OFIS_URL}/api/agent-tools/catalog`,{headers:{Authorization:`Bearer ${process.env.OFIS_AGENT_KEY}`},signal:AbortSignal.timeout(10000),redirect:"error"});
                if(!r.ok)throw new Error(tx("Araç yetkisi doğrulanamadı."));
                const catalog=await r.json() as {names:string[]};process.env.OFIS_AGENT_TOOLS=JSON.stringify(catalog.names);answer({tools:toolsForNames(catalog.names)});
              } catch {answer({tools:[]});}
            }
            break;
          case "tools/call":
            try {
              let notice="";
              const result = await callTool(
                request.params.name,
                request.params.arguments || {},
                process.env,fetch,value=>{notice=value;},
              );
              answer({
                content: [{ type: "text", text: JSON.stringify(result) },...(notice?[{type:"text",text:notice}]:[])],
              });
            } catch (error) {
              answer({
                isError: true,
                content: [
                  {
                    type: "text",
                    text: toolError(request.params?.name, error),
                  },
                ],
              });
            }
            break;
          default:
            process.stdout.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                error: { code: -32601, message: tx("Yöntem bulunamadı.") },
              }) + "\n",
            );
        }
      })
      .catch(() => {});
  });
}
if (process.argv[1] && /(?:^|\/)mcp\.(?:ts|js)$/.test(process.argv[1])) serve();
