// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt, reply } from "../../pages/composer.ts";
import {
  appActions,
  dismiss,
  groups,
  menuLabels,
  panelActions,
  pick,
  rightClick,
} from "../../pages/menus.ts";

test("menus.native-area-picker-approval-and-activity-consumers", {
  tag: ["@menus"],
}, async ({ state, page }) => {
  const created = await state.native<{ id: string }>("/session", "POST", {
    title: "Area commands",
  });
  await openSession(state, page, created.id);
  await expect(page.locator(".otk-composer-model-name")).toHaveText("scripted");
  for (
    const [area, expected] of [
      [".otk-inbox-scroll", [["Add project", "Collapse projects"], appActions]],
      [".otk-panel-content", [panelActions, appActions.slice(1)]],
      [".otk-messages", [[
        "Pin as task",
        "Rename",
        "Fork session",
        "Turn auto-approve on",
        "Compact",
        "Copy session title",
        "Close session",
        "Delete",
      ], appActions]],
      [".otk-prompt-actions", [[
        "Choose agent",
        "Choose model",
        "Edit prompt",
        "Attach files",
      ], appActions]],
    ] as const
  ) {
    await rightClick(page, area, true);
    expect(await groups(page)).toEqual(expected);
    await dismiss(page);
  }
  for (const kind of ["agent", "model"]) {
    await rightClick(page, ".otk-prompt-actions", true);
    await pick(page, `Choose ${kind}`);
    const panel = page.locator(
      `.otk-${kind}-picker .otk-popover-panel:popover-open`,
    );
    await expect(panel.locator(".otk-picker-row").first()).toBeVisible();
    expect(await panel.evaluate((el) => el.contains(document.activeElement)))
      .toBe(true);
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
  }
  await rightClick(page, ".otk-messages", true);
  await pick(page, "Turn auto-approve on");
  await expect(page.locator(".otk-auto-approve-toggle")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("[data-crumb] .otk-auto-mark")).toHaveCount(0);
  await rightClick(page, ".otk-messages", true);
  expect((await groups(page))[0]).toContain("Turn auto-approve off");
  await pick(page, "Turn auto-approve off");
  await expect(page.locator(".otk-auto-approve-toggle")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.locator("[data-crumb] .otk-auto-mark")).toHaveCount(0);
  await page.locator("[data-panel-view=activity]").click();
  await expect(page.locator("#otk-panel-content")).toHaveAttribute(
    "aria-label",
    "Activity",
  );
  await rightClick(page, ".otk-panel-content", true);
  expect(await groups(page)).toEqual([
    ["New session", "Collapse right panel"],
    appActions.slice(1),
  ]);
  await pick(page, "Collapse right panel");
  await expect(page.locator(".otk-app")).toHaveAttribute(
    "data-right-collapsed",
    "true",
  );
});

test("menus.native-background-auto-approve-target-and-real-reply-usage", {
  tag: ["@menus"],
}, async ({ state, page }) => {
  const first = await state.native<{ id: string }>("/session", "POST", {
    title: "Viewed session",
  });
  const other = await state.native<{ id: string }>("/session", "POST", {
    title: "Context session",
  });
  await openSession(state, page, first.id);
  await rightClick(page, `[data-session="${other.id}"]`);
  expect(await menuLabels(page)).toEqual([
    "Open",
    "Pin as task",
    "Rename",
    "Fork session",
    "Turn auto-approve on",
    "Copy session title",
    "Delete",
    ...panelActions,
  ]);
  await pick(page, "Turn auto-approve on");
  await expect(page.locator(`[data-session="${other.id}"] .otk-auto-mark`))
    .toHaveCount(0);
  await expect(page.locator(`[data-session="${first.id}"] .otk-auto-mark`))
    .toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(first.id + "$"));
  await rightClick(page, `[data-session="${other.id}"]`);
  expect(await menuLabels(page)).toContain("Turn auto-approve off");
  await pick(page, "Turn auto-approve off");
  await expect(page.locator(`[data-session="${other.id}"] .otk-auto-mark`))
    .toHaveCount(0);
  await state.queue(["Usage menu reply."]);
  await prompt(page).pressSequentially("Give a short reply");
  await prompt(page).press("Enter");
  await reply(state, page, first.id, "Usage menu reply.");
  await expect(page.locator(".otk-turn-usage > button")).toBeVisible();
  await rightClick(page, "[data-role=assistant] .otk-text p");
  expect(await menuLabels(page)).toEqual([
    "Copy reply",
    "Fork from here",
    "Show usage breakdown",
    "Rename",
    "Fork session",
    "Turn auto-approve on",
    "Compact",
    "Copy session title",
    "Close session",
    "Delete",
  ]);
  await pick(page, "Show usage breakdown");
  const rows = page.locator(
    ".otk-turn-usage :popover-open .otk-usage-breakdown tbody tr",
  );
  await expect(rows).toHaveCount(1);
  await expect(rows.locator("td").first()).toHaveText("answered");
});
