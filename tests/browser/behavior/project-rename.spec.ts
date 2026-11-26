// SPDX-License-Identifier: LGPL-3.0-only
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { expect } from "../fixtures/evidence.ts";
import { isolatedTest as test } from "../fixtures/isolated.ts";
import type { TestState } from "../fixtures/test-state.ts";
import { openSession, wire } from "../fixtures/wire.ts";

const tag = ["@sessions", "@projects", "@visual"];
const rename = (page: Page) =>
  page.getByRole("menuitem", { name: "Rename", exact: true });
const reset = (page: Page) =>
  page.getByRole("menuitem", { name: "Reset name", exact: true });
const editor = (page: Page) =>
  page.getByRole("textbox", { name: "Rename project", exact: true });
const row = (state: TestState, page: Page) =>
  page.locator(`[data-project="${state.directory}"]`);
const settings = (state: TestState) =>
  state.product("project.settings", { directory: state.directory });
const restart = async (state: TestState) => {
  for (const target of ["native", "sidecar"] as const) {
    await state.controller.call("restart", {
      lease: state.lease.lease,
      target,
    });
  }
};

async function openMenu(state: TestState, page: Page) {
  await row(state, page).getByRole("button", { name: /^Project menu for / })
    .click();
}

async function begin(state: TestState, page: Page) {
  await openMenu(state, page);
  await rename(page).click();
  await expect(editor(page)).toBeFocused();
}

async function save(state: TestState, page: Page, name: string) {
  await editor(page).fill(name);
  await editor(page).press("Enter");
  await expect(row(state, page).locator(".otk-project-name")).toHaveText(name);
}

test.use({ profile: "isolated", viewport: { width: 1440, height: 900 } });
test.beforeEach(async ({ isolatedState: state, page }) => {
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
    "Project rename fixture",
  ]);
  await restart(state);
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Release checklist",
  });
  await openSession(state, page, session.id);
  expect((await settings(state)).projectID).not.toBe("global");
});

test(
  "projects.sidebar-rename-inline",
  { tag },
  async ({ isolatedState: state, page }) => {
    const transport = await wire(page);
    await page.reload();
    const label = row(state, page).locator(".otk-project-name");
    const folder = basename(state.directory);
    await expect(label).toHaveText(folder);
    await openMenu(state, page);
    await expect(rename(page)).toBeVisible();
    await expect(reset(page)).toHaveCount(0);
    await rename(page).click();
    const input = editor(page);
    await expect(input).toBeFocused();
    expect(
      await input.evaluate((el: HTMLInputElement) =>
        el.value.slice(el.selectionStart!, el.selectionEnd!)
      ),
    ).toBe(folder);
    transport.hold((frame, request) =>
      frame.t === "request.result" && request?.method === "project.update"
    );
    try {
      await input.fill("Fixture app");
      await input.press("Enter");
      await input.blur();
      // Native readback and publication may arrive before the reply reaches the
      // editor. Neither the typed name nor the publication alone closes it.
      // The request protocol can replay a result whose acknowledgement is held.
      await expect.poll(() => transport.held.length).toBeGreaterThan(0);
      await expect(page.locator(".otk-project-chip-trigger")).toContainText(
        "Fixture app",
      );
      await expect(input).toHaveAttribute("aria-busy", "true");
      await expect(input).toHaveValue("Fixture app");
      await input.focus();
    } finally {
      transport.release();
    }
    await expect(label).toHaveText("Fixture app");
    expect(
      new Set(
        transport.sent.filter(({ frame }) =>
          frame.t === "request" && frame.method === "project.update"
        ).map(({ frame }) => frame.ref?.key),
      ).size,
    ).toBe(1);
    expect((await settings(state)).values.name).toBe("Fixture app");
    await expect(page.locator(".otk-project-chip-trigger")).toContainText(
      "Fixture app",
    );
    await expect(page).toHaveTitle(/Fixture app/);
    await expect(row(state, page).locator(".otk-project-open")).toBeFocused();
    await openMenu(state, page);
    await expect(reset(page)).toBeVisible();
  },
);

test(
  "projects.sidebar-rename-everywhere-and-restart",
  { tag },
  async ({ isolatedState: state, page, browser }) => {
    const context = await browser.newContext({
      storageState: await page.context().storageState(),
    });
    try {
      const other = await context.newPage();
      await other.goto(page.url());
      const otherLabel = row(state, other).locator(".otk-project-name");
      await expect(otherLabel).toHaveText(basename(state.directory));
      await begin(state, page);
      await save(state, page, "Fixture app");
      await expect(otherLabel).toHaveText("Fixture app");
      await restart(state);
      await page.reload();
      await other.reload();
      await expect(row(state, page).locator(".otk-project-name")).toHaveText(
        "Fixture app",
      );
      await expect(otherLabel).toHaveText("Fixture app");
    } finally {
      await context.close();
    }
  },
);

test(
  "projects.sidebar-rename-cancel-and-empty",
  { tag },
  async ({ isolatedState: state, page }) => {
    await begin(state, page);
    await editor(page).fill("Canceled");
    await editor(page).press("Escape");
    await expect(row(state, page).locator(".otk-project-name")).toHaveText(
      basename(state.directory),
    );
    await expect(row(state, page).locator(".otk-project-open")).toBeFocused();
    expect((await settings(state)).values.name).toBe("");
    await begin(state, page);
    await editor(page).fill("");
    await editor(page).press("Enter");
    await expect(editor(page)).toHaveAttribute("aria-invalid", "true");
    await expect(
      row(state, page).getByText(
        "Enter a name. Reset name in the row menu restores the folder name.",
      ),
    ).toBeVisible();
    expect((await settings(state)).values.name).toBe("");
    await editor(page).press("Escape");
    await expect(editor(page)).toHaveCount(0);
  },
);

test(
  "projects.sidebar-rename-reset",
  { tag },
  async ({ isolatedState: state, page }) => {
    await begin(state, page);
    await editor(page).fill("Fixture app");
    // Departure commits through the same editor as Enter.
    await editor(page).press("Tab");
    await expect.poll(async () => (await settings(state)).values.name, {
      message: "Blur commits to native",
    }).toBe("Fixture app");
    await expect(row(state, page).locator(".otk-project-name")).toHaveText(
      "Fixture app",
    );
    await row(state, page).locator(".otk-project-open").click({
      button: "right",
    });
    await reset(page).click();
    await expect.poll(async () => (await settings(state)).values.name, {
      message: "Reset name applies to the native project",
    }).toBe("");
    await expect(row(state, page).locator(".otk-project-name")).toHaveText(
      basename(state.directory),
    );
    await openMenu(state, page);
    await expect(reset(page)).toHaveCount(0);
  },
);

test(
  "projects.sidebar-rename-keyboard",
  { tag },
  async ({ isolatedState: state, page }) => {
    const project = row(state, page);
    await project.locator(".otk-project-open").focus();
    await page.keyboard.press("Tab");
    await expect(project.getByRole("button", { name: /^Project menu for / }))
      .toBeFocused();
    await page.keyboard.press("Enter");
    if (!await rename(page).evaluate((el) => el === document.activeElement)) {
      await page.keyboard.press("ArrowDown");
    }
    await expect(rename(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(editor(page)).toBeFocused();
    await save(state, page, "Fixture app");
    await expect(project.locator(".otk-project-open")).toBeFocused();
  },
);

test(
  "projects.sidebar-rename-geometry",
  { tag },
  async ({ isolatedState: state, page }, info) => {
    const project = row(state, page);
    for (
      const [theme, name] of [["otk-dark", "dark"], ["otk-light", "linen"], [
        "otk-light-stone",
        "stone",
      ]]
    ) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      const capture = (state: string) =>
        page.screenshot({
          path: info.outputPath(`project-rename-${state}-${name}.png`),
          fullPage: true,
          animations: "disabled",
        });
      const resting = (await project.boundingBox())!.height;
      await openMenu(state, page);
      await expect(rename(page)).toBeVisible();
      const starts = await page.getByRole("menuitem").locator(
        ".otk-control-label",
      ).evaluateAll((labels) =>
        labels.filter((el) => el.getClientRects().length).map((el) =>
          el.getBoundingClientRect().left
        )
      );
      expect(starts.length).toBeGreaterThan(1);
      expect(Math.max(...starts) - Math.min(...starts)).toBeLessThanOrEqual(1);
      await capture("menu");
      await rename(page).click();
      await expect(editor(page)).toBeFocused();
      expect((await project.boundingBox())!.height).toBeCloseTo(resting, 1);
      const { left, right, token } = await editor(page).evaluate((el) => {
        const s = getComputedStyle(el);
        const ruler = document.createElement("span");
        ruler.style.cssText =
          "position:absolute;visibility:hidden;width:var(--space-1)";
        el.parentElement!.append(ruler);
        const result = {
          left: parseFloat(s.paddingLeft),
          right: parseFloat(s.paddingRight),
          token: ruler.getBoundingClientRect().width,
        };
        ruler.remove();
        return result;
      });
      expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
      expect(Math.min(left, right)).toBeGreaterThanOrEqual(token);
      await capture("inline");
      await editor(page).fill("");
      await editor(page).press("Enter");
      await expect(editor(page)).toHaveAttribute("aria-invalid", "true");
      const invalid = project.getByRole("alert");
      await expect(invalid).toHaveText(
        "Enter a name. Reset name in the row menu restores the folder name.",
      );
      expect(
        await invalid.evaluate((el) =>
          el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth
        ),
      ).toBe(true);
      await capture("invalid");
      await save(state, page, "Fixture app");
      await expect(page.locator(".otk-project-chip-trigger")).toContainText(
        "Fixture app",
      );
      await expect(page).toHaveTitle(/Fixture app/);
      await expect(
        page.getByRole("tablist", { name: "Tasks and active sessions" }),
      ).toContainText("Release checklist");
      await expect(page.getByRole("navigation", { name: "Task sessions" }))
        .toContainText("Release checklist");
      await capture("renamed");
      await openMenu(state, page);
      await reset(page).click();
      await expect(project.locator(".otk-project-name")).toHaveText(
        basename(state.directory),
      );
    }
  },
);
