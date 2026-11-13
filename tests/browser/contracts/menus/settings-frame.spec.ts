// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({ profile: "contract-menus-inbox" });

test("settings.default-port-and-config-hints", {
  tag: ["@menus", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  await state.product("prefs.set", { key: "animationsOff", value: true });
  await page.goto(state.url);
  await expect(page.locator(".otk-welcome")).toBeVisible();
  await page.locator(".otk-settings-entry").click();
  const settings = page.getByRole("region", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await settings.locator(":scope > .otk-scroll").evaluate((node) => {
      node.scrollTop = 0;
    });
    await info.attach(`${theme}-settings-top`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await settings.getByLabel("Label", { exact: true })
      .scrollIntoViewIfNeeded();
    await info.attach(`${theme}-settings-servers`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  }
  const session = await page.request.get(
    new URL("api/session", state.url).href,
  );
  const defaults = (await session.json()).defaults;
  expect(Object.keys(defaults)).toEqual(["defaultPort"]);
  await expect(settings.getByLabel("Base URL", { exact: true }))
    .toHaveAttribute("placeholder", `http://computer:${defaults.defaultPort}`);
  const hint = settings.locator(".otk-settings-server-help");
  await expect(hint).toContainText("not its opencode address");
  await expect(hint).toContainText(new URL(state.url).origin);
  for (
    const word of [
      "~/.config/otk/otk.toml",
      "$XDG_CONFIG_HOME/otk/otk.toml",
      "OTK_CONFIG",
      "origins",
      "[server]",
      "host",
      "restart OTK",
      "OTK_SERVER_HOST",
      "OTK_SERVER_ORIGINS",
    ]
  ) await expect(hint).toContainText(word);
});

test("settings.header-and-scrollport-share-one-frame", {
  tag: ["@menus", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  await state.product("prefs.set", { key: "animationsOff", value: true });
  await page.goto(state.url);
  await expect(page.locator(".otk-welcome")).toBeVisible();
  await page.locator(".otk-settings-entry").click();
  await expect(page.locator(".otk-settings")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  for (const collapsed of [false, true]) {
    await state.product("layout.patch", {
      leftCollapsed: collapsed,
      rightCollapsed: collapsed,
    });
    for (
      const viewport of [
        { width: 1280, height: 800 },
        { width: 850, height: 500 },
        { width: 600, height: 400 },
      ]
    ) {
      await page.setViewportSize(viewport);
      const frame = page.locator(".otk-settings");
      const scrollport = frame.locator(":scope > .otk-scroll");
      await scrollport.evaluate((node) => {
        node.scrollTop = 0;
      });
      const geometry = () =>
        frame.evaluate((node) => {
          const header = node.querySelector(":scope > header")!;
          const body = node.querySelector(":scope > .otk-scroll")!;
          const rect = node.getBoundingClientRect();
          const h = header.getBoundingClientRect();
          const b = body.getBoundingClientRect();
          return {
            frameTop: rect.top,
            frameBottom: rect.bottom,
            headerTop: h.top,
            headerBottom: h.bottom,
            bodyTop: b.top,
            bodyBottom: b.bottom,
            documentScroll: document.scrollingElement!.scrollTop,
            documentHeight: document.scrollingElement!.scrollHeight,
            viewportHeight: innerHeight,
            scrollTop: body.scrollTop,
            scrollHeight: body.scrollHeight,
            height: body.clientHeight,
          };
        });
      const before = await geometry();
      await info.attach(`frame-${viewport.width}-${collapsed}`, {
        body: JSON.stringify(before),
        contentType: "application/json",
      });
      expect(Math.abs(before.headerTop - before.frameTop)).toBeLessThanOrEqual(
        .5,
      );
      expect(Math.abs(before.bodyTop - before.headerBottom))
        .toBeLessThanOrEqual(.5);
      expect(Math.abs(before.bodyBottom - before.frameBottom))
        .toBeLessThanOrEqual(.5);
      expect(before.scrollHeight).toBeGreaterThan(before.height);
      await frame.getByLabel("Label", { exact: true }).scrollIntoViewIfNeeded();
      const after = await geometry();
      expect(after.scrollTop).toBeGreaterThan(0);
      expect(after.headerTop).toBe(before.headerTop);
      expect(after.headerBottom).toBe(before.headerBottom);
      expect(after.documentScroll).toBe(0);
      expect(after.documentHeight).toBe(after.viewportHeight);
      const last =
        (await frame.getByLabel("Label", { exact: true }).boundingBox())!;
      expect(last.y).toBeGreaterThanOrEqual(after.bodyTop);
      expect(last.y + last.height).toBeLessThanOrEqual(after.bodyBottom);
      await expect(frame.getByRole("button", { name: "Close settings" }))
        .toBeInViewport();
    }
  }
});
