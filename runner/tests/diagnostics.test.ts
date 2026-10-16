import { test } from "node:test";
import assert from "node:assert/strict";
import { DiagnosticTail, redact, diagnose } from "../src/diagnostics.js";
import { parseEvent } from "../src/events.js";
import { toolError } from "../src/mcp.js";
test("Diagnostics queue is bounded; split UTF-8 and secrets are redacted after reassembly", () => {
  const tail = new DiagnosticTail();
  tail.add(Buffer.from(Array.from({ length: 70 }, (_, i) => `Satır ${i}`).join("\n") + "\n"));
  const bytes = Buffer.from('Türkçe bilinen-anahtar access_token="çok-gizli-değer" sk-abcdefghijklmnopqrstuv');
  for (const byte of bytes) tail.add(Buffer.from([byte]));
  const text = redact(tail.end(), ["bilinen-anahtar"]);
  assert.ok(text.split("\n").length <= 40);
  assert.ok(text.includes("Türkçe"));
  for (const secret of ["bilinen-anahtar", "çok-gizli-değer", "sk-abcdefghijklmnopqrstuv"]) assert.ok(!text.includes(secret));
  for (const [input, expected] of [
    ["unknown field foo", /ayarları/], ["401 invalid token", /giriş/], ["model not supported", /model/],
    ["429 rate limit", /sınır/], ["bwrap namespace failed", /alanı/], ["MCP server failed", /araçları/],
  ] as const) assert.match(diagnose(input), expected);
});
test("Development warnings do not count as tools; tool errors provide guidance", () => {
  const event = parseEvent("codex", { type: "item.completed", item: { type: "warning", message: "Under-development features enabled" } });
  assert.equal(event[0].kind, "diagnostic");
  assert.match(toolError("onay_iste", new Error("ENOENT")), /teslim_et/);
  assert.match(toolError("gorev_durumu", new Error("Geçersiz görev")), /gelen_kutusu/);
});
