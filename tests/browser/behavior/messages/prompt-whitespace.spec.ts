// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { messages, prompt, reply, sendPrompt } from "../../pages/composer.ts";
import { clipboard, copied, pick, rightClick } from "../../pages/menus.ts";

test("messages.prompt-preserves-typed-whitespace-and-copy", {
  tag: ["@composer", "@messages"],
}, async ({ state, page }, info) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Multiline prompt",
  });
  const frames = await wire(page);
  await openSession(state, page, session.id);
  await state.product("prefs.set", { key: "theme", value: "otk-dark" });
  await expect(page.locator("html")).toHaveAttribute(
    "data-otk-theme",
    "otk-dark",
  );
  frames.hold((frame, request) =>
    frame.t === "content" && frame.sessionID === session.id ||
    frame.t === "load.chunk" &&
      (frame.data as { kind?: string })?.kind === "message-page" ||
    request?.method === "session.messages"
  );
  const source = "First line\nSecond line\n\n    **Indented third line**";
  const answer = "I received the three lines.";
  const pending = page.locator('[data-role="user"][data-send-state="pending"]');
  const bubbleText = ".otk-user-bubble .otk-text";
  let id: string | null;
  try {
    await state.queue([answer]);
    await prompt(page).fill(source);
    await sendPrompt(page);
    await expect(pending).toBeVisible();
    id = await pending.getAttribute("data-message");
    expect.soft(await pending.locator(bubbleText).innerText()).toBe(source);
  } finally {
    frames.release();
  }
  expect(id).toBeTruthy();
  await expect.poll(async () =>
    (await messages(state, session.id)).find(({ info }) => info.id === id)
      ?.parts.filter(({ type }) => type === "text").map(({ text }) => text)
  ).toEqual([source]);

  const entry = page.locator(`[data-message="${id}"]`);
  const text = entry.locator(bubbleText);
  await expect(entry).toHaveAttribute("data-send-state", "committed");
  expect.soft(await text.innerText()).toBe(source);
  await reply(state, page, session.id, answer);
  await page.reload();
  await expect(text).toBeVisible();
  expect.soft(await text.innerText()).toBe(source);
  await page.screenshot({
    path: info.outputPath("multiline-prompt-dark.png"),
    animations: "disabled",
    fullPage: true,
  });
  await clipboard(page);
  await rightClick(page, text);
  await pick(page, "Copy prompt");
  await copied(page, source);
});
