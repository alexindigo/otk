// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, throughDuration, wire } from "../../fixtures/wire.ts";
import type { LoadCoverage } from "@otk/protocol";

test.use({ profile: "contract-messages-return-anchor" });
test("messages.latest-supersedes-an-older-return-anchor-acquisition", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page }) => {
  const values = await state.observe<
    { coolms: number; target: string; away: string }
  >();
  const frames = await wire(page);
  await openSession(state, page, values.target);
  const pane = page.getByRole("region", { name: "Transcript", exact: true });
  const rect = await pane.boundingBox();
  await page.mouse.move(rect!.x + 10, rect!.y + rect!.height / 2);
  for (
    let n = 0;
    n < 24 &&
    !await pane.getByText("Return prompt 0", { exact: true }).isVisible();
    n++
  ) {
    await page.mouse.wheel(0, -5000);
    await page.waitForTimeout(80);
  }
  await expect(pane.getByText("Return prompt 0", { exact: true }))
    .toBeVisible();
  await page.goto(state.url + "/#/local/" + values.away);
  await expect(pane.getByText("Return prompt 0", { exact: true })).toHaveCount(
    0,
  );
  // Wait the fixture's real configured cooling interval, not a fabricated
  // transcript reset. Returning must acquire the newest page again.
  await page.waitForTimeout(values.coolms * 4);
  frames.hold((frame, request) => {
    const load = frame.load as LoadCoverage | undefined;
    return (request?.method === "session.messages" &&
      !!(request.params as { before?: string }).before) ||
      frame.t === "load.chunk" && load?.boundary.kind === "page" &&
        !!load.boundary.before;
  });
  const before = frames.sent.length;
  await page.goto(state.url + "/#/local/" + values.target);
  await expect.poll(() => frames.held.length).toBeGreaterThan(0);
  expect(
    frames.sent.slice(before).some(({ frame }) =>
      frame.t === "request" && frame.method === "session.messages" &&
      !(frame.params as { before?: string }).before
    ),
  ).toBe(true);
  await page.keyboard.press("Control+k");
  await page.getByRole("textbox", { name: "Find a command" }).fill(
    "Jump to latest",
  );
  await page.locator('[data-command="transcript.latest"]').click();
  const gap = () =>
    pane.evaluate((node) =>
      node.scrollHeight - node.clientHeight - node.scrollTop
    );
  await expect.poll(gap).toBeLessThanOrEqual(1);
  frames.release();
  await throughDuration(600, async () => {
    expect(await gap()).toBeLessThanOrEqual(1);
  });
});
