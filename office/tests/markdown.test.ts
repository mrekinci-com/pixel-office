import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, safeLink } from "../src/chat/Markdown.js";

test("A2.4: Markdown renders emphasis, lists, code and safe links without executing HTML", () => {
  const html = renderToStaticMarkup(createElement(Markdown, { text: '**DÜZELTME GEREK**\n\n- İlk\n- `ikinci`\n\n1. Bir\n2. İki\n\n```js\n<script>alert(1)</script>\n```\n\n[Belge](https://example.com)\n[Tehlike](javascript:alert)\n<img src=x onerror=alert(1)>' }));
  assert.match(html, /<strong>DÜZELTME GEREK<\/strong>/);
  assert.match(html, /<ul><li>İlk<\/li><li><code>ikinci<\/code>/);
  assert.match(html, /<ol><li>Bir<\/li><li>İki<\/li>/);
  assert.match(html, /<pre><code>&lt;script&gt;/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.doesNotMatch(html, /<script|<img|href="javascript:/);
  for (const value of ["javascript:alert(1)", "data:text/html,test", "file:///etc/test", "//example.com", "vbscript:test"]) assert.equal(safeLink(value), null);
});
