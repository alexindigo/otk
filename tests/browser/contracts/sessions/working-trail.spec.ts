// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { activity, viewByUrl, visibleOnScreen } from "../../pages/sessions.ts";
import { subagents } from "../../pages/crumbs.ts";

test.use({ profile: "contract-sessions-hierarchy" });
test(
  "sessions.subagents-counts-the-two-blocked-in-task-helpers-without-foreign-tasks",
  {
    tag: ["@sessions", "@attention", "@contracts"],
  },
  async ({ isolatedState: state, page }, info) => {
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "hold",
      target: "delivery-helpers",
      sessionID: "tstv1-otk",
    });
    await state.product("tasks.create", {
      directory: state.directory,
      name: "Parent task",
      sessions: ["tstv1-otk"],
    });
    await viewByUrl(state, page, "tstv1-otk");
    const inventory = subagents(page);
    await expect(inventory).toBeVisible();
    // D70: the legacy helper-only task in the other checkout cannot take
    // either helper out of the human root's task.
    await expect(inventory).toHaveAccessibleName(
      "Subagents: 1 running, 3 need you",
    );
    // D67 ancestry is independent of D66's in-task helper inventory.
    for (let n = 0; n < 4; n++) {
      await expect(page.locator(`[data-crumb="tstv1-delivery-helper-${n}"]`))
        .toHaveCount(0);
    }
    await inventory.click();
    await expect(page.locator("[data-subagent]")).toHaveCount(4);
    await expect(
      page.locator(
        "[data-subagent] .otk-status-light[data-state=blocked]",
      ),
    ).toHaveCount(3);
    await expect(
      page.locator(
        "[data-subagent] .otk-status-light[data-state=working]",
      ),
    ).toHaveCount(1);
    for (const n of [2, 3]) {
      await expect(page.locator(`[data-subagent="tstv1-delivery-helper-${n}"]`))
        .toHaveCount(1);
    }
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await page.screenshot({
        path: info.outputPath(`wp14-helpers-${theme}.png`),
        fullPage: true,
        animations: "disabled",
      });
    }
  },
);
test("sessions.working-inventory-ends-but-undelivered-trail-retains-helpers", {
  tag: ["@sessions", "@contracts"],
}, async ({ isolatedState: state, page }, info) => {
  const root = "tstv1-otk", helper = "tstv1-helper", nested = "tstv1-nested";
  await state.product("tasks.create", {
    directory: state.directory,
    name: "Working trail",
    sessions: [root],
  });
  await activity(state, helper, "hold");
  await activity(state, nested, "hold");
  await viewByUrl(state, page, root);
  const crumb = (id: string) => page.locator(`[data-crumb="${id}"]`);
  const agent = (id: string) => page.locator(`[data-subagent="${id}"]`);
  const inventory = subagents(page);
  await expect(inventory).toHaveAccessibleName("Subagents: 2 running");
  await expect(crumb(helper)).toHaveCount(0);
  await inventory.click();
  await visibleOnScreen(agent(helper));
  await visibleOnScreen(agent(nested));
  await expect(agent(helper).locator(".otk-status-light"))
    .toHaveAttribute("data-state", "working");
  for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await visibleOnScreen(agent(helper));
    await visibleOnScreen(agent(nested));
    await page.screenshot({
      path: info.outputPath(`fx45-${theme}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
  await agent(nested).locator(".otk-subagent-name").click();
  await expect(page).toHaveURL(new RegExp(`${nested}$`));
  await activity(state, helper, "release");
  await activity(state, nested, "release");
  // D66: completion without delivery retains helpers, even after human seen.
  await visibleOnScreen(crumb(root));
  await visibleOnScreen(crumb(helper));
  await visibleOnScreen(crumb(nested));
  await crumb(root).click();
  await inventory.click();
  await visibleOnScreen(agent(helper));
  await visibleOnScreen(agent(nested));
  await viewByUrl(state, page, helper);
  await expect(crumb(helper).locator(".otk-status-light")).toHaveAttribute(
    "data-state",
    "none",
  );
  await crumb(root).click();
  for (const sessionID of [helper, nested]) {
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "release",
      target: "trail-delivery",
      sessionID,
    });
  }
  await expect(crumb(helper)).toHaveCount(0);
  await expect(crumb(nested)).toHaveCount(0);
  await expect(inventory).toHaveCount(0);
  await page.reload();
  await visibleOnScreen(crumb(root));
  await expect(crumb(helper)).toHaveCount(0);
  await activity(state, helper, "hold");
  await expect(crumb(helper)).toHaveCount(0);
  await expect(inventory).toHaveAccessibleName("Subagents: 1 running");
  await inventory.click();
  await visibleOnScreen(agent(helper));
  await activity(state, helper, "release");
  await visibleOnScreen(agent(helper));
  await viewByUrl(state, page, helper);
  await expect(crumb(helper).locator(".otk-status-light")).toHaveAttribute(
    "data-state",
    "none",
  );
  await crumb(root).click();
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "release",
    target: "trail-delivery",
    sessionID: helper,
  });
  await expect(crumb(helper)).toHaveCount(0);
});
