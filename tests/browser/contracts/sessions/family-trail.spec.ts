// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import {
  activity,
  collapsed,
  viewByUrl,
  visibleOnScreen,
} from "../../pages/sessions.ts";

test.use({ profile: "contract-sessions-hierarchy" });
test(
  "sessions.blocked-and-undelivered-helpers-stay-until-parent-delivery",
  {
    tag: ["@sessions", "@projects", "@contracts"],
  },
  async ({ isolatedState: state, page }, info) => {
    const root = "tstv1-otk", helper = "tstv1-helper", nested = "tstv1-nested";
    await state.product("tasks.create", {
      directory: state.directory,
      name: "Family trail",
      sessions: [root],
    });
    await state.product("layout.patch", {
      leftCollapsed: true,
      rightCollapsed: true,
    });
    await activity(state, helper, "hold");
    await activity(state, nested, "hold");
    await viewByUrl(state, page, root);
    const crumb = (id: string) => page.locator(`[data-crumb="${id}"]`);
    const agent = (id: string) => page.locator(`[data-subagent="${id}"]`);
    const inventory = page.getByRole("button", { name: /^Subagents:/ });
    await expect(crumb(helper)).toHaveCount(0);
    await expect(crumb(nested)).toHaveCount(0);
    await inventory.click();
    await visibleOnScreen(agent(helper));
    await visibleOnScreen(agent(nested));
    await activity(state, helper, "freeze");
    await activity(state, nested, "release");
    for (const [id, status] of [[helper, "blocked"]]) {
      await visibleOnScreen(agent(id));
      await expect(agent(id).locator(".otk-status-light")).toHaveAttribute(
        "data-state",
        status,
      );
    }
    await visibleOnScreen(agent(nested));
    await page.reload();
    await collapsed(page);
    await visibleOnScreen(crumb(root));
    await inventory.click();
    for (const id of [helper, nested]) await visibleOnScreen(agent(id));
    await expect(page.getByRole("button", { name: /^Running helpers/ }))
      .toHaveCount(0);
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await visibleOnScreen(agent(helper));
      await visibleOnScreen(agent(nested));
      await page.screenshot({
        path: info.outputPath(`wp3-${theme}.png`),
        fullPage: true,
        animations: "disabled",
      });
    }
    await viewByUrl(state, page, nested);
    await expect(page).toHaveURL(new RegExp(`${nested}$`));
    await expect(crumb(nested).locator(".otk-status-light")).toHaveAttribute(
      "data-state",
      "none",
    );
    await crumb(root).click();
    await expect(crumb(nested)).toHaveCount(0);
    await inventory.click();
    await visibleOnScreen(agent(nested));
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "release",
      target: "trail-delivery",
      sessionID: nested,
    });
    await expect(agent(nested)).toHaveCount(0);
    await visibleOnScreen(agent(helper));
    await activity(state, helper, "release");
    await visibleOnScreen(agent(helper));
    await viewByUrl(state, page, helper);
    await expect(crumb(helper).locator(".otk-status-light")).toHaveAttribute(
      "data-state",
      "none",
    );
    await crumb(root).click();
    await inventory.click();
    await visibleOnScreen(agent(helper));
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "release",
      target: "trail-delivery",
      sessionID: helper,
    });
    await expect(agent(helper)).toHaveCount(0);
    await expect(inventory).toHaveCount(0);
  },
);
