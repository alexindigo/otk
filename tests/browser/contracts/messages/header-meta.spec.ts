// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openLatestWork } from "../../pages/transcript.ts";
import { openSession } from "../../fixtures/wire.ts";
import type { Locator } from "@playwright/test";

function headerGeometry(root: Element) {
  const work = root.matches(".otk-work-recorded-meta");
  const label = root.querySelector(
    work
      ? ":scope > .otk-chrome-meta"
      : ".otk-record-group-toggle .otk-disclosure-label",
  )!;
  const caption = work ? undefined : label.closest(".otk-disclosure-caption")!;
  const counts = Array.from(root.querySelectorAll("[data-record-kind]"));
  const meta = counts[0].closest(".otk-meta-row")!;
  const controls = counts.map((element) => {
    const r = element.getBoundingClientRect();
    let left = 0, right = innerWidth;
    for (
      let parent = element.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      if (/hidden|clip|auto|scroll/.test(getComputedStyle(parent).overflowX)) {
        const p = parent.getBoundingClientRect();
        left = Math.max(left, p.left);
        right = Math.min(right, p.right);
      }
    }
    const absent = !element.checkVisibility({ visibilityProperty: true }) ||
      !r.width || !r.height;
    return {
      absent,
      whole: r.left >= left - 0.5 && r.right <= right + 0.5,
      textFits: element.scrollWidth <= element.clientWidth + 1,
    };
  });
  const elements = [
    label,
    ...counts.filter((_, index) => !controls[index].absent),
  ];
  const rects = elements.map((element) => element.getBoundingClientRect());
  const slots = rects.slice(1);
  return {
    controls,
    centres: rects.map((r) => r.y + r.height / 2),
    trailGap: slots.length ? slots[0].left - rects[0].right : null,
    captionSpace: caption
      ? caption.getBoundingClientRect().right - rects[0].right
      : parseFloat(getComputedStyle(root).columnGap),
    captionPadding: caption
      ? parseFloat(getComputedStyle(caption).paddingInlineEnd)
      : 0,
    gaps: slots.slice(1).map((r, i) => r.left - slots[i].right),
    slotGap: parseFloat(getComputedStyle(meta).columnGap),
    weights: elements.map((element) => getComputedStyle(element).fontWeight),
    pads: counts.map((element) => getComputedStyle(element).paddingInline),
  };
}

async function expectHeader(header: Locator, width: number) {
  await expect.poll(async () => {
    const geometry = await header.evaluate(headerGeometry);
    return geometry.controls.every((control) =>
      control.absent || control.whole && control.textFits
    );
  }).toBe(true);
  const geometry = await header.evaluate(headerGeometry);
  expect.soft(Math.max(...geometry.centres) - Math.min(...geometry.centres))
    .toBeLessThan(1);
  expect.soft(geometry.captionSpace + .5)
    .toBeGreaterThanOrEqual(geometry.captionPadding);
  if (geometry.trailGap !== null) {
    expect.soft(Math.abs(geometry.trailGap - geometry.captionSpace))
      .toBeLessThan(1);
  }
  for (const gap of geometry.gaps) {
    expect.soft(Math.abs(gap - geometry.slotGap)).toBeLessThan(1);
  }
  expect.soft(geometry.weights.every((weight) => weight === "400")).toBe(true);
  expect.soft(geometry.pads).toEqual(["0px", "0px"]);
  if (width === 1440) {
    expect.soft(geometry.controls.every((control) => !control.absent)).toBe(
      true,
    );
  }
}

async function expectCategoryButtons(header: Locator) {
  const buttons = header.locator("[data-record-kind]").and(
    header.getByRole("button"),
  );
  await expect(buttons).toHaveCount(2);
  for (const count of await buttons.all()) {
    await expect.soft(count.locator(".otk-disclosure-icon")).toBeVisible();
    await expect(count).toHaveAttribute("aria-expanded", "false");
    const closed = await count.locator("path").count();
    await count.click();
    await expect(count).toHaveAttribute("aria-expanded", "true");
    expect.soft(await count.locator("path").count()).toBeLessThan(closed);
  }
}

test.use({ profile: "contract-messages-disclosures" });
{
  const surface = "interval";
  test(`messages.${surface}-header-shared-meta-and-whole-controls`, {
    tag: ["@messages", "@contracts"],
  }, async ({ isolatedState: state, page }) => {
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "thaw",
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSession(state, page, "tstv1-otk");
    const header = page.locator(
      "[data-background-interval]",
    ).first();
    const counts = header.locator("[data-record-kind]");
    await expect(counts).toHaveCount(2);
    await expect.soft(header.locator(".otk-meta-row [data-record-kind]"))
      .toHaveCount(2);
    for (const width of [1440, 760]) {
      await page.setViewportSize({ width, height: 1000 });
      await expectHeader(header, width);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expectCategoryButtons(header);
  });
}

// D74 / wl-5: reply summaries stay on the strip; the measured category
// controls and their interactions move to the panel's bookkeeping row.
test("messages.work-header-shared-meta-and-whole-controls", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page }) => {
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "hold",
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openSession(state, page, "tstv1-otk");
  const strip = page.locator(".otk-work-strip").first();
  await expect(strip.getByText("Work log", { exact: true })).toBeVisible();
  await expect(strip.locator("em")).toHaveCount(0);
  await expect(page.locator(".otk-turn-time").first()).toHaveText(
    "counting...",
  );
  await expect(page.locator(".otk-turn-time em").first()).toHaveText(
    "counting...",
  );
  const panel = await openLatestWork(page);
  const header = panel.locator(".otk-work-recorded-meta");
  const counts = header.locator(".otk-meta-row [data-record-kind]");
  await expect(counts).toHaveCount(2);
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 1000 });
    await expectHeader(header, width);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expectCategoryButtons(header);
});
