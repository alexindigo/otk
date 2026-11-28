// SPDX-License-Identifier: LGPL-3.0-only
import type { Locator } from "@playwright/test";
import { expect } from "../fixtures/evidence.ts";

/** Use an attached native context (no Playwright focus emulation). Coordinates
 * are taken before leaving, with no actionability wait or retry after return. */
export async function returnAndClick(control: Locator) {
  const page = control.page();
  await page.bringToFront();
  await control.scrollIntoViewIfNeeded();
  const probe = await control.evaluateHandle((node) => {
    const { x, y, width, height } = node.getBoundingClientRect();
    const center = { x: x + width / 2, y: y + height / 2 };
    if (!node.contains(document.elementFromPoint(center.x, center.y))) {
      throw new Error("Return target is covered before leaving");
    }
    (document.activeElement as HTMLElement).blur();
    const observed = { presses: 0, focusedBeforePress: false };
    const abort = new AbortController();
    document.addEventListener("pointerdown", (event) => {
      if (!event.isTrusted) return;
      observed.presses++;
      observed.focusedBeforePress = document.activeElement !== document.body;
    }, { capture: true, signal: abort.signal });
    return { center, observed, abort };
  });
  const point = await probe.evaluate(({ center }) => center);
  const session = await page.context().newCDPSession(page);
  let cover: string | undefined;
  try {
    const { targetInfo } = await session.send("Target.getTargetInfo");
    ({ targetId: cover } = await session.send("Target.createTarget", {
      url: "about:blank",
      browserContextId: targetInfo.browserContextId,
    }));
    await session.send("Target.activateTarget", { targetId: cover });
    await expect.poll(() =>
      page.evaluate(() => ({
        focused: document.hasFocus(),
        visible: document.visibilityState === "visible",
      }))
    ).toEqual({ focused: false, visible: false });
    // Separate real browser activation/input from the interval before fallback
    // restoration. Control that interval without sleeping or faking DOM events.
    const now = new Date();
    await page.clock.install({ time: now });
    await page.clock.pauseAt(now.getTime() + 1000);
    try {
      await session.send("Target.activateTarget", {
        targetId: targetInfo.targetId,
      });
      await page.mouse.click(point.x, point.y);
    } finally {
      await page.clock.resume();
    }
    return await probe.evaluate(({ observed }) => observed);
  } finally {
    try {
      if (cover) await session.send("Target.closeTarget", { targetId: cover });
    } finally {
      await session.detach();
      await probe.evaluate(({ abort }) => abort.abort());
      await probe.dispose();
    }
  }
}
