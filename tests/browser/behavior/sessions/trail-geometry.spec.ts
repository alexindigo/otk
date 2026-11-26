// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { cssLength } from "../../pages/css-length.ts";
import { viewByUrl } from "../../pages/sessions.ts";

const root = "tstv1-otk";
const helper = "tstv1-group-a";
const nested = "tstv1-trail-nested";

test.use({
  profile: "contract-sessions-tab-groups",
  viewport: { width: 900, height: 800 },
});

test.beforeEach(async ({ isolatedState: state }) => {
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "hold",
    target: "trail-decisions",
  });
  await state.product("prefs.set", { key: "textSize", value: "125" });
  await state.product("layout.patch", {
    leftCollapsed: false,
    rightCollapsed: false,
  });
});

test("sessions.compact-trail-keeps-complete-crumb-frames", {
  tag: "@sessions",
}, async ({ isolatedState: state, page }) => {
  await viewByUrl(state, page, nested);
  const trail = page.locator(".otk-trail");
  const lane = trail.locator(".otk-overflow-items");
  const current = lane.locator('[aria-current="page"]');
  await expect(current).toHaveAttribute("data-crumb", nested);
  await expect(trail.locator("[data-fit-mode]")).toHaveAttribute(
    "data-fit-mode",
    "scroll",
  );
  await expect(current).toHaveCSS("border-block-end-width", "0px");
  await expect(current).toHaveCSS("box-shadow", "none");
  await expect(current.locator(".otk-trail-title")).toHaveCSS(
    "text-decoration-line",
    "none",
  );
  await expect.poll(() =>
    lane.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      const rows = Array.from(node.querySelectorAll(".otk-trail-link"));
      return rows.map((row) => {
        const link = row.querySelector("[data-crumb]")!;
        const title = link.querySelector(".otk-trail-title")!;
        const box = link.getBoundingClientRect();
        const separator = row.querySelector(".otk-trail-separator")
          ?.getBoundingClientRect();
        return {
          id: link.getAttribute("data-crumb"),
          complete: Math.abs(box.left - bounds.left) <= 0.5 &&
            Math.abs(box.right - bounds.right) <= 0.5,
          visibleSeparator: !!separator && separator.right > bounds.left &&
            separator.left < bounds.right,
          titleFits: title.scrollWidth <= title.clientWidth ||
            getComputedStyle(title).textOverflow === "ellipsis",
        };
      });
    })
  ).toEqual([root, helper, nested].map((id) => ({
    id,
    complete: id === nested,
    visibleSeparator: false,
    titleFits: true,
  })));
  // All ancestors stay keyboard reachable despite the narrow viewport.
  await current.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(lane.locator(`[data-crumb="${helper}"]`)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(current).toHaveAttribute("data-crumb", helper);
  await page.setViewportSize({ width: 1920, height: 800 });
  await expect(trail.locator("[data-fit-mode]")).toHaveAttribute(
    "data-fit-mode",
    "full",
  );
  await expect(
    lane.locator(".otk-trail-link").first().locator(".otk-trail-separator"),
  )
    .toHaveCount(0);
  await expect(
    lane.locator(".otk-trail-link").last().locator(".otk-trail-separator"),
  )
    .toBeVisible();
  await lane.locator(`[data-crumb="${root}"]`).click();
  await expect(current).toHaveAttribute("data-crumb", root);
});

test("sessions.subagent-bar-only-navigates-siblings", {
  tag: "@sessions",
}, async ({ isolatedState: state, page }) => {
  await viewByUrl(state, page, helper);
  const bar = page.locator(".otk-subagent-bar");
  await expect(bar.getByRole("button", { name: "Prev", exact: true }))
    .toBeVisible();
  const controlSize = await cssLength(bar, "--control-size");
  const geometry = await bar.evaluate((node) => ({
    height: node.getBoundingClientRect().height,
    centers: Array.from(node.querySelectorAll("button"), (button) => {
      const box = button.getBoundingClientRect();
      return box.top + box.height / 2;
    }),
  }));
  expect.soft(geometry.height).toBeLessThanOrEqual(controlSize + 1);
  expect.soft(Math.max(...geometry.centers) - Math.min(...geometry.centers))
    .toBeLessThanOrEqual(1);
  await expect.soft(bar).not.toContainText(/Subagent:|Parent/);
  await expect(bar.getByRole("button")).toHaveCount(2);
  const current = page.locator('.otk-trail [aria-current="page"]');
  await bar.getByRole("button", { name: "Next", exact: true }).click();
  await expect(current).not.toHaveAttribute("data-crumb", helper);
  await bar.getByRole("button", { name: "Prev", exact: true }).click();
  await expect(current).toHaveAttribute("data-crumb", helper);
  await viewByUrl(state, page, nested);
  await expect(current).toHaveAttribute("data-crumb", nested);
  await expect(bar).toHaveCount(0);
});
