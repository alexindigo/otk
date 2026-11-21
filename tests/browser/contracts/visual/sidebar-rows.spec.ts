// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({
  profile: "contract-visual-styles",
  timezoneId: "America/Los_Angeles",
});
test("visual.sidebar-row-tracks-align-and-never-overlap", {
  tag: ["@visual", "@projects", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  for (const width of [200, 297.96484375, 360]) {
    for (const scale of [1, 1.25]) {
      await page.goto(`${state.url}/?scene=sidebar-rows&width=${width}`);
      await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
      await page.evaluate(
        (scale) =>
          document.documentElement.style.setProperty(
            "--otk-scale",
            String(scale),
          ),
        scale,
      );
      await page.evaluate(() => document.fonts.ready);
      expect(
        Math.abs(
          (await page.locator(".otk-project-inbox").boundingBox())!.width -
            width,
        ),
        "the actual sidebar uses the requested supported width",
      ).toBeLessThanOrEqual(.5);
      expect(
        await page.evaluate(() =>
          parseFloat(getComputedStyle(document.documentElement).fontSize)
        ),
      ).toBeCloseTo(13 * scale, 2);
      for (const name of ["Archived", "Inactive"]) {
        await page.getByRole("button", { name: new RegExp("^" + name) })
          .click();
      }
      const rootLabels = await page.locator(
        ".otk-project-row:not(.is-subproject) .otk-project-name",
      ).evaluateAll((els) => els.map((el) => el.getBoundingClientRect().left));
      expect(
        Math.max(...rootLabels) - Math.min(...rootLabels),
        "absent avatar retains its label track",
      ).toBeLessThanOrEqual(.5);
      const geometry = async () => {
        const facts = await page.locator(".otk-project-inbox .otk-tree-heading")
          .evaluateAll((headings) =>
            headings.filter((h) => h.getBoundingClientRect().height > 0).map(
              (h) => {
                const box = (el: Element) => {
                  const r = el.getBoundingClientRect();
                  return {
                    x: r.x,
                    right: r.right,
                    y: r.y,
                    bottom: r.bottom,
                    w: r.width,
                  };
                };
                const slots = Array.from(
                  h.querySelectorAll(
                    ".otk-sidebar-row > .otk-sidebar-slot, .otk-sidebar-row-main > .otk-sidebar-slot",
                  ),
                ).map(box);
                const junction = h.querySelector(":scope > .otk-tree-own")!;
                const row = h.querySelector(".otk-sidebar-row")!;
                const label = row?.querySelector(".otk-sidebar-label");
                const actual = Array.from(
                  h.querySelectorAll(
                    ".otk-tree-toggle, .otk-status-light, .otk-project-avatar, .otk-project-name, .otk-section-row-label, .otk-project-visit, .otk-project-menu-trigger",
                  ),
                ).filter((el) => {
                  for (
                    let parent: Element | null = el;
                    parent && parent !== h;
                    parent = parent.parentElement
                  ) {
                    const s = getComputedStyle(parent);
                    if (
                      s.visibility === "hidden" || s.display === "none" ||
                      Number(s.opacity) === 0
                    ) return false;
                  }
                  return el.getBoundingClientRect().width > 0;
                }).map(box);
                if (h.querySelector(".otk-sidebar-selection.is-selected")) {
                  const [w, height] = getComputedStyle(h).backgroundSize.split(
                    " ",
                  ).map(parseFloat);
                  const r = h.getBoundingClientRect();
                  actual.push({
                    x: r.x,
                    right: r.x + w,
                    y: r.y + (r.height - height) / 2,
                    bottom: r.y + (r.height + height) / 2,
                    w,
                  });
                }
                const node = h.closest(".otk-tree-node")!;
                const parent = node.parentElement?.closest(".otk-tree-node");
                const parentLamp = parent?.querySelector(
                  ":scope > .otk-tree-heading .otk-sidebar-lamp",
                );
                return {
                  left: box(h).x,
                  heading: box(h),
                  junction: box(junction),
                  slots,
                  actual,
                  label: label && box(label),
                  row: row && box(row),
                  indent: parseFloat(getComputedStyle(junction).width),
                  scroll: h.scrollWidth - h.clientWidth,
                  text: h.textContent,
                  parentAxis: parentLamp
                    ? box(parentLamp).x + box(parentLamp).w / 2
                    : undefined,
                };
              },
            )
          );
        expect(facts.length).toBeGreaterThan(7);
        const levels = new Map<number, number[]>();
        for (const [index, fact] of facts.entries()) {
          if (index) {
            expect(
              facts[index - 1].heading.bottom - fact.heading.y,
              "adjacent tree rows never overlap vertically",
            ).toBeLessThanOrEqual(.5);
          }
          expect(fact.slots, fact.text!).toHaveLength(4);
          expect(fact.scroll, fact.text!).toBeLessThanOrEqual(1);
          const edges = [fact.junction.x, ...fact.slots.map((slot) => slot.x)];
          const previous = levels.get(fact.left);
          if (previous) {
            edges.forEach((edge, i) =>
              expect(Math.abs(edge - previous[i]), fact.text!)
                .toBeLessThanOrEqual(.5)
            );
          } else levels.set(fact.left, edges);
          for (let i = 0; i < fact.actual.length; i++) {
            expect(fact.actual[i].y).toBeGreaterThanOrEqual(
              fact.heading.y - .5,
            );
            expect(fact.actual[i].bottom).toBeLessThanOrEqual(
              fact.heading.bottom + .5,
            );
            expect(
              Math.abs(
                (fact.actual[i].y + fact.actual[i].bottom) / 2 -
                  (fact.junction.y + fact.junction.bottom) / 2,
              ),
              `shared row center: ${fact.text}`,
            ).toBeLessThanOrEqual(.5);
            for (let j = i + 1; j < fact.actual.length; j++) {
              const a = fact.actual[i], b = fact.actual[j];
              const intersection = Math.min(a.right, b.right) -
                Math.max(a.x, b.x);
              expect(intersection, `nonintersecting row elements: ${fact.text}`)
                .toBeLessThanOrEqual(.5);
            }
          }
          if (fact.parentAxis !== undefined) {
            expect(
              Math.abs(fact.parentAxis - fact.junction.x - fact.junction.w / 2),
            ).toBeLessThanOrEqual(.5);
          }
          expect(fact.label!.w).toBeGreaterThan(0);
        }
        return facts;
      };
      await geometry();
      for (const group of ["active", "archived", "discovered", "inactive"]) {
        await expect(
          page.locator(`.otk-project-row[data-group="${group}"]`).first(),
        ).toBeVisible();
      }
      // Every row kind can be selected without changing any track or intersecting artwork.
      for (const button of await page.locator(".otk-project-open").all()) {
        await button.click();
        await geometry();
      }
      const root = page.locator(".otk-project-tree").filter({
        has: page.locator('[data-project="/projects/atmosphera"]'),
      }).first();
      const toggle = root.locator(
        ":scope > .otk-tree-heading .otk-tree-toggle",
      );
      await toggle.click();
      await expect(page.locator('[data-project="/projects/atmosphera.branch"]'))
        .toHaveCount(0);
      await geometry();
      await toggle.click();
      for (const name of ["Archived", "Discovered", "Inactive"]) {
        const header = page.getByRole("button", {
          name: new RegExp("^" + name),
        });
        await header.click();
        await geometry();
        await header.click();
        await geometry();
      }
      if (width > 290 && width < 300 && scale === 1.25) {
        for (
          const [name, theme] of [
            ["dark", "otk-dark"],
            ["linen", "otk-light"],
            ["stone", "otk-light-stone"],
          ]
        ) {
          await page.evaluate((theme) =>
            (globalThis as unknown as {
              styleTest: { theme(id: string): void };
            }).styleTest.theme(theme), theme);
          await geometry();
          await page.mouse.move(1400, 1050);
          await page.screenshot({
            path: info.outputPath(`sidebar-rows-${name}.png`),
            fullPage: true,
          });
        }
      }
      await page.goto(`${state.url}/?scene=sidebar-rows&collapsed=1`);
      await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
      await page.evaluate(
        (scale) =>
          document.documentElement.style.setProperty(
            "--otk-scale",
            String(scale),
          ),
        scale,
      );
      const compact = await page.locator(".otk-project-inbox .otk-status-light")
        .evaluateAll((els) =>
          els.filter((el) => el.getBoundingClientRect().width > 0).map((el) =>
            el.getBoundingClientRect().x
          )
        );
      expect(compact.length).toBeGreaterThan(5);
      expect(Math.max(...compact) - Math.min(...compact)).toBeLessThanOrEqual(
        .5,
      );
      const selected = page.locator(".otk-project-row.is-selected");
      const gap = await selected.evaluate((el) =>
        el.querySelector(".otk-status-light")!.getBoundingClientRect().x -
        el.getBoundingClientRect().x
      );
      expect(gap).toBeGreaterThan(3 * scale);
    }
  }
});
