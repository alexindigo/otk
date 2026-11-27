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
      const headingContent = node.querySelector(".otk-tree-frame")!;
      const secondLine = document.createElement("div");
      secondLine.textContent = "Second line";
      secondLine.style.blockSize = "2em";
      secondLine.style.gridArea = "extension / label";
      headingContent.append(secondLine);
      const box = node.querySelector(
        ".otk-tree-trigger .otk-disclosure-icon svg",
      )!
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
    await root.locator(":scope > .otk-tree-heading .otk-disclosure-icon svg")
      .click();
    await expect(root.locator(":scope > .otk-tree-region")).toBeVisible();
    const axes = await root.evaluate((node) => {
      const center = (el: Element) => {
        const { x, width } = el.getBoundingClientRect();
        return x + width / 2;
      };
      const icon = node.querySelector(
        ":scope > .otk-tree-heading .otk-disclosure-lead",
      )!;
      const stem = node.querySelector(
        ":scope > .otk-tree-heading .otk-tree-stem-paint",
      )!;
      const child = node.querySelector(
        ":scope > .otk-tree-region button.otk-tree-trigger .otk-disclosure-icon svg",
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
    await expect(page.locator(".otk-tree-node-slot:empty")).toHaveCount(0);
  });
});

test.describe("sidebar", () => {
  test.use({ profile: "contract-sessions-hierarchy" });
  test("sessions.tree-selection-mark-clears-the-junction", {
    tag: ["@sessions", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    await openSession(state, page, "tstv1-otk");
    const row = page.locator('.otk-session-row[data-session="tstv1-otk"]');
    await expect(row).toHaveAttribute("aria-current", "page");
    const heading = row.locator(
      "xpath=ancestor::*[contains(@class, 'otk-tree-heading')][1]",
    );
    await expect(heading.locator(".otk-tree-selection-mark")).toBeVisible();
    const gaps = await heading.evaluate((node) => {
      const mark = node.querySelector(".otk-tree-selection-mark")!;
      const rail = node.querySelector(".otk-tree-junction")!;
      const box = node.querySelector(
        ".otk-tree-trigger-slot .otk-tree-toggle",
      )!;
      const ruler = document.createElement("span");
      ruler.style.cssText = "position:absolute;inline-size:var(--space-1)";
      node.append(ruler);
      const min = ruler.getBoundingClientRect().width;
      ruler.remove();
      return {
        min,
        box: box.getBoundingClientRect().left -
          mark.getBoundingClientRect().right,
        rail: rail.getBoundingClientRect().left -
          mark.getBoundingClientRect().right,
      };
    });
    expect(gaps.rail).toBeGreaterThanOrEqual(0);
    expect(gaps.box).toBeGreaterThanOrEqual(gaps.min);
  });
});

test.describe("worktrees", () => {
  test.use({ profile: "contract-sessions-worktrees" });
  test("sessions.tree-worktree-elbow-follows-the-project-lamp", {
    tag: ["@sessions", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    await openSession(state, page, "tstv1-otk");
    const parent = page.locator(
      `.otk-project-row[data-project=${JSON.stringify(state.directory)}]`,
    );
    const child = page.locator(
      `.otk-project-row[data-project-parent=${
        JSON.stringify(state.directory)
      }]`,
    ).first();
    const heading = child.locator(
      "xpath=ancestor::div[contains(@class,'otk-tree-heading')][1]",
    );
    const elbow = heading.locator(
      ".otk-tree-junction:is(.is-tee, .is-elbow) .otk-tree-connector",
    );
    await expect(elbow).toBeVisible();
    const [lamp, junction] = await Promise.all([
      parent.locator(".otk-status-light").boundingBox(),
      heading.locator(".otk-tree-junction .otk-tree-upper").boundingBox(),
    ]);
    expect(lamp).not.toBeNull();
    expect(junction).not.toBeNull();
    expect(
      Math.abs(lamp!.x + lamp!.width / 2 - (junction!.x + junction!.width / 2)),
    )
      .toBeLessThanOrEqual(.5);
    expect(junction!.y).toBeGreaterThan(lamp!.y + lamp!.height);
  });
});
