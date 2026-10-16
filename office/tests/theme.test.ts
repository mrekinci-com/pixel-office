import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync("src/theme.css", "utf8");
const luminance = (hex: string) => {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
};
export const contrast = (a: string, b: string) => {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
for (const theme of ["light", "dark"]) {
  test(`${theme}: text, muted text, states, buttons and selected rows meet 4.5:1 contrast`, () => {
    const block = theme === "light" ? css.slice(css.indexOf(":root {"), css.indexOf("@media")) : css.slice(css.indexOf(':root[data-theme="dark"]'));
    const tokens = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[a-f\d]{6})\s*;/gi)].map((m) => [m[1], m[2]]));
    const pairs: [string, string][] = [];
    for (const fg of ["ink", "ink-2", "ink-3"])
      for (const bg of ["bg", "surface", "surface-2", "sunken"]) pairs.push([fg, bg]);
    pairs.push(["on-accent", "accent"], ["on-accent", "accent-hover"], ["on-danger", "danger"],
      ["accent-text", "accent-soft"], ["side-fg", "side-bg"], ["side-muted", "side-bg"],
      ["side-fg", "side-hover-bg"], ["side-active-fg", "side-active-bg"], ["side-logo", "side-bg"], ["badge-fg", "badge-bg"]);
    for (const status of ["honey", "idle", "working", "waiting", "off", "danger"]) pairs.push([`${status}-text`, `${status}-soft`]);
    for (const [fg, bg] of pairs) {
      assert.ok(tokens[fg] && tokens[bg], `${fg}/${bg} must be defined`);
      const ratio = contrast(tokens[fg], tokens[bg]);
      assert.ok(ratio >= 4.5, `${theme}: ${fg}/${bg} = ${ratio.toFixed(2)}:1`);
    }
    for (const bg of ["surface", "surface-2"]) assert.ok(contrast(tokens.focus, tokens[bg]) >= 3);
    for (const status of ["idle", "working", "waiting", "off"])
      for (const bg of ["surface", "surface-2", "side-bg"])
        assert.ok(contrast(tokens[status], tokens[bg]) >= 3, `${theme}: ${status}/${bg} status dot must meet 3:1 contrast`);
  });
}
test("UI styles contain no fixed colors outside theme tokens", () => {
  for (const path of ["src/style.css", "src/shell.css", "src/theme-controls.css", "src/chat/chat.css", "src/pixel/office.css"])
    assert.doesNotMatch(readFileSync(path, "utf8"), /#[a-f\d]{3,8}\b|(?:rgba?|hsla?)\(|:\s*(?:white|black)\s*;/i, path);
});
