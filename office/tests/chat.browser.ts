import assert from "node:assert/strict";
import type { Page } from "playwright";
import type { Snapshot } from "../shared/types.js";
import { auditScrollbars } from "./chat.audit.js";
import { auditPage, auditFocus } from "./visual.audit.js";

export async function checkChat(page: Page, fixture: Snapshot, update: (snapshot: Snapshot) => void, holdSnapshot: () => () => void) {
  update(fixture);
  const release = holdSnapshot();
  try {
    await page.reload();
    await page.getByText("Sohbet yükleniyor…", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("Mesajınız", { exact: true }).isDisabled(), true);
  } finally { release(); }
  await page.locator(".output-card").waitFor();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    await page.waitForTimeout(250);
    for (const [width, height] of [[1920, 1080], [1366, 768], [1280, 640], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      if (width === 390) await page.getByRole("tab", { name: "Sohbet", exact: true }).click();
      await page.waitForFunction(() => document.querySelector("main")?.getAttribute("aria-busy") !== "true");
      const bars = await auditScrollbars(page);
      if (width !== 390) assert.equal(bars.lists, 2, "Both chat lists scroll independently.");
      await auditPage(page);
      await auditFocus(page.getByLabel("Mesajınız", { exact: true }));
      const field = page.getByLabel("Mesajınız", { exact: true });
      await field.fill("");
      assert.ok((await field.boundingBox())!.height <= 44, "The composer starts with one line.");
      await field.fill(Array.from({ length: 14 }, (_, i) => `Satır ${i}`).join("\n"));
      assert.equal(Math.round((await field.boundingBox())!.height), 180, "The composer scrolls internally after eight lines.");
      await field.fill("");
      await page.getByRole("button", { name: "Devamını göster", exact: true }).click();
      assert.ok(await page.getByText("<img src=x onerror=alert(1)>", { exact: false }).isVisible());
      assert.equal(await page.locator(".message-body img, .message-body script").count(), 0);
      await page.getByRole("button", { name: "Daha az göster", exact: true }).click();
      assert.equal(await page.locator(".message.grouped .message-author").count(), 0);
      assert.equal(await page.locator(".message:not(.mine) .message-receipt").count(), 0);
      assert.equal(await page.locator(".message-author.deleted-author").getByText("Silinmiş ajan", { exact: true }).count(), 1);
      await page.locator(".chat-event").getByRole("button", { name: "Göster", exact: true }).click();
      assert.equal(await page.locator(".event-details > div").count(), 4);
      await page.locator(".chat-event").getByRole("button", { name: "Gizle", exact: true }).click();
      assert.equal(await page.locator(".conversation-heading .chat-stop").count(), 0, "Idle chat has no Stop button.");
      if (width === 390) {
        await page.getByRole("tab", { name: "Ofis", exact: true }).click();
        await auditPage(page);
        await page.getByRole("tab", { name: "Sohbet", exact: true }).click();
      }
    }
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  const log = page.locator(".chat-messages");
  await page.getByLabel("Mesajın alıcısı").selectOption(`agent:${fixture.agents[1].id}`);
  await page.getByText("Henüz mesaj yok. Bir mesaj yazın.", { exact: true }).waitFor();
  await page.getByLabel("Mesajın alıcısı").selectOption("everyone");
  const atEnd = () => log.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  assert.ok(await atEnd() < 2, "Chat opens at the bottom.");
  await page.getByLabel("Mesajınız", { exact: true }).fill("Uzun taslak\n".repeat(12));
  await log.evaluate((el) => { el.scrollTop = 300; });
  await page.waitForTimeout(80);
  const top = await log.evaluate((el) => el.scrollTop);
  fixture.messages.push({ ...fixture.messages.at(-1)!, id: "live-new", artifact_ids: [],
    text: "Yeni gelen mesaj", created_at: "2026-10-10T10:34:00Z" });
  update(fixture);
  await page.getByRole("button", { name: "1 yeni mesaj ↓", exact: true }).waitFor();
  const newButton = (await page.locator(".new-messages").boundingBox())!;
  const compose = (await page.locator(".chat-compose").boundingBox())!;
  assert.ok(newButton.y + newButton.height <= compose.y, "The new-message button does not cover long drafts.");
  assert.ok(Math.abs(await log.evaluate((el) => el.scrollTop) - top) < 2, "New messages preserve the earlier reading position.");
  await page.getByRole("button", { name: "1 yeni mesaj ↓", exact: true }).click();
  assert.ok(await atEnd() < 2);
  await page.getByLabel("Mesajınız", { exact: true }).fill("");
  fixture.messages.push({ ...fixture.messages.at(-1)!, id: "live-at-bottom", text: "En altta yeni mesaj", created_at: "2026-10-10T10:35:00Z" });
  update(fixture);
  await page.getByText("En altta yeni mesaj", { exact: true }).waitFor();
  assert.ok(await atEnd() < 2, "En alttayken yeni mesaj izlenir.");
  assert.equal(await page.locator(".new-messages").count(), 0);
}
