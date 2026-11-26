// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";

test.describe("tall heading", () => {
  test.use({ profile: "contract-messages-disclosures" });
  test("sessions.tree-junction-follows-the-first-line-of-a-tall-heading", {
    tag: ["@sessions", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    await openSession(state, page, "tstv1-otk");
    const heading = page.locator(".otk-work-log .otk-tree-heading").first();
    await expect(heading.locator(".otk-work-label")).toBeVisible();
    // Append a second heading line without changing the junction's styles.
    const geometry = await heading.evaluate((node) => {
      const label = node.querySelector(".otk-work-label")!;
      const headingContent = node.querySelector(".otk-tree-label")!;
      const secondLine = document.createElement("div");
      secondLine.textContent = "Second line";
      secondLine.style.blockSize = "2em";
      headingContent.append(secondLine);
      const box = node.querySelector(".otk-tree-toggle")!
        .getBoundingClientRect();
      const line = label.getClientRects()[0];
      const row = node.getBoundingClientRect();
      return {
        offset: Math.abs(box.top + box.height / 2 - line.top - line.height / 2),
        height: row.height,
        lineHeight: line.height,
      };
    });
    expect(geometry.height).toBeGreaterThan(2 * geometry.lineHeight);
    expect(geometry.offset).toBeLessThanOrEqual(1);
  });
});

test.describe("work log", () => {
  test.use({ profile: "contract-messages-disclosures" });
  test("sessions.tree-disclosure-has-artwork-on-the-child-axis", {
    tag: ["@sessions", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    await openSession(state, page, "tstv1-otk");
    const root = page.locator(".otk-work-log > .otk-tree-node").first();
    await root.locator(":scope > .otk-tree-heading .otk-tree-toggle").click();
    await expect(root.locator(":scope > .otk-tree-body")).toBeVisible();
    const axes = await root.evaluate((node) => {
      const center = (el: Element) => {
        const { x, width } = el.getBoundingClientRect();
        return x + width / 2;
      };
      const icon = node.querySelector(
        ":scope > .otk-tree-heading .otk-tree-icon-art",
      )!;
      const stem = node.querySelector(
        ":scope > .otk-tree-heading .otk-tree-icon-stem",
      )!;
      const child = node.querySelector(
        ":scope > .otk-tree-body .otk-tree-toggle",
      )!;
      return {
        art: icon.childElementCount,
        icon: center(icon),
        stem: center(stem),
        child: center(child),
      };
    });
    expect.soft(axes.art).toBeGreaterThanOrEqual(1);
    expect(Math.abs(axes.stem - axes.icon)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(axes.stem - axes.child)).toBeLessThanOrEqual(0.5);
    await expect(page.locator(".otk-tree-icon-art:empty")).toHaveCount(0);
  });
});
