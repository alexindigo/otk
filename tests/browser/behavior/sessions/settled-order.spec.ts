// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { activity } from "../../pages/sessions.ts";

test.use({ profile: "contract-sessions-tabs" });
test(
  "sessions.settled-order-shared-by-strip-and-groups-and-frozen-during-interaction",
  {
    tag: ["@sessions", "@contracts", "@isolated"],
  },
  async ({ isolatedState: state, page }) => {
    test.setTimeout(90000);
    const a = await state.product("tasks.create", {
      directory: state.directory,
      name: "Order first",
      sessions: ["tstv1-otk"],
    });
    const b = await state.product("tasks.create", {
      directory: state.directory,
      name: "Order second",
      sessions: ["tstv1-second"],
    });
    await activity(state, "tstv1-otk", "hold");
    await openSession(state, page, "tstv1-otk");
    const tab = (id: string) => page.locator(`[data-tab="${id}"]`);
    const order = () =>
      page.locator("[data-tab]").evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("data-tab"))
      ).then((ids) => ids.filter((id) => id === a.id || id === b.id));
    const groups = () =>
      page.locator("[data-session-group]").evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("data-session-group"))
      ).then((ids) => ids.filter((id) => id === a.id || id === b.id));
    await expect(tab(a.id).locator(".otk-status-light")).toHaveAttribute(
      "data-state",
      "working",
    );
    await page.mouse.move(500, 400);
    await expect.poll(order).toEqual([a.id, b.id]);
    await activity(state, "tstv1-second", "hold");
    await expect(tab(b.id).locator(".otk-status-light")).toHaveAttribute(
      "data-state",
      "working",
    );
    await activity(state, "tstv1-second", "release");
    await activity(state, "tstv1-second", "hold");
    await expect.poll(order).toEqual([a.id, b.id]);
    await tab(b.id).hover();
    await page.waitForTimeout(6000);
    expect(await order()).toEqual([a.id, b.id]);
    expect(await groups()).toEqual([a.id, b.id]);
    await page.mouse.move(500, 400);
    await expect.poll(order).toEqual([b.id, a.id]);
    await expect.poll(groups).toEqual([b.id, a.id]);
    // A second borrower (the right-hand list) freezes the same permutation.
    await page.locator(`[data-session-group="${b.id}"]`).hover();
    await activity(state, "tstv1-second", "release");
    const marks = await state.product("sessions.finishes", {});
    await state.product("sessions.seen", {
      sessionID: "tstv1-second",
      terminal: marks["tstv1-second"],
    });
    await page.waitForTimeout(6000);
    expect(await order()).toEqual([b.id, a.id]);
    expect(await groups()).toEqual([b.id, a.id]);
    await page.mouse.move(500, 400);
    await expect.poll(order).toEqual([a.id, b.id]);
    await expect.poll(groups).toEqual([a.id, b.id]);
    // Keyboard focus is an interaction too, independently of the pointer.
    await tab(b.id).focus();
    await activity(state, "tstv1-second", "hold");
    await page.waitForTimeout(6000);
    expect(await order()).toEqual([a.id, b.id]);
    await page.locator("textarea[name=prompt]").focus();
    await expect.poll(order).toEqual([b.id, a.id]);
    // Portalled context menus retain their originating list's interaction hold.
    await tab(b.id).click({ button: "right" });
    const menu = page.locator(
      ':popover-open [role="menu"][aria-label="Context menu"]',
    );
    await expect(menu).toBeVisible();
    await menu.hover();
    await activity(state, "tstv1-second", "release");
    const finalMarks = await state.product("sessions.finishes", {});
    await state.product("sessions.seen", {
      sessionID: "tstv1-second",
      terminal: finalMarks["tstv1-second"],
    });
    await page.waitForTimeout(6000);
    await expect(menu).toBeVisible();
    expect(await order()).toEqual([b.id, a.id]);
    await page.keyboard.press("Escape");
    await page.locator("textarea[name=prompt]").focus();
    await page.mouse.move(500, 400);
    await expect.poll(order).toEqual([a.id, b.id]);
  },
);
