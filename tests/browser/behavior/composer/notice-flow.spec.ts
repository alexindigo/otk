// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/composer.ts";

test.use({ profile: "composer-submission" });
test("composer.notice-flow-keeps-transcript-tail-uncovered", {
  tag: ["@composer", "@messages", "@contracts"],
}, async ({ isolatedState: state, page }, info) => {
  test.setTimeout(120_000);
  await wire(
    page,
    (frame) =>
      frame.method === "session.command"
        ? {
          ...frame,
          params: { ...frame.params, command: "missing-notice-probe" },
        }
        : frame,
  );
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Composer notice flow",
  });
  await openSession(state, page, session.id);
  const text = Array.from(
    { length: 30 },
    (_, i) =>
      `Transcript line ${
        i + 1
      }: the latest reply remains above composer feedback.`,
  ).join("\n\n");
  await state.queue([text]);
  await prompt(page).fill("Show the transcript before a refused command.");
  await prompt(page).press("Enter");
  await expect(page.locator("[data-role=assistant] .otk-text"))
    .toContainText("Transcript line 30:");
  await expect(page.locator(`[data-session="${session.id}"]`))
    .toHaveAttribute("data-status", "idle");
  await expect.poll(async () =>
    (await state.observe<{ active: number }>()).active
  ).toBe(0);
  await prompt(page).fill("/probe retain this draft");
  await prompt(page).press("Enter");
  const notice = page.locator(".otk-composer-notice");
  await expect(notice).toBeVisible();
  await expect(prompt(page)).toHaveValue("/probe retain this draft");
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await expect.poll(() =>
        page.evaluate(() => {
          const viewport = document.querySelector(".otk-transcript-viewport")!;
          const messages = document.querySelector(".otk-messages")!;
          const dock = document.querySelector(".otk-composer-dock")!;
          const notice = document.querySelector(".otk-composer-notice")!;
          const v = viewport.getBoundingClientRect();
          const d = dock.getBoundingClientRect();
          const n = notice.getBoundingClientRect();
          const covered: string[] = [];
          for (let x = 0; x < 12; x++) {
            for (let y = 0; y < 12; y++) {
              const hit = document.elementFromPoint(
                v.left + v.width * (x + .5) / 12,
                v.top + v.height * (y + .5) / 12,
              );
              if (!hit || !viewport.contains(hit)) {
                covered.push(hit?.className ?? "none");
              }
            }
          }
          return {
            dockAfterTranscript: d.top >= v.bottom - .5,
            noticeAfterTranscript: n.top >= v.bottom - .5,
            tailDistance: Math.abs(
              messages.scrollHeight - messages.clientHeight -
                messages.scrollTop,
            ),
            covered,
          };
        })
      ).toMatchObject({
        dockAfterTranscript: true,
        noticeAfterTranscript: true,
        tailDistance: expect.any(Number),
        covered: [],
      });
      await expect.poll(() =>
        page.locator(".otk-messages").evaluate((el) =>
          Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop)
        )
      ).toBeLessThanOrEqual(1);
      if (width === 1440) {
        // Same fixture, data and viewport: reproduce only the retired notice
        // positioning for the spatial before/after review, then restore it.
        const previous = await page.addStyleTag({
          content: `.otk-composer-feedback {
            position: absolute; inline-size: auto;
            inset-inline: var(--lane-gutter); inset-block-end: 100%;
            max-block-size: max(0px, calc(100cqh - 100%));
          }`,
        });
        try {
          await info.attach(`m1-notice-before-${theme}`, {
            body: await page.screenshot({ fullPage: true }),
            contentType: "image/png",
          });
        } finally {
          await previous.evaluate((el) => {
            el.parentNode?.removeChild(el);
          });
        }
        await expect.poll(() =>
          page.locator(".otk-messages").evaluate((el) =>
            Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop)
          )
        ).toBeLessThanOrEqual(1);
        await info.attach(`m1-notice-flow-${theme}`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png",
        });
      }
    }
  }
});
