// SPDX-License-Identifier: LGPL-3.0-only
import { isolatedTest as test } from "../fixtures/isolated.ts";
import { expect } from "../fixtures/evidence.ts";
import {
  shellContained,
  sidebarWheelContained,
} from "../themes/containment.ts";

test.use({ profile: "contract-scale-overflow" });
test(
  "scale.required-tasks-wrap-and-more",
  { tag: ["@scale"] },
  async ({ isolatedState: state, page }, info) => {
    const { ids, tasks } = await state.observe<
      { ids: string[]; tasks: string[] }
    >();
    expect(ids).toHaveLength(300);
    expect(tasks).toHaveLength(300);
    await page.goto(`${state.url}/#/local/${ids[0]}`);
    await expect(page.locator("textarea[name=prompt]")).toBeVisible();
    const visible = async (n: number) => {
      const row = page.locator(`[data-tab="${tasks[n]}"]`);
      await expect(row).toBeVisible();
      const r = await row.boundingBox();
      expect(r).toBeTruthy();
      expect(r!.y).toBeGreaterThanOrEqual(0);
      expect(r!.y + r!.height).toBeLessThanOrEqual(900);
    };
    const geometry = () =>
      page.evaluate<
        {
          height: number;
          expected: number;
          visible: string[];
          pinned: string[];
        }
      >(`(()=>{const strip=document.querySelector('.otk-task-strip');return {height:strip.getBoundingClientRect().height,expected:parseFloat(getComputedStyle(strip).getPropertyValue('--chrome-header-height')),visible:[...strip.querySelectorAll('.otk-overflow-item:not([hidden]) [data-tab]')].map(e=>e.dataset.tab),pinned:[...strip.querySelectorAll('.otk-overflow-item[data-pinned=true] [data-tab]')].map(e=>e.dataset.tab)}})()`);
    const samples: unknown[] = [];
    for (const width of [600, 800, 1280, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(
        "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
      );
      await expect.poll(async () => {
        const g = await geometry();
        return Math.abs(g.height - g.expected);
      }).toBeLessThanOrEqual(1);
      samples.push({ width, idle: await geometry() });
      await visible(0);
      await expect(page.locator(".otk-task-list .otk-overflow-more"))
        .toHaveCount(1);
    }
    await page.setViewportSize({ width: 800, height: 900 });
    await page.getByRole("button", { name: "More tasks", exact: true }).click();
    const menu = page.locator('.otk-folded-tasks :popover-open [role="menu"]');
    await menu.locator(`[data-overflow-tab="${tasks[250]}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/${ids[250]}$`));
    await expect(page.locator(`[data-tab="${tasks[250]}"]`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await visible(250);
    const scenario = (action: "hold" | "succeed" | "freeze") =>
      state.controller.call("scenario", { lease: state.lease.lease, action });
    await scenario("hold");
    await expect(page.locator(`[data-tab="${tasks[242]}"] .otk-status-light`))
      .toHaveAttribute("data-state", "working");
    await scenario("succeed");
    for (
      const [n, status] of [[240, "working"], [241, "blocked"], [
        242,
        "finished",
      ]] as const
    ) {
      await expect(page.locator(`[data-tab="${tasks[n]}"] .otk-status-light`))
        .toHaveAttribute("data-state", status);
      await visible(n);
    }
    await scenario("freeze");
    await expect(page.locator(".otk-task-list .otk-overflow-row")).toHaveClass(
      /wraps-required/,
    );
    for (
      const n of [
        ...Array.from({ length: 20 }, (_, n) => n + 200),
        240,
        241,
        242,
        250,
      ]
    ) await visible(n);
    const wrapped = await geometry();
    expect(wrapped.height).toBeGreaterThan(wrapped.expected);
    expect([...wrapped.visible].sort()).toEqual([...wrapped.pinned].sort());
    samples.push({ wrapped });
    await page.getByRole("button", { name: "More tasks", exact: true }).click();
    await expect(menu).toBeVisible();
    for (const id of wrapped.pinned) {
      await expect(
        menu.locator(`[data-overflow-tab="${id}"]`),
      ).toHaveCount(0);
    }
    await page.keyboard.press("Escape");
    await info.attach("population-control-measurements", {
      body: JSON.stringify({ tasks: 300, samples }),
      contentType: "application/json",
    });
  },
);

test("scale.shell-contained-with-300-required-tabs", {
  tag: ["@scale", "@sessions"],
}, async ({ isolatedState: state, page }, info) => {
  const { ids, tasks } = await state.observe<
    { ids: string[]; tasks: string[] }
  >();
  expect(tasks).toHaveLength(300);
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "thaw",
  });
  await state.product("layout.patch", {
    leftCollapsed: false,
    rightCollapsed: true,
  });
  await page.goto(`${state.url}/#/local/${ids[0]}`);
  await expect(page.locator("[data-tab] .otk-status-light[data-state=working]"))
    .toHaveCount(300);
  const measurements = [];
  for (const width of [400, 600, 800, 1280, 1920]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(() =>
      document.fonts.ready.then(() =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
      )
    );
    await shellContained(page);
    await sidebarWheelContained(page);
    measurements.push(
      await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        document: [
          document.scrollingElement!.scrollWidth,
          document.scrollingElement!.scrollHeight,
        ],
        chrome: document.querySelector(".otk-project-tabs")!
          .getBoundingClientRect().toJSON(),
      })),
    );
  }
  await info.attach("shell-containment-300-tabs", {
    body: JSON.stringify(measurements),
    contentType: "application/json",
  });
});
