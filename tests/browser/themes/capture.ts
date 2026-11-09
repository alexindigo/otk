// SPDX-License-Identifier: LGPL-3.0-only
import {
  type CDPSession,
  expect,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { shellContained, sidebarWheelContained } from "./containment.ts";
import { auditUiRules } from "../pages/ui-rules.ts";

/** Return emulation ownership to Playwright. Its Chromium delegate memoizes the
 * metrics tuple, so an unchanged size cannot reinstall an override cleared by
 * another CDP session. A distinct public setter call invalidates that cache. */
export async function restoreViewport(page: Page, cdp: CDPSession) {
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await page.setViewportSize({ ...viewport!, width: viewport!.width + 1 });
  await page.setViewportSize(viewport!);
  await expect.poll(() =>
    page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio])
  ).toEqual([viewport!.width, viewport!.height, 1]);
}

/** Capture the rendered content without replacing the active emulation viewport. */
export async function capture(
  page: Page,
  cdp: CDPSession,
  info: Pick<TestInfo, "outputPath" | "attach">,
  name: string,
) {
  await page.evaluate(() =>
    document.fonts.ready.then(() =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
    )
  );
  const before = await cdp.send("Page.getLayoutMetrics");
  await shellContained(page);
  await auditUiRules(page, info, name);
  if (
    name.startsWith("chrome-left-") &&
    await page.locator(".otk-project-inbox .otk-rail-body").count()
  ) {
    await sidebarWheelContained(page);
  }
  const scale = await page.evaluate(() => devicePixelRatio);
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: true,
    clip: { ...before.cssContentSize, scale: 1 },
  });
  const bytes = Buffer.from(data, "base64");
  expect(bytes.readUInt32BE(16)).toBe(
    Math.ceil(before.cssContentSize.width * scale),
  );
  expect(bytes.readUInt32BE(20)).toBe(
    Math.ceil(before.cssContentSize.height * scale),
  );
  const after = await cdp.send("Page.getLayoutMetrics");
  expect([
    after.cssLayoutViewport.clientWidth,
    after.cssLayoutViewport.clientHeight,
  ]).toEqual([
    before.cssLayoutViewport.clientWidth,
    before.cssLayoutViewport.clientHeight,
  ]);
  const path = info.outputPath(name + ".png");
  await writeFile(path, bytes);
  await info.attach(name, { path, contentType: "image/png" });
}
