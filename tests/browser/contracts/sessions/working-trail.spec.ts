// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { activity, viewByUrl, visibleOnScreen } from "../../pages/sessions.ts";

test.use({ profile: "contract-sessions-hierarchy" });
test(
  "sessions.native-running-inventory-keeps-three-blocked-helpers-in-the-four-helper-count",
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
    const inventory = page.getByRole("button", {
      name: "Running work: 4 subagents",
    });
    await expect(inventory).toBeVisible();
    for (let n = 0; n < 4; n++) {
      await expect(page.locator(`[data-crumb="tstv1-delivery-helper-${n}"]`))
        .toBeVisible();
    }
    await inventory.click();
    await expect(page.locator("[data-running-work^='helper/']")).toHaveCount(4);
    await expect(
      page.locator(
        "[data-running-work] > .otk-status-light[data-state=blocked]",
      ),
    ).toHaveCount(3);
    await expect(
      page.locator(
        "[data-running-work] > .otk-status-light[data-state=working]",
      ),
    ).toHaveCount(1);
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
test("sessions.working-helpers-share-composer-and-trail-lifetime", {
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
  await expect(page.getByRole("button", { name: "Running work: 2 subagents" }))
    .toBeVisible();
  await visibleOnScreen(crumb(helper));
  await visibleOnScreen(crumb(nested));
  await expect(crumb(helper).locator(".otk-status-light"))
    .toHaveAttribute("data-state", "working");
  for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await visibleOnScreen(crumb(helper));
    await visibleOnScreen(crumb(nested));
    await page.screenshot({
      path: info.outputPath(`fx45-${theme}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
  await crumb(nested).click();
  await expect(page).toHaveURL(new RegExp(`${nested}$`));
  await activity(state, helper, "release");
  await activity(state, nested, "release");
  // Completion cannot hide the open session or its ancestors.
  await visibleOnScreen(crumb(root));
  await visibleOnScreen(crumb(helper));
  await visibleOnScreen(crumb(nested));
  await crumb(root).click();
  await visibleOnScreen(crumb(helper));
  await expect(crumb(helper).locator(".otk-status-light")).toHaveAttribute(
    "data-state",
    "finished",
  );
  await crumb(helper).click();
  await expect(crumb(helper).locator(".otk-status-light")).toHaveAttribute(
    "data-state",
    "none",
  );
  await crumb(root).click();
  await expect(crumb(helper)).toHaveCount(0);
  await expect(crumb(nested)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Running work:/ }))
    .toHaveCount(0);
  await page.reload();
  await visibleOnScreen(crumb(root));
  await expect(crumb(helper)).toHaveCount(0);
  await activity(state, helper, "hold");
  await visibleOnScreen(crumb(helper));
  await expect(page.getByRole("button", { name: "Running work: 1 subagent" }))
    .toBeVisible();
  await activity(state, helper, "release");
  await visibleOnScreen(crumb(helper));
  await expect(crumb(helper).locator(".otk-status-light")).toHaveAttribute(
    "data-state",
    "finished",
  );
  await crumb(helper).click();
  await expect(crumb(helper).locator(".otk-status-light")).toHaveAttribute(
    "data-state",
    "none",
  );
  await crumb(root).click();
  await expect(crumb(helper)).toHaveCount(0);
});
