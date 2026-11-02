// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";

test.use({ profile: "messages-tools" });
test("messages.response-progress-motion-completion-interruption", {
  tag: ["@messages", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Response progress",
  });
  await state.product("prefs.set", { key: "animationsOff", value: false });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openSession(state, page, session.id);
  await expect(page.locator(".otk-response-progress")).toHaveCount(0);
  await state.queue(["An earlier reply is finished."]);
  await prompt(page, "Give me a short reply");
  await expect(page.locator(".otk-messages")).toContainText(
    "An earlier reply is finished.",
  );
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  const held = await state.controller.call<{ gate: string }>("queueScript", {
    lease: state.lease.lease,
    chunks: [
      "The response is still arriving.",
      "\n\nMore content follows here.",
    ],
    delay: 100,
    gate: "held",
  });
  await prompt(page, "Continue with a longer response");
  await expect(page.locator("[data-role=assistant]")).toHaveCount(2);
  await expect(
    page.locator("[data-role=assistant] .otk-message-content").last(),
  ).toContainText("More content follows here.");
  await expect(page.locator(".otk-response-progress")).toHaveCount(1);
  const geometry = await page.evaluate(() => {
    const articles = Array.from(
        document.querySelectorAll("[data-role=assistant]"),
      ),
      article = articles.at(-1)!,
      content = article.querySelector(".otk-message-content")!,
      progress = content.querySelector(".otk-response-progress")!,
      glimmer = progress.querySelector(".otk-response-glimmer")!,
      rect = progress.getBoundingClientRect(),
      previous = progress.previousElementSibling!.getBoundingClientRect(),
      footer = article.querySelector("footer")!.getBoundingClientRect();
    return {
      bottom: content.lastElementChild === progress &&
        rect.top >= previous.bottom && rect.bottom <= footer.top,
      flow: getComputedStyle(progress).position,
      width: glimmer.getBoundingClientRect().width,
      contentWidth: content.getBoundingClientRect().width,
      height: glimmer.getBoundingClientRect().height,
      visible: rect.top >= 0 && rect.bottom <= innerHeight,
      role: progress.getAttribute("role"),
      name: progress.getAttribute("aria-label"),
      previous: articles[0].querySelectorAll(".otk-response-progress").length,
    };
  });
  expect(geometry.bottom && geometry.visible, JSON.stringify(geometry)).toBe(
    true,
  );
  expect(geometry.flow).toBe("static");
  expect(geometry.width).toBe(geometry.contentWidth);
  expect(geometry.height).toBe(2);
  expect([geometry.role, geometry.name, geometry.previous]).toEqual([
    "status",
    "Response in progress",
    0,
  ]);
  const glimmer = page.locator(".otk-response-glimmer"),
    text = page.locator(".otk-response-progress-text");
  const position = await glimmer.evaluate((element) =>
    getComputedStyle(element).backgroundPosition
  );
  await expect.poll(() =>
    glimmer.evaluate((element) => getComputedStyle(element).backgroundPosition)
  ).not.toBe(position);
  const staticVisible = async () => {
    await expect(glimmer).toHaveCSS("display", "none");
    await expect(glimmer).toHaveCSS("animation-name", "none");
    await expect(text).toHaveCSS("display", "flex");
    expect(
      await text.evaluate((element) => element.getBoundingClientRect().height),
    ).toBe(20);
    await expect(text).toHaveText("response in progress");
  };
  await page.emulateMedia({ reducedMotion: "reduce" });
  await staticVisible();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await state.product("prefs.set", { key: "animationsOff", value: true });
  await staticVisible();
  await page.reload();
  await staticVisible();
  await state.product("prefs.set", { key: "animationsOff", value: false });
  await expect(glimmer).not.toHaveCSS("display", "none");
  await expect(text).toHaveCSS("display", "none");
  await state.release(held.gate);
  await expect(page.locator(".otk-messages")).toContainText(
    "The response is still arriving.More content follows here.",
  );
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await expect(page.locator(".otk-response-progress")).toHaveCount(0);
  await state.controller.call("queueScript", {
    lease: state.lease.lease,
    chunks: [],
    tool: {
      name: "bash",
      input: { command: "pwd", description: "Read project directory" },
    },
  });
  const continued = await state.queue(
    ["The next step is still streaming."],
    "held",
  );
  await prompt(page, "Read the directory, then explain");
  await expect(page.locator("[data-role=assistant] .otk-text").last())
    .toHaveText("The next step is still streaming.");
  await expect(page.locator(".otk-response-progress")).toHaveCount(1);
  expect(
    await page.locator("[data-role=assistant]").last().evaluate((article) =>
      !!article.querySelector("[data-tool=bash]") &&
      !!article.querySelector(".otk-message-content")!.lastElementChild
        ?.matches(".otk-response-progress")
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator(".otk-response-progress")).toHaveCount(0);
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await expect(page.locator("[data-role=assistant] footer").last())
    .toContainText("interrupted");
  await state.release(continued.gate);
});
