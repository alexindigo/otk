// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { wire } from "../../fixtures/wire.ts";

test.use({ profile: "isolated" });
test("sessions.focused-row-identity-survives-native-page-acquisition", {
  tag: ["@sessions", "@load", "@contracts"],
}, async ({ isolatedState: state, page }, info) => {
  test.setTimeout(120_000);
  const sessions: { id: string }[] = [];
  for (let i = 0; i < 65; i++) {
    sessions.push(
      await state.native("/session", "POST", {
        title: `Focus acquisition ${String(i).padStart(3, "0")}`,
      }),
    );
  }
  await state.product("layout.patch", {
    rightCollapsed: false,
    rightView: "sessions",
  });
  const pane = page.locator(".otk-project-session-tree");
  const last = page.locator(`[data-session="${sessions[1].id}"]`);
  const frames = await wire(page);
  await page.goto(`${state.url}/#/local/${sessions.at(-1)!.id}`);
  await expect(pane).toBeVisible();
  await pane.hover();
  await expect.poll(async () => {
    await page.mouse.wheel(0, 100000);
    return last.count();
  }).toBe(1);
  await last.evaluate((element) => {
    Object.assign(globalThis, { pinnedRow: element });
    (element as HTMLElement).focus();
  });
  await expect(last).toBeFocused();
  await page.evaluate(() =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )
  );
  await pane.hover();
  await page.mouse.wheel(0, -100000);
  await expect.poll(() => pane.evaluate((element) => element.scrollTop))
    .toBe(0);
  await expect.poll(() =>
    page.evaluate(
      "document.activeElement===pinnedRow&&pinnedRow.isConnected",
    )
  ).toBe(true);
  await expect(last).toBeFocused();
  await page.getByRole("searchbox", { name: "Search sessions by title" })
    .focus();
  await expect(last).toHaveCount(0);
  await pane.hover();
  await expect.poll(async () => {
    await page.mouse.wheel(0, 100000);
    return last.count();
  }).toBe(1);
  const loading = page.locator(".otk-session-loading-row");
  await expect(loading).toHaveCount(0);
  const anchor = () =>
    pane.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const row = Array.from(
        element.querySelectorAll<HTMLElement>("[data-virtual-key]"),
      )
        .find((row) => row.getBoundingClientRect().bottom > bounds.top + .5)!;
      return {
        key: row.dataset.virtualKey,
        offset: row.getBoundingClientRect().top - bounds.top,
        height: bounds.height,
      };
    });
  const before = await anchor();
  const beforeViewport = await pane.evaluate((element) => ({
    top: element.scrollTop,
    total: element.scrollHeight,
    height: element.clientHeight,
  }));
  frames.hold((frame, request) =>
    frame.t === "request.result" && request?.method === "sessions.list"
  );
  try {
    await state.product("session.rename", {
      sessionID: sessions[1].id,
      title: "Focus acquisition renamed",
    });
    await expect(loading).toBeVisible();
    await expect.poll(() => frames.held.length).toBeGreaterThan(0);
    const measurements: unknown[] = [];
    for (
      const [theme, name] of [["otk-dark", "dark"], ["otk-light", "linen"], [
        "otk-light-stone",
        "stone",
      ]]
    ) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      const during = await anchor();
      expect(during.key).toBe(before.key);
      expect(Math.abs(during.offset - before.offset)).toBeLessThan(1);
      expect(during.height).toBe(before.height);
      const slot = await page.locator(".otk-session-loading-slot")
        .boundingBox();
      expect(slot!.height).toBe(30);
      measurements.push({ theme, before, during, slot });
      await page.screenshot({
        path: info.outputPath(`fixs-loading-slot-${name}.png`),
        fullPage: true,
      });
    }
    frames.release();
    await expect(loading).toHaveCount(0);
    const after = await anchor();
    await info.attach("anchor-reconciliation", {
      body: JSON.stringify({
        before,
        after,
        beforeViewport,
        afterViewport: await pane.evaluate((element) => ({
          top: element.scrollTop,
          total: element.scrollHeight,
          height: element.clientHeight,
        })),
        sourcePositions: {
          before: sessions.findIndex((s) => s.id === before.key),
          after: sessions.findIndex((s) => s.id === after.key),
        },
      }),
      contentType: "application/json",
    });
    expect(after.key).toBe(before.key);
    expect(Math.abs(after.offset - before.offset)).toBeLessThan(1);
    expect(after.height).toBe(before.height);
    for (
      const [theme, name] of [["otk-dark", "dark"], ["otk-light", "linen"], [
        "otk-light-stone",
        "stone",
      ]]
    ) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await expect(loading).toHaveCount(0);
      await page.screenshot({
        path: info.outputPath(`fixs-ready-slot-${name}.png`),
        fullPage: true,
      });
    }
    await info.attach("loading-anchor-geometry", {
      body: JSON.stringify({ measurements, after }),
      contentType: "application/json",
    });
  } finally {
    frames.release();
  }
});

test.describe("interior focus pin", () => {
  test.use({ profile: "contract-sessions-window" });
  test("sessions.interior-focus-pin-survives-range-reconciliation", {
    tag: ["@sessions", "@load", "@contracts"],
  }, async ({ isolatedState: state, page }) => {
    await state.product("layout.patch", {
      rightCollapsed: false,
      rightView: "sessions",
    });
    await page.goto(`${state.url}/#/local/tstv1-otk`);
    const pane = page.locator(".otk-project-session-tree");
    const row = page.locator("[data-session=tstv1-w-298]");
    await pane.hover();
    await expect.poll(async () => {
      await page.mouse.wheel(0, 100000);
      return row.count();
    }).toBe(1);
    await row.evaluate((element) => {
      Object.assign(globalThis, { interiorFocusRow: element });
      (element as HTMLElement).focus();
    });
    await expect(row).toBeFocused();
    await page.mouse.wheel(0, -100000);
    await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBe(
      0,
    );
    await expect.poll(() =>
      page.evaluate(
        "document.activeElement===interiorFocusRow&&interiorFocusRow.isConnected",
      )
    ).toBe(true);
    await page.getByRole("searchbox", { name: "Search sessions by title" })
      .focus();
    await expect(row).toHaveCount(0);
  });
});
