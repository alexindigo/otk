// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";

function headerGeometry(root: Element) {
  // 2.114/dx-2: Tree owns the title/trail boundary; MetaRow owns the gaps
  // between the category controls, not a primary slot wrapping the title.
  const caption = root.querySelector(
    ":scope > .otk-tree-node > .otk-tree-heading > .otk-tree-trigger > .otk-disclosure-caption",
  )!;
  const label = root.querySelector(
    ".otk-work-label, .otk-record-group-toggle .otk-disclosure-label",
  )!;
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
  const visible = counts.filter((_, index) => !controls[index].absent);
  const elements = [label, ...visible];
  const rects = elements.map((element) => element.getBoundingClientRect());
  const slots = rects.slice(1);
  const titleEnd = caption.getBoundingClientRect().right;
  return {
    controls,
    centres: rects.map((r) => r.y + r.height / 2),
    trailGap: slots.length ? slots[0].left - rects[0].right : null,
    captionSpace: titleEnd - rects[0].right,
    captionPadding: parseFloat(getComputedStyle(caption).paddingInlineEnd),
    gaps: slots.slice(1).map((r, i) => r.left - slots[i].right),
    slotGap: parseFloat(getComputedStyle(meta).columnGap),
    weights: elements.map((element) => getComputedStyle(element).fontWeight),
    pads: counts.map((element) => getComputedStyle(element).paddingInline),
  };
}

test.use({ profile: "contract-messages-disclosures" });
for (const surface of ["work", "interval"] as const) {
  test(`messages.${surface}-header-shared-meta-and-whole-controls`, {
    tag: ["@messages", "@contracts"],
  }, async ({ isolatedState: state, page }) => {
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: surface === "work" ? "hold" : "thaw",
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSession(state, page, "tstv1-otk");
    const header = page.locator(
      surface === "work" ? ".otk-work-log" : "[data-background-interval]",
    ).first();
    const counts = header.locator("[data-record-kind]");
    await expect(counts).toHaveCount(2);
    await expect.soft(header.locator(".otk-meta-row [data-record-kind]"))
      .toHaveCount(2);
    if (surface === "work") {
      await expect.soft(header.locator(".otk-work-label")).toHaveText(
        "Work log",
      );
      await expect.soft(header.locator(".otk-work-label em")).toHaveCount(0);
      await expect.soft(page.locator(".otk-turn-time").first()).toHaveText(
        "counting...",
      );
      await expect.soft(page.locator(".otk-turn-time em").first()).toHaveText(
        "counting...",
      );
    }
    for (const width of [1440, 760]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(async () => {
        const geometry = await header.evaluate(headerGeometry);
        return geometry.controls.every((control) =>
          control.absent || control.whole && control.textFits
        );
      }).toBe(true);
      const geometry = await header.evaluate(headerGeometry);
      expect.soft(Math.max(...geometry.centres) - Math.min(...geometry.centres))
        .toBeLessThan(1);
      expect.soft(geometry.captionSpace + 0.5).toBeGreaterThanOrEqual(
        geometry.captionPadding,
      );
      if (geometry.trailGap !== null) {
        expect.soft(Math.abs(geometry.trailGap - geometry.captionSpace))
          .toBeLessThan(1);
      }
      for (const gap of geometry.gaps) {
        expect.soft(Math.abs(gap - geometry.slotGap)).toBeLessThan(1);
      }
      expect.soft(geometry.weights.every((weight) => weight === "400")).toBe(
        true,
      );
      expect.soft(geometry.pads).toEqual(["0px", "0px"]);
      if (width === 1440) {
        expect.soft(geometry.controls.every((control) => !control.absent)).toBe(
          true,
        );
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    const buttons = counts.and(header.getByRole("button"));
    await expect(buttons).toHaveCount(surface === "work" ? 1 : 2);
    for (const count of await buttons.all()) {
      await expect.soft(count.locator(".otk-disclosure-icon")).toBeVisible();
      await expect(count).toHaveAttribute("aria-expanded", "false");
      const closed = await count.locator("path").count();
      await count.click();
      await expect(count).toHaveAttribute("aria-expanded", "true");
      expect.soft(await count.locator("path").count()).toBeLessThan(closed);
    }
  });
}
