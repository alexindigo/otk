// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { seed } from "../../pages/attention.ts";
import { prompt, reply } from "../../pages/composer.ts";
import { send } from "../../pages/primary-action.ts";

for (const scenario of ["before", "after", "blur", "normal"] as const) {
  test(`composer.enter-apostrophe-${scenario}`, {
    tag: ["@composer", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    const session = await seed(state, "Composer Enter timing");
    const frames = await wire(page);
    await openSession(state, page, session.id);
    const input = prompt(page);
    await state.queue(["Enter timing witnessed"]);
    const draft = "Check the composer draft";
    await input.fill(draft);
    await expect(send(page)).toBeEnabled();
    const submissions = () =>
      frames.sent.filter(({ frame }) => frame.method === "session.prompt");

    const time = new Date();
    await page.clock.install({ time });
    await page.clock.pauseAt(time.getTime() + 1000);
    // Insert text without a corresponding keydown, as with compose input.
    if (scenario === "before") {
      await page.keyboard.insertText("'");
      await page.clock.runFor(500);
    }
    await input.press("Enter");
    if (scenario === "after") {
      await page.clock.runFor(100);
      await page.keyboard.insertText("'");
    }
    if (scenario === "blur") {
      await input.blur();
      await input.focus();
    }
    await page.clock.runFor(scenario === "normal" ? 249 : 250);
    const apostrophe = scenario === "before" || scenario === "after";
    await expect(input).toHaveValue(draft + (apostrophe ? "'" : ""));
    expect(submissions()).toHaveLength(0);
    if (scenario !== "normal") {
      // Let the previous-apostrophe window expire, then send this same draft.
      if (apostrophe) await page.clock.runFor(800);
      await input.press("Enter");
      await page.clock.runFor(249);
      expect(submissions()).toHaveLength(0);
    }
    await page.clock.runFor(1);
    await expect.poll(() => submissions().length).toBe(1);
    await page.clock.resume();
    await reply(state, page, session.id, "Enter timing witnessed");
    expect(submissions()).toHaveLength(1);
  });
}
