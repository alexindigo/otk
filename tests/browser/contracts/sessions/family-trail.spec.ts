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
test("sessions.blocked-and-unseen-helpers-remain-individual-visible-crumbs", {
  tag: ["@sessions", "@projects", "@contracts"],
}, async ({ isolatedState: state, page }, info) => {
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
  await visibleOnScreen(crumb(helper));
  await visibleOnScreen(crumb(nested));
  await activity(state, helper, "freeze");
  await activity(state, nested, "release");
  for (const [id, status] of [[helper, "blocked"], [nested, "finished"]]) {
    await visibleOnScreen(crumb(id));
    await expect(crumb(id).locator(".otk-status-light")).toHaveAttribute(
      "data-state",
      status,
    );
  }
  await page.reload();
  await collapsed(page);
  for (const id of [root, helper, nested]) await visibleOnScreen(crumb(id));
  await expect(page.getByRole("button", { name: /^Running helpers/ }))
    .toHaveCount(0);
  for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await visibleOnScreen(crumb(helper));
    await visibleOnScreen(crumb(nested));
    await page.screenshot({
      path: info.outputPath(`wp3-${theme}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
  await crumb(nested).click();
  await expect(page).toHaveURL(new RegExp(`${nested}$`));
  await expect(crumb(nested).locator(".otk-status-light")).toHaveAttribute(
    "data-state",
    "none",
  );
  await crumb(root).click();
  await expect(crumb(nested)).toHaveCount(0);
  await visibleOnScreen(crumb(helper));
  await activity(state, helper, "release");
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
