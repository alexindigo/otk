// SPDX-License-Identifier: LGPL-3.0-only
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { expect } from "../../fixtures/evidence.ts";
import { seed } from "../../pages/attention.ts";
import { openSession, wire } from "../../fixtures/wire.ts";

test.use({ profile: "sessions-tasks" });

test("composer.send-admission-independent-of-phantom-promotion", {
  tag: ["@composer", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const session = await seed(state, "Send without tab promotion");
  const wireState = await wire(page);
  wireState.hold((frame, request) =>
    frame.t === "request.result" && request?.method === "tasks.create"
  );
  try {
    await openSession(state, page, session.id);
    await state.queue(["Independent Send reached native"]);
    const input = page.locator("textarea[name=prompt]");
    await input.fill("Send while the task result is held");
    await input.press("Enter");
    await expect.poll(() => wireState.held.length).toBe(1);
    await expect(
      page.getByText("Independent Send reached native", { exact: true }),
    )
      .toBeVisible();
    expect(
      wireState.sent.filter(({ frame }) => frame.method === "session.prompt"),
    )
      .toHaveLength(1);
  } finally {
    wireState.release();
  }
});
