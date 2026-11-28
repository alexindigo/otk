// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../fixtures/evidence.ts";
import { isolatedTest as test } from "../fixtures/isolated.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openSession } from "../fixtures/wire.ts";

test.use({ profile: "isolated" });
test("projects.native-settings-update-chip-sidebar-and-menu-geometry", {
  tag: ["@projects", "@visual"],
}, async ({ isolatedState: state, page }, info) => {
  // The ordinary fixture's empty Git repository is native-global. A real root
  // commit and fixture-only restart establish independent native ownership.
  await promisify(execFile)("git", [
    "-C",
    state.directory,
    "-c",
    "user.name=OTK Fixture",
    "-c",
    "user.email=fixture@otk.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "Project settings fixture",
  ]);
  await state.controller.call("restart", {
    lease: state.lease.lease,
    target: "native",
  });
  await state.controller.call("restart", {
    lease: state.lease.lease,
    target: "sidecar",
  });
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Project settings fixture",
  });
  await openSession(state, page, session.id);
  const original = await state.product("project.settings", {
    directory: state.directory,
  });
  expect(
    original.projectID,
    "Only mutate this fixture's project, never global native metadata",
  ).not.toBe("global");
  const chip = page.locator(".otk-project-chip-trigger");
  await chip.click();
  await page.getByRole("menuitem", { name: "Edit project", exact: true })
    .click();
  const settings = page.getByRole("dialog").filter({
    has: page.getByRole("textbox", { name: "Project name", exact: true }),
  });
  await expect(settings).toBeVisible();
  await expect(settings.getByText("Auto-accept permissions", { exact: true }))
    .toHaveCount(0);
  await settings.getByRole("textbox", { name: "Project name", exact: true })
    .fill("WP9 Native Project");
  await settings.getByRole("button", { name: "Blue color", exact: true })
    .click();
  await expect(
    settings.getByRole("button", { name: "Blue color", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await settings.getByRole("textbox", {
    name: "Worktree startup script",
    exact: true,
  }).fill("echo fixture-start");
  await settings.getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(async () =>
    (await state.product("project.settings", { directory: state.directory }))
      .values
  ).toMatchObject({
    name: "WP9 Native Project",
    color: "blue",
    startScript: "echo fixture-start",
  });
  await expect(chip).toContainText("WP9 Native Project");
  await expect(
    page.locator(`[data-project="${state.directory}"] .otk-sidebar-title-text`),
  ).toHaveText("WP9 Native Project");
  const icon = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#3250df"/></svg>',
  );
  await settings.locator('input[type="file"]').setInputFiles({
    name: "fixture.svg",
    mimeType: "image/svg+xml",
    buffer: icon,
  });
  await expect(
    settings.getByRole("button", { name: "Remove icon", exact: true }),
  ).toBeVisible();
  await settings.getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(chip.locator("img")).toHaveAttribute(
    "src",
    /^data:image\/svg\+xml;base64,/,
  );
  await settings.getByRole("button", { name: "Remove icon", exact: true })
    .click();
  await settings.getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(chip.locator("img")).toHaveCount(0);
  // Dirty dismissal is retained unless the user explicitly discards.
  await settings.getByRole("textbox", { name: "Project name", exact: true })
    .fill("Unsaved");
  await settings.getByRole("button", { name: /^Close / }).click();
  await settings.getByRole("button", { name: "Keep editing", exact: true })
    .click();
  await expect(settings).toBeVisible();
  await expect(
    settings.getByRole("textbox", { name: "Project name", exact: true }),
  ).toHaveValue("Unsaved");
  await settings.getByRole("button", { name: /^Close / }).click();
  await settings.getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(settings).toBeHidden();
  for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await chip.click();
    const menu = page.locator(".otk-project-chip-menu :popover-open").first();
    await expect(menu).toBeVisible();
    const starts = await menu.locator(
      ".otk-project-chip-menu-row .otk-control-value-label",
    ).evaluateAll((labels) =>
      labels.filter((label) => label.getClientRects().length).map((label) =>
        label.getBoundingClientRect().left
      )
    );
    expect(starts.length).toBeGreaterThan(2);
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: info.outputPath(`wp9-menu-${theme}.png`),
      fullPage: true,
      animations: "disabled",
    });
    await menu.getByRole("menuitem", { name: "Edit project", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`wp9-settings-${theme}.png`),
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("dialog").getByRole("button", { name: /^Close / })
      .click();
  }
  // The fixture is isolated; restoring still proves clearing every native field.
  await state.product("project.update", {
    ...original,
    patch: original.values,
  });
  await expect.poll(async () =>
    (await state.product("project.settings", { directory: state.directory }))
      .values
  ).toEqual(original.values);
});
