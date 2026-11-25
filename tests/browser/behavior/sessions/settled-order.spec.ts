// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { activity } from "../../pages/sessions.ts";

test.use({ profile: "contract-sessions-tabs" });
test(
  "sessions.settled-order-shared-by-strip-and-groups-and-frozen-during-interaction",
  { tag: ["@sessions", "@contracts", "@isolated"] },
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
    await page.mouse.move(500, 400);
    await expect.poll(order).toEqual([a.id, b.id]);
    await expect.poll(groups).toEqual([a.id, b.id]);
    await activity(state, "tstv1-second", "hold");
    await expect(tab(b.id).locator(".otk-status-light")).toHaveAttribute(
      "data-state",
      "working",
    );
    await tab(b.id).hover();
    await page.waitForTimeout(6000);
    await page.mouse.move(500, 400);
    expect(await order()).toEqual([a.id, b.id]);
    expect(await groups()).toEqual([a.id, b.id]);
    await activity(state, "tstv1-second", "release");
    await page.waitForTimeout(6000);
    expect(await order()).toEqual([a.id, b.id]);
    expect(await groups()).toEqual([a.id, b.id]);
    // Only the existing explicit move contract may change position.
    const tasks = await state.product("tasks.list", {
      directory: state.directory,
    });
    const ids = tasks.map((task) => task.id);
    const ai = ids.indexOf(a.id), bi = ids.indexOf(b.id);
    [ids[ai], ids[bi]] = [ids[bi], ids[ai]];
    await state.product("tasks.reorder", { directory: state.directory, ids });
    await expect.poll(order).toEqual([b.id, a.id]);
    await expect.poll(groups).toEqual([b.id, a.id]);
    const c = await state.product("tasks.create", {
      directory: state.directory,
      name: "Order new",
      sessions: [],
    });
    await expect(tab(c.id)).toBeVisible();
    expect(
      await page.locator("[data-tab]").evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("data-tab"))
      ).then((ids) =>
        ids.filter((id) => id === a.id || id === b.id || id === c.id)
      ),
    ).toEqual([b.id, a.id, c.id]);
    await page.reload();
    await expect.poll(order).toEqual([b.id, a.id]);
    await expect.poll(groups).toEqual([b.id, a.id]);
  },
);
