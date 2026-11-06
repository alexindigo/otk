// SPDX-License-Identifier: LGPL-3.0-only
import type { Page, TestInfo } from "@playwright/test";
import { expect } from "../fixtures/evidence.ts";

export const stripThemes = [
  { name: "dark", id: "otk-dark", mode: "dark" },
  { name: "linen", id: "otk-light", mode: "light" },
  { name: "stone", id: "otk-light-stone", mode: "light" },
];

export async function stripGeometry(page: Page) {
  return await page.locator(".otk-task-list").evaluate((lane) => {
    const bounds = lane.getBoundingClientRect();
    const tabs = Array.from(lane.querySelectorAll<HTMLElement>("[data-tab]"))
      .map(
        (tab) => {
          const box = tab.getBoundingClientRect();
          return {
            id: tab.dataset.tab!,
            width: box.width,
            y: box.y,
            full: box.left >= bounds.left - 1 && box.right <= bounds.right + 1,
            selected: tab.getAttribute("aria-selected") === "true",
          };
        },
      );
    const strip = lane.closest(".otk-task-strip")!;
    return {
      height: strip.getBoundingClientRect().height,
      expected: parseFloat(
        getComputedStyle(strip).getPropertyValue("--chrome-header-height"),
      ),
      tabs,
      full: tabs.filter((tab) => tab.full).map((tab) => tab.id),
      left: lane.scrollLeft,
      width: lane.clientWidth,
      total: lane.scrollWidth,
      previous: !!strip.querySelector('[data-direction="previous"]'),
      next: !!strip.querySelector('[data-direction="next"]'),
      page: [
        scrollX,
        scrollY,
        document.scrollingElement!.scrollWidth,
        document.scrollingElement!.scrollHeight,
      ],
      gaps: Array.from(strip.querySelectorAll(".otk-edge-triangle")).map(
        (button) => {
          const a = button.getBoundingClientRect(),
            b = button.querySelector("svg")!.getBoundingClientRect();
          return [
            b.left - a.left,
            a.right - b.right,
            b.top - a.top,
            a.bottom - b.bottom,
          ];
        },
      ),
    };
  });
}

export async function stripContract(page: Page, count: number) {
  const lane = page.locator(".otk-task-list");
  await expect(lane.locator("[data-tab]")).toHaveCount(count);
  await expect.poll(async () =>
    (await stripGeometry(page)).tabs.some((tab) => tab.selected && tab.full)
  ).toBe(true);
  const g = await stripGeometry(page);
  expect(g.height).toBe(g.expected);
  expect(
    Math.max(...g.tabs.map((tab) => tab.width)) -
      Math.min(...g.tabs.map((tab) => tab.width)),
  ).toBeLessThanOrEqual(1);
  expect(Math.min(...g.tabs.map((tab) => tab.width))).toBeGreaterThanOrEqual(
    90,
  );
  expect(new Set(g.tabs.map((tab) => tab.y)).size).toBe(1);
  expect(g.previous).toBe(g.left > 1);
  expect(g.next).toBe(g.left + g.width < g.total - 1);
  expect(g.page).toEqual([
    0,
    0,
    page.viewportSize()!.width,
    page.viewportSize()!.height,
  ]);
  for (const gaps of g.gaps) {
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
  }
  await expect(
    page.locator(
      ".otk-task-list .otk-overflow-more,.otk-tab-measure,.otk-task-list .wraps-required,.otk-auto-mark",
    ),
  ).toHaveCount(0);
  const names = await page.locator("[data-tab],[data-crumb],[data-session]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""));
  expect(names.some((name) => /, auto-approve/i.test(name))).toBe(false);
  if (g.total > g.width + 1) {
    await lane.evaluate((el) => {
      el.scrollLeft = 0;
    });
    await expect(
      page.getByRole("button", { name: "Previous tasks", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Next tasks", exact: true }))
      .toBeVisible();
    const first = await stripGeometry(page);
    await page.getByRole("button", { name: "Next tasks", exact: true }).click();
    await expect.poll(async () => (await stripGeometry(page)).full[0], {
      message: JSON.stringify({
        before: first,
        after: await stripGeometry(page),
      }),
    }).toBe(
      first.full.at(-1),
    );
    const second = await stripGeometry(page);
    await page.getByRole("button", { name: "Previous tasks", exact: true })
      .click();
    await expect.poll(async () => (await stripGeometry(page)).full.at(-1)).toBe(
      second.full[0],
    );
    await lane.hover();
    await page.mouse.wheel(0, 180);
    await expect.poll(async () => (await stripGeometry(page)).left)
      .toBeGreaterThan(0);
    const wheeled = await stripGeometry(page);
    expect(wheeled.page).toEqual(g.page);
    for (const modifier of ["ctrlKey", "metaKey"]) {
      expect(
        await lane.evaluate((el, modifier) => {
          const event = new WheelEvent("wheel", {
            deltaY: 120,
            bubbles: true,
            cancelable: true,
            [modifier]: true,
          });
          el.dispatchEvent(event);
          return event.defaultPrevented;
        }, modifier),
      ).toBe(false);
    }
    await lane.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await expect(page.getByRole("button", { name: "Next tasks", exact: true }))
      .toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Previous tasks", exact: true }),
    ).toBeVisible();
  } else {
    await expect(page.locator(".otk-edge-triangle")).toHaveCount(0);
  }
  return g;
}

export async function stripShot(page: Page, info: TestInfo, name: string) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByText("Saving viewed conversation", { exact: true }))
    .toHaveCount(0);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.mouse.move(640, 500);
  const path = info.outputPath(name + ".png");
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}
