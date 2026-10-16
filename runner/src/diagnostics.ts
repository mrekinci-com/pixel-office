import { t as tx } from "./i18n.js";
import { StringDecoder } from "node:string_decoder";

// Kept only in memory until the complete value is scrubbed (secrets may cross chunks).
export class DiagnosticTail {
  private decoder = new StringDecoder("utf8");
  private value = "";
  private oversized = false;
  add(chunk: Buffer) {
    this.value += this.decoder.write(chunk);
    this.trim();
  }
  private trim() {
    let lines = this.value.split(/\r?\n/);
    if (this.oversized) {
      if (lines.length === 1) { this.value = ""; return; }
      lines.shift();
      this.oversized = false;
    }
    if (lines.at(-1)!.length > 16000) {
      lines[lines.length - 1] = "";
      this.oversized = true;
    }
    lines = lines.slice(-41).map((line) => line.length > 16000 ? tx("Uzun tanı satırı saklanmadı.") : line);
    while (lines.join("\n").length > 16000) lines.shift();
    // Never cut a line in the middle of a key; an oversized line is omitted entirely.
    this.value = lines.join("\n");
  }
  end() {
    this.value += this.decoder.end();
    this.trim();
    return this.value.trim().split("\n").slice(-40).join("\n");
  }
}
export function redact(text: string, secrets: string[] = []) {
  const marker=tx("[gizlendi]");
  let result = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
    result = result.split(secret).join(marker);
  return result
    .replace(/(?:sk-[\w-]{16,}|Bearer\s+[\w.\/-]{8,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)/gi, marker)
    .replace(/(["']?(?:password|secret|api[_-]?key|(?:access|refresh|id)?[_-]?token)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1"+marker);
}
export function diagnose(text: string) {
  if (/ağ erişimi|network access/i.test(text)) return tx("Ağ erişimi güvenli bağlantı hazır olana kadar kapalıdır. Ajanın ağ iznini kapatın.");
  if (/unknown (?:config|field|setting|option)|unrecognized|invalid (?:config|value)|configuration|yapılandırma/i.test(text))
    return tx("Çalıştırıcı ayarları bu sürümle uyumlu değil. Ayarları kontrol edin.");
  if (/rate.limit|quota|429|usage.limit|too many requests|kota/i.test(text))
    return tx("Hesabın kullanım veya hız sınırına ulaşıldı. Bir süre sonra tekrar deneyin.");
  if (/model.*(?:not found|not supported|unavailable|access|does not exist)|model_not_found/i.test(text))
    return tx("Seçilen model bu hesapta kullanılamıyor. Başka bir model seçin.");
  if (/unauthori[sz]ed|authentication|invalid.*(?:token|key)|login|log.in|credentials|401|giriş/i.test(text))
    return tx("Model hesabına giriş yok veya giriş geçersiz. Çalıştırıcı hesabını yeniden bağlayın.");
  if (/mcp.*(?:fail|error|start|timeout|timed out)|ofis.*sunucu/i.test(text))
    return tx("Ofis araçları başlatılamadı. MCP ayarlarını ve Ofis bağlantısını kontrol edin.");
  if (/bwrap|bubblewrap|sandbox|namespace|yalıt|izolasyon/i.test(text))
    return tx("Güvenli çalışma alanı başlatılamadı. Yalıtım ayarlarını kontrol edin.");
  return tx("Komut satırı çalışmayı tamamlayamadı. Çalışma dökümündeki tanıyı kontrol edin.");
}

export function transientStartup(text: string) {
  return /EAGAIN|Resource temporarily unavailable|os error 11|MCP.*(?:failed to start|startup failed|başlatılamadı)|failed to (?:start|spawn).*MCP/im.test(text)
    && !/unauthori[sz]ed|401|unknown config|unrecognized|invalid.*config/i.test(text);
}
