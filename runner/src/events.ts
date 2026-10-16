import { t as tx } from "./i18n.js";
export interface ParsedEvent {
  kind: "text" | "tool" | "turn" | "diagnostic" | "usage";
  text: string;
  final?: boolean;
  completed?: boolean;
  usage?: Record<string, number>;
}
const numericUsage = (value: unknown) =>
  Object.fromEntries(
    Object.entries((value || {}) as Record<string, unknown>).filter(
      ([, n]) => typeof n === "number" && Number.isFinite(n) && n >= 0,
    ),
  ) as Record<string, number>;
export function parseEvent(
  runner: "claude" | "codex",
  value: any,
): ParsedEvent[] {
  if (value.type === "usage" || value.type === "token_count") {
    const usage = value.usage || value.info?.total_token_usage;
    return usage ? [{ kind: "usage", text: tx("Gözlenen kullanım"), usage: numericUsage(usage) }] : [];
  }
  if (runner === "codex") {
    if (value.type === "turn.completed")
      return [
        {
          kind: "turn",
          completed: true,
          text: tx("Tur tamamlandı."),
          usage: numericUsage(value.usage),
        },
      ];
    if (value.type === "item.completed") {
      const i = value.item;
      if (i?.type === "agent_message")
        return [{ kind: "text", text: i.text || "", final: true }];
      if (i?.type === "warning" || i?.type === "error" || /Under-development features enabled/i.test(i?.message || ""))
        return [{ kind: "diagnostic", text: i.message || JSON.stringify(i) }];
      if (i && i.type !== "mcp_tool_call")
        return [{ kind: "tool", text: JSON.stringify(i) }];
    }
    if (value.type === "turn.failed" || value.type === "error")
      throw new Error(value.error?.message || value.message || value.errors?.join("\n") || tx("Model çalışması tamamlanamadı."));
    return [];
  }
  if (
    value.type === "stream_event" &&
    value.event?.type === "content_block_delta" &&
    value.event.delta?.type === "text_delta"
  )
    return [{ kind: "text", text: value.event.delta.text }];
  if (value.type === "assistant")
    return [
      { kind: "turn", text: tx("Model turu.") },
      ...(value.message?.content || [])
        .filter(
          (c: any) =>
            c.type === "tool_use" && !c.name.startsWith("mcp__ofis__"),
        )
        .map((c: any) => ({
          kind: "tool",
          text: JSON.stringify({ name: c.name, input: c.input }),
        })),
    ];
  if (value.type === "result") {
    if (value.is_error) throw new Error(value.error?.message || value.message || value.errors?.join("\n") || tx("Model çalışması tamamlanamadı."));
    return [
      {
        kind: "text",
        text: value.result || "",
        final: true,
        usage: numericUsage(value.usage),
      },
    ];
  }
  return [];
}

// Provider messages differ: Codex turn totals are additive; Claude's result is
// a cumulative run total, while streaming message usage is per assistant message.
export class UsageObserver {
  private totals: Record<string, number> = {};
  private codexCompleted: Record<string, number> = {};
  private messages = new Map<string, Record<string, number>>();
  private current = "";
  private contextInput: number | undefined;
  observe(runner: "codex" | "claude", value: any): Record<string, number> | undefined {
    let changed = false;
    const request = value.info?.last_token_usage || value.last_token_usage;
    if(request && typeof request.input_tokens==='number' && Number.isFinite(request.input_tokens) && request.input_tokens>=0) {
      this.contextInput=request.input_tokens;changed=true;
    }
    if (runner === "codex" && value.type === "turn.completed" && value.usage) {
      for (const [key, n] of Object.entries(numericUsage(value.usage))) {this.codexCompleted[key]=(this.codexCompleted[key] || 0)+n;this.totals[key]=Math.max(this.totals[key] || 0,this.codexCompleted[key]);}
      changed = true;
    } else if (runner === "claude") {
      const event = value.type === "stream_event" ? value.event : value;
      if (event?.type === "message_start") {
        this.current = event.message?.id || `message-${this.messages.size}`;
        this.messages.set(this.current, numericUsage(event.message?.usage)); changed = true;
      } else if (event?.type === "message_delta" && this.current && event.usage) {
        this.messages.set(this.current, { ...this.messages.get(this.current), ...numericUsage(event.usage) }); changed = true;
      } else if (value.type === "assistant" && value.message?.usage) {
        this.current = value.message.id || this.current || `message-${this.messages.size}`;
        this.messages.set(this.current, numericUsage(value.message.usage)); changed = true;
      }
      if (changed && this.messages.has(this.current)) {
        const message=this.messages.get(this.current)!;
        this.contextInput=(message.input_tokens || 0)+(message.cache_read_input_tokens || 0)+(message.cache_creation_input_tokens || 0);
      }
      if (changed) {
        const sums: Record<string, number> = {};
        for (const message of this.messages.values()) for (const [key, n] of Object.entries(message)) sums[key] = (sums[key] || 0) + n;
        for (const [key, n] of Object.entries(sums)) this.totals[key] = Math.max(this.totals[key] || 0, n);
      }
    }
    if ((value.type === "result" || value.type === "usage" || value.type === "token_count") && (value.usage || value.info?.total_token_usage)) {
      for (const [key, n] of Object.entries(numericUsage(value.usage || value.info.total_token_usage))) this.totals[key] = Math.max(this.totals[key] || 0, n);
      changed = true;
    }
    return changed ? { ...this.totals, ...(this.contextInput===undefined ? {} : {context_input_tokens:this.contextInput}) } : undefined;
  }
}
