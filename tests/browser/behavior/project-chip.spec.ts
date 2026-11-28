// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../fixtures/evidence.ts";
import { openSession, wire } from "../fixtures/wire.ts";
import { clipboard, copied } from "../pages/menus.ts";

test("chrome.project-chip-native-facts-menu-and-copy-path", {
  tag: ["@visual", "@sessions", "@menus"],
}, async ({ state, page }, info) => {
  const traffic = await wire(page);
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Project chip native facts",
  });
  await openSession(state, page, session.id);
  await clipboard(page);
  const chip = page.locator(".otk-project-chip-trigger");
  await expect(chip).toBeVisible();
  await expect(chip.locator(".otk-project-avatar")).toBeVisible();
  await expect(chip.locator(".otk-control-label")).not.toBeEmpty();
  await expect.poll(() =>
    traffic.received.filter((frame) =>
      frame.t === "catalog.chunk" && frame.kind === "project"
    ).length
  ).toBeGreaterThan(0);
  expect(
    traffic.sent.some(({ frame }) =>
      frame.method === "catalogs.demand" &&
      (frame.params?.kinds as string[])?.includes("repository")
    ),
  ).toBe(false);
  await chip.click();
  const menu = page.locator(".otk-project-chip-menu :popover-open").first();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("heading")).toBeVisible();
  await expect(menu.locator("[disabled],[aria-disabled=true]")).toHaveCount(0);
  const path = menu.locator("button").filter({ hasText: state.directory });
  await expect(path).toBeVisible();
  await expect.poll(() =>
    traffic.received.filter((frame) =>
      frame.t === "catalog.chunk" && frame.kind === "repository"
    ).length
  ).toBeGreaterThan(0);
  const projectFrame = traffic.received.filter((frame) =>
    frame.t === "catalog.chunk" && frame.kind === "project"
  ).at(-1)!;
  const project = (projectFrame.items as {
    name?: string;
    root?: string;
    repository?: string;
    machine?: string;
  }[])[0];
  if (project?.name) {
    await expect(chip.locator(".otk-control-label")).toHaveText(project.name);
  }
  if (project?.repository) {
    await expect(menu.getByText(project.repository, { exact: true }))
      .toBeVisible();
  }
  if (project?.machine) {
    await expect(menu.getByText(project.machine, { exact: true }))
      .toBeVisible();
  } else {await expect(menu.getByText("This server", { exact: true }))
      .toHaveCount(0);}
  const repositoryFrame = traffic.received.filter((frame) =>
    frame.t === "catalog.chunk" && frame.kind === "repository"
  ).at(-1)!;
  const repository =
    (repositoryFrame.items as { branch?: string; changes?: string }[])[0];
  if (repository?.branch) {
    await expect(menu.locator("button").filter({ hasText: repository.branch }))
      .toBeVisible();
  }
  if (repository?.changes) {
    await expect(menu.getByText(repository.changes, { exact: true }))
      .toBeVisible();
  }
  for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    const gaps = await path.evaluate((control) => {
      const icon = control.querySelector(".otk-control-accessory svg")!
        .getBoundingClientRect();
      const box = control.getBoundingClientRect();
      return [
        box.right - icon.right,
        icon.top - box.top,
        box.bottom - icon.bottom,
      ];
    });
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: info.outputPath(`project-chip-${theme}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
  await path.click();
  const copy = page.getByRole("menuitem", { name: "Copy path", exact: true });
  await expect(copy).toBeVisible();
  await copy.click();
  await expect(menu).toBeHidden();
  await copied(page, state.directory);
  await expect(chip).toBeFocused();
  await chip.focus();
  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  if (repository?.branch) {
    await menu.locator("button").filter({ hasText: repository.branch }).click();
    await page.getByRole("menuitem", { name: "Copy branch", exact: true })
      .click();
    await copied(page, repository.branch);
    await expect(menu).toBeHidden();
    await expect(chip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(chip).toBeFocused();
});
