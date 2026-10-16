import assert from "node:assert/strict";
import type { Page } from "playwright";

export async function auditScrollbars(page: Page) {
  const result = await page.evaluate(() => {
    const errors: string[] = [];
    let scrollAreas = 0, lists = 0;
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      if (!el.checkVisibility({ checkVisibilityCSS: true }) || !el.clientHeight) continue;
      const style = getComputedStyle(el);
      if (!/(auto|scroll)/.test(style.overflowY) || el.scrollHeight <= el.clientHeight + 1) continue;
      scrollAreas++;
      if (CSS.supports("selector(::-webkit-scrollbar)")) {
        const bar = getComputedStyle(el, "::-webkit-scrollbar");
        const button = getComputedStyle(el, "::-webkit-scrollbar-button");
        const track = getComputedStyle(el, "::-webkit-scrollbar-track");
        if (parseFloat(bar.width) < 6 || parseFloat(bar.width) > 8 || style.scrollbarWidth !== "auto") errors.push(`Scrollbar is not thin: ${el.className}`);
        const gutter = el.offsetWidth - el.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
        if (gutter < 6 || gutter > 8) errors.push(`Scrollbar is not visibly sized: ${el.className} (${gutter}px)`);
        if (button.display !== "none" || parseFloat(button.height) !== 0) errors.push(`Scrollbar arrows remain: ${el.className}`);
        if (track.backgroundColor !== "rgba(0, 0, 0, 0)") errors.push(`Scrollbar track is not transparent: ${el.className}`);
      } else if (style.scrollbarWidth !== "thin" || style.scrollbarColor === "auto") errors.push(`Themed scrollbar is missing: ${el.className}`);
      if (el.matches(".scroll-list")) {
        lists++;
        const rect = el.getBoundingClientRect();
        const rows = [...el.querySelectorAll<HTMLElement>(".nav-item")].map((row) => row.getBoundingClientRect());
        const partial = rows.filter((row) => (row.top < rect.top - 1 && row.bottom > rect.top + 1)
          || (row.top < rect.bottom - 1 && row.bottom > rect.bottom + 1));
        if (partial.length && (style.maskImage === "none" || (el.dataset.fadeBottom !== "true" && el.dataset.fadeTop !== "true"))) errors.push(`Partially clipped item has no fade: ${el.id}`);
        if (rows.length >= 3 && rect.height + 1 < rows[2].bottom - rows[0].top)
          errors.push(`Insufficient room for three items: ${el.id} (${rect.height})`);
      }
    }
    const log = document.querySelector<HTMLElement>(".chat-messages");
    if (log && log.checkVisibility()) {
      const right = log.getBoundingClientRect().right;
      for (const bubble of log.querySelectorAll<HTMLElement>(".message-bubble")) {
        const box = bubble.getBoundingClientRect();
        if (right - box.right < 12) errors.push("Bubble touches the scrollbar.");
      }
    }
    const notices = document.querySelector<HTMLElement>(".runtime-alerts");
    if (document.querySelector(".office-page") && notices) {
      const box = notices.getBoundingClientRect();
      for (const heading of document.querySelectorAll<HTMLElement>(".conversation-heading, .scene-heading")) {
        if (!heading.checkVisibility()) continue;
        const rect = heading.getBoundingClientRect();
        if (rect.x < box.right && rect.right > box.x && rect.y < box.bottom && rect.bottom > box.y)
          errors.push("Notification covers the chat or office heading.");
      }
    }
    return { errors, scrollAreas, lists };
  });
  assert.deepEqual(result.errors, [], result.errors.join("\n"));
  return result;
}
