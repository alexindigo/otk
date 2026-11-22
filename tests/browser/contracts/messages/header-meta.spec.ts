// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";

test.use({ profile: "contract-messages-disclosures" });
test("messages.header-meta-shared-spacing-and-disclosure", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page }) => {
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "hold",
  });
  await openSession(state, page, "tstv1-otk");
  const header = page.locator(".otk-work-log").first();
  const counts = header.locator("[data-record-kind]");
  await expect(counts).toHaveCount(2);
  await expect.soft(page.locator(".otk-turn-time").first()).toHaveText(
    "counting...",
  );
  await expect.soft(page.locator(".otk-turn-time em").first()).toHaveText(
    "counting...",
  );
  await expect.soft(header.locator(".otk-work-label")).not.toContainText(
    "Worked for 0s",
  );
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 1000 });
    const geometry = await header.evaluate((root) => {
      const label = root.querySelector(".otk-work-label")!;
      const counts = Array.from(root.querySelectorAll("[data-record-kind]"));
      const elements = [label, ...counts];
      const rects = elements.map((e) => e.getBoundingClientRect());
      return {
        centres: rects.map((r) => r.y + r.height / 2),
        gaps: rects.slice(1).map((r, i) => r.x - rects[i].right),
        weights: elements.map((e) => getComputedStyle(e).fontWeight),
        pads: counts.map((e) => getComputedStyle(e).paddingInline),
      };
    });
    expect.soft(Math.max(...geometry.centres) - Math.min(...geometry.centres))
      .toBeLessThan(1);
    expect.soft(Math.abs(geometry.gaps[0] - geometry.gaps[1])).toBeLessThan(1);
    expect.soft(geometry.weights).toEqual(["400", "400", "400"]);
    expect.soft(geometry.pads).toEqual(["0px", "0px"]);
  }
  for (const count of await counts.all()) {
    await expect.soft(count.locator(".otk-disclosure-icon")).toBeVisible();
    await expect(count).toHaveAttribute("aria-expanded", "false");
    const closed = await count.locator("path").count();
    await count.click();
    await expect(count).toHaveAttribute("aria-expanded", "true");
    expect.soft(await count.locator("path").count()).toBeLessThan(closed);
  }
});
