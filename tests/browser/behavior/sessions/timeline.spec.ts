// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";

test("sessions.timeline-reveal-focus-actions-copy-rollback-restore-reload", {
  tag: ["@sessions", "@revert"],
}, async ({ state, page, context }) => {
  const s = await state.native<{ id: string }>("/session", "POST", {
    title: "Timeline review",
  });
  await openSession(state, page, s.id);
  const prompts = [
    "Trace the session action owners",
    "Keep the transcript as the only content store",
    "Verify the final consumer outcome",
  ];
  for (const text of prompts) {
    const reply = Array(18).fill(`Response to ${text}.`).join(" ");
    await state.queue([reply]);
    await prompt(page, text);
    await expect(page.locator(".otk-messages")).toContainText(reply);
    await expect(page.locator(`[data-session="${s.id}"]`)).toHaveAttribute(
      "data-status",
      "idle",
    );
  }
  await state.queue(["Timeline compaction summary."]);
  await page.keyboard.press("Control+k");
  await page.locator('[data-command="session.compact"]').click();
  await expect(page.locator(".otk-messages")).toContainText(
    "Timeline compaction summary.",
  );
  await expect(page.locator(".otk-compaction-divider")).toHaveText(
    "Session compacted",
  );
  await page.locator("[data-panel-view=timeline]").click();
  await expect(page.locator("[data-timeline-prompt]")).toHaveCount(3);
  expect(await page.locator(".otk-timeline-preview").allTextContents()).toEqual(
    prompts,
  );
  const ids = await page.locator("[data-timeline-prompt]").evaluateAll((es) =>
    es.map((e) => (e as HTMLElement).dataset.timelinePrompt!)
  );
  for (const id of ids) {
    await page.locator(`[data-timeline-prompt="${id}"] .otk-timeline-reveal`)
      .click();
    const bubble = page.locator(`[data-message="${id}"] .otk-user-bubble`);
    await expect(bubble).toBeFocused();
    await expect.poll(() =>
      bubble.evaluate((e) => {
        const r = e.getBoundingClientRect(),
          v = e.closest(".otk-messages")!.getBoundingClientRect();
        return r.top >= v.top - .5 && r.bottom <= v.bottom + .5;
      })
    ).toBe(true);
  }
  const row = page.locator(`[data-timeline-prompt="${ids[0]}"]`);
  await row.locator(".otk-timeline-reveal").click();
  await expect(row).toHaveClass(/is-selected/);
  expect(
    await row.locator("[data-message-command]").evaluateAll((es) =>
      es.map((e) => (e as HTMLElement).dataset.messageCommand)
    ),
  ).toEqual(["prompt.revert", "prompt.copy"]);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: state.url,
  });
  await row.locator('[data-message-command="prompt.copy"]').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(prompts[0]);
  await row.locator(".otk-timeline-reveal").click({ button: "right" });
  await expect(page.locator('[data-context-command="prompt.revert"]'))
    .toBeVisible();
  expect((await page.getByRole("menuitem").allTextContents()).slice(0, 2))
    .toEqual(["Copy prompt", "Revert to here"]);
  await page.keyboard.press("Escape");
  await row.locator(".otk-timeline-reveal").click();
  await row.locator('[data-message-command="prompt.revert"]').click();
  await expect(page.locator("[data-timeline-prompt]")).toHaveCount(0);
  await expect(page.locator(".otk-rolled-back-strip strong")).toHaveText(
    "4 prompts rolled back",
  );
  await page.locator(".otk-rollback-disclosure").click();
  await page.locator(".otk-rollback-footer button").click();
  await expect(page.locator(".otk-rolled-back-strip")).toHaveCount(0);
  await expect(page.locator("[data-timeline-prompt]")).toHaveCount(3);
  await page.reload();
  await expect(page.locator("[data-timeline-prompt]")).toHaveCount(3);
});

test(
  "sessions.timeline-shared-transcript-earlier-pages-and-project-only-clear",
  { tag: ["@sessions"] },
  async ({ state, page }) => {
    const s = await state.native<{ id: string }>("/session", "POST", {
      title: "Paged prompts",
    });
    for (let i = 0; i < 105; i++) {
      await state.native(`/session/${s.id}/message`, "POST", {
        noReply: true,
        parts: [{ type: "text", text: `Historical prompt ${i}` }],
      });
    }
    const frames = await wire(page);
    await openSession(state, page, s.id);
    await page.locator("[data-panel-view=timeline]").click();
    const pane = page.locator(".otk-timeline");
    await expect.poll(async () =>
      Number(await pane.getAttribute("data-prompt-count"))
    ).toBeGreaterThanOrEqual(20);
    const before = frames.sent.length;
    while (Number(await pane.getAttribute("data-prompt-count")) < 105) {
      const n = Number(await pane.getAttribute("data-prompt-count"));
      await page.locator(".otk-timeline-older").click();
      await expect.poll(async () =>
        Number(await pane.getAttribute("data-prompt-count"))
      ).toBeGreaterThan(n);
    }
    await expect(pane).toHaveAttribute("data-prompt-count", "105");
    await expect(page.locator(".otk-message-flow")).toHaveAttribute(
      "data-message-count",
      "105",
    );
    await expect(page.locator(".otk-timeline-older")).toHaveCount(0);
    expect(
      frames.sent.slice(before).some(({ frame }) =>
        frame.method === "session.messages" && !!frame.params?.before
      ),
    ).toBe(true);
    expect(await page.locator("[data-role=user]").count()).toBeLessThan(105);
    expect(await page.locator("[data-timeline-prompt]").count()).toBeLessThan(
      105,
    );
    await page.locator(".otk-timeline-list").hover();
    await page.mouse.wheel(0, -100000);
    await expect(page.locator(".otk-timeline-preview").first()).toHaveText(
      "Historical prompt 0",
    );
    await page.goto(
      `${state.url}/#project/local/${encodeURIComponent(state.directory)}`,
    );
    await expect(pane).toContainText("Open a session to see its prompts.");
    await expect(page.locator("[data-timeline-prompt]")).toHaveCount(0);
  },
);
