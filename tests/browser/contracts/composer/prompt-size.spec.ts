// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import {
  chips,
  messages,
  pasteText,
  prompt,
  reply,
  viewing,
} from "../../pages/composer.ts";
import type { Page } from "@playwright/test";

const lines = (count: number) =>
  Array.from({ length: count }, (_, i) => `Draft line ${i + 1}`).join("\n");
const measure = (page: Page) =>
  prompt(page).evaluate((element) => {
    const input = element as HTMLTextAreaElement,
      style = getComputedStyle(input),
      rect = input.getBoundingClientRect();
    const footer = document.querySelector(".otk-prompt-actions")!
        .getBoundingClientRect(),
      composer = document.querySelector(".otk-composer")!,
      box = composer.getBoundingClientRect();
    const mirror = document.createElement("div"),
      caret = document.createElement("span");
    Object.assign(mirror.style, {
      width: rect.width + "px",
      font: style.font,
      letterSpacing: style.letterSpacing,
      whiteSpace: "pre-wrap",
      overflowWrap: style.overflowWrap,
      wordBreak: style.wordBreak,
    });
    mirror.textContent = input.value.slice(0, input.selectionEnd);
    caret.textContent = "\u200b";
    mirror.append(caret);
    document.body.append(mirror);
    const mr = mirror.getBoundingClientRect(),
      cr = caret.getBoundingClientRect();
    const caretTop = cr.top - mr.top - input.scrollTop,
      caretBottom = cr.bottom - mr.top - input.scrollTop;
    mirror.remove();
    return {
      height: input.clientHeight,
      scrollHeight: input.scrollHeight,
      scrollTop: input.scrollTop,
      caretTop,
      caretBottom,
      lineHeight: parseFloat(style.lineHeight),
      resize: style.resize,
      bottom: rect.bottom,
      footerTop: footer.top,
      footerBottom: footer.bottom,
      composerTop: box.top,
      composerBottom: box.bottom,
      transcriptBottom:
        document.querySelector(".otk-messages")!.getBoundingClientRect().bottom,
      composerScroll: composer.scrollTop,
      documentScroll: document.scrollingElement!.scrollTop,
      viewport: innerHeight,
    };
  });
test("composer.native-grow-cap-caret-shrink-wrap-editor-send-and-takeover", {
  tag: "@composer",
}, async ({ state, page }, info) => {
  test.setTimeout(120_000);
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Growing prompt",
  });
  await state.product("prefs.set", { key: "animationsOff", value: true });
  const frames = await wire(page);
  await openSession(state, page, session.id);
  await expect(page.locator(".otk-composer-model-name")).toHaveText("scripted");
  await viewing(page, frames, session.id);
  await page.evaluate(() => document.fonts.ready);
  const empty = await measure(page), growing = [];
  expect(empty.height).toBe(48);
  await prompt(page).focus();
  await page.keyboard.insertText("Draft line 1");
  for (let n = 1; n <= 14; n++) {
    if (n > 1) {
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.insertText(`Draft line ${n}`);
    }
    await expect(prompt(page)).toHaveValue(lines(n));
    await expect.poll(async () => {
      const state = await measure(page);
      return state.height === Math.min(240, Math.max(48, n * 24)) &&
        state.caretTop >= 0 && state.caretBottom <= state.height;
    }).toBe(true);
    const geometry = await measure(page);
    growing.push(geometry);
    expect(geometry.lineHeight).toBe(24);
    expect(geometry.resize).toBe("none");
    expect(geometry.composerBottom).toBe(empty.composerBottom);
    expect(geometry.footerTop).toBe(empty.footerTop);
    expect(geometry.footerBottom).toBe(empty.footerBottom);
    expect(geometry.composerTop).toBe(
      empty.composerTop - (geometry.height - empty.height),
    );
    expect(Math.abs(geometry.transcriptBottom - geometry.composerTop))
      .toBeLessThan(.5);
    expect(geometry.footerTop).toBeGreaterThanOrEqual(geometry.bottom);
    expect(geometry.footerBottom).toBeLessThan(geometry.viewport);
    expect([geometry.composerScroll, geometry.documentScroll]).toEqual([0, 0]);
    if (n >= 11) {
      expect(geometry.scrollHeight).toBeGreaterThan(geometry.height);
      expect(geometry.scrollTop).toBeGreaterThan(0);
    }
  }
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  await expect(prompt(page)).toHaveValue("");
  await expect.poll(async () => (await measure(page)).height).toBe(
    empty.height,
  );
  await info.attach("native-textarea-geometry", {
    body: JSON.stringify({ empty, growing, deleted: await measure(page) }),
    contentType: "application/json",
  });
  await prompt(page).fill(
    "The composer follows the draft as its words wrap across the available lane. "
      .repeat(4),
  );
  const wide = await measure(page);
  await page.setViewportSize({ width: 1060, height: 800 });
  await expect.poll(async () => (await measure(page)).height).toBeGreaterThan(
    wide.height,
  );
  expect((await measure(page)).height).toBeLessThanOrEqual(240);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => (await measure(page)).height).toBe(wide.height);
  await page.getByRole("button", { name: "Edit prompt", exact: true }).click();
  await page.locator("textarea[name=editor]").fill(lines(4));
  await page.locator(".otk-editor footer button").last().click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(prompt(page)).toHaveValue(lines(4));
  await expect.poll(async () => (await measure(page)).height).toBe(96);
  await state.queue(["Growing draft received."]);
  await page.locator(".otk-prompt button[type=submit]").click();
  await expect(prompt(page)).toHaveValue("");
  await expect.poll(async () => (await measure(page)).height).toBe(48);
  await reply(state, page, session.id, "Growing draft received.");
  expect(
    (await messages(state, session.id)).some((row) =>
      row.info.role === "user" &&
      row.parts.some((p) => p.type === "text" && p.text === lines(4))
    ),
  ).toBe(true);
  await prompt(page).fill(lines(14));
  await prompt(page).press("Control+End");
  await pasteText(page, lines(200));
  await expect(chips(page)).toContainText("200 lines");
  const retained = await prompt(page).inputValue();
  await expect.poll(async () => (await measure(page)).height).toBe(240);
  await chips(page).locator("button").first().click();
  await expect(page.locator("textarea[name=editor]")).toHaveValue(lines(200));
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await state.controller.call("queueScript", {
    lease: state.lease.lease,
    chunks: [],
    tool: {
      name: "bash",
      input: {
        command: "printf u13-takeover",
        description: "Expanded draft takeover",
      },
    },
  });
  await state.queue(["Takeover completed."]);
  await state.native(`/session/${session.id}/prompt_async`, "POST", {
    parts: [{
      type: "text",
      text:
        "Exercise the takeover without submitting the retained browser draft",
    }],
  });
  await expect(page.locator(".otk-permission-command")).toHaveText(
    "printf u13-takeover",
  );
  await expect(page.locator(".otk-composer")).toBeHidden();
  await page.locator(".otk-permission-actions > button").first().click();
  await reply(state, page, session.id, "Takeover completed.");
  await expect(page.locator(".otk-composer")).toBeVisible();
  await expect(prompt(page)).toHaveValue(retained);
  await expect.poll(async () => (await measure(page)).height).toBe(240);
  await expect(chips(page)).toContainText("200 lines");
  await chips(page).getByRole("button", { name: /^Remove/ }).click();
  await expect(chips(page)).toHaveCount(0);
  await expect.poll(async () => (await measure(page)).height).toBe(240);
  await state.queue(["Expanded draft received."]);
  await page.locator(".otk-prompt button[type=submit]").click();
  await expect(prompt(page)).toHaveValue("");
  await expect.poll(async () => (await measure(page)).height).toBe(48);
  await reply(state, page, session.id, "Expanded draft received.");
});
