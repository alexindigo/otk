// SPDX-License-Identifier: LGPL-3.0-only
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { expect } from "../fixtures/evidence.ts";
import { isolatedTest as test } from "../fixtures/isolated.ts";
import type { TestState } from "../fixtures/test-state.ts";
import { openSession, wire } from "../fixtures/wire.ts";
import { sessionContext } from "../pages/sessions.ts";

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
  await expect(row(state, page).locator(".otk-sidebar-title-text")).toHaveText(
    name,
  );
  await expect(row(state, page).locator(".otk-rename-pending")).toHaveCount(0);
}

async function watchSubmit(page: Page, selector: string) {
  return await page.evaluateHandle((selector) => {
    const result: (string | null)[] = [];
    document.addEventListener("keydown", function enter(event) {
      if (event.key !== "Enter") return;
      document.removeEventListener("keydown", enter, true);
      requestAnimationFrame(function sample() {
        result.push(
          document.querySelector(selector)?.textContent?.trim() ?? null,
        );
        if (result.length < 240) requestAnimationFrame(sample);
      });
    }, true);
    return result;
  }, selector);
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
  "projects.pointer-rename-return-does-not-paint-selection",
  { tag },
  async ({
    isolatedState: state,
    page,
  }) => {
    const other = await state.controller.call<
      { directory: string; id: string }
    >(
      "nativeRequest",
      {
        lease: state.lease.lease,
        path: "/session",
        method: "POST",
        project: "secondary",
        body: { title: "Another project's session" },
      },
    );
    const old = row(state, page);
    const target = page.locator(
      `[data-project=${JSON.stringify(other.directory)}] .otk-project-open`,
    );
    const quiet = async () => {
      await expect.soft(old.locator(":focus-visible")).toHaveCount(0);
      await expect.soft(old.locator(".otk-sidebar-control")).toHaveCSS(
        "opacity",
        "0",
      );
    };
    await begin(state, page);
    await page.mouse.move(700, 400);
    await save(state, page, "Renamed project");
    await quiet();
    await target.click();
    await expect(page).toHaveURL(new RegExp(`${other.id}$`));
    await page.mouse.move(700, 400);
    await quiet();
    await expect(
      page.locator(
        `[data-project=${
          JSON.stringify(other.directory)
        }] .otk-sidebar-control`,
      ),
    )
      .toHaveCSS("opacity", "0");
  },
);

test(
  "projects.sidebar-rename-inline",
  { tag },
  async ({ isolatedState: state, page }) => {
    const transport = await wire(page);
    await page.reload();
    const label = row(state, page).locator(".otk-sidebar-title-text");
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
    const frames = await watchSubmit(
      page,
      `[data-project=${
        JSON.stringify(state.directory)
      }] .otk-sidebar-title-text`,
    );
    transport.hold((frame, request) =>
      (frame.t === "request.result" && request?.method === "project.update") ||
      (frame.t === "inbox.summaries" &&
        JSON.stringify(frame).includes("Fixture app"))
    );
    try {
      await input.fill("Fixture app");
      await input.press("Enter");
      await expect(label).toHaveText("Fixture app");
      await expect(label.locator(".otk-rename-pending")).toBeVisible();
      await expect.poll(() => frames.evaluate((samples) => samples[0]))
        .toBe("Fixture app");
      await expect.poll(() => transport.held.length).toBeGreaterThan(0);
      await expect(input).toHaveCount(0);
    } finally {
      transport.release();
    }
    await expect(label).toHaveText("Fixture app");
    await expect(label.locator(".otk-rename-pending")).toHaveCount(0);
    expect(await frames.evaluate((samples) => [...new Set(samples)])).toEqual([
      "Fixture app",
    ]);
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
  "projects.sidebar-rename-session-inline",
  { tag },
  async ({ isolatedState: state, page }) => {
    const transport = await wire(page);
    await page.reload();
    const row = ".otk-project-sessions .otk-session-row[data-session]";
    const selector = `${row} .otk-sidebar-title-text`;
    const label = page.locator(selector);
    await expect(label).toHaveText("Release checklist");
    await sessionContext(page, row, "session.rename");
    const input = page.getByRole("textbox", {
      name: "Rename session",
      exact: true,
    });
    await input.fill("Updated checklist");
    const frames = await watchSubmit(page, selector);
    transport.hold((frame, request) =>
      frame.t === "request.result" && request?.method === "session.rename"
    );
    try {
      await input.press("Enter");
      await expect(label.locator(".otk-rename-pending")).toHaveText(
        "Updated checklist",
      );
      await expect.poll(() => frames.evaluate((samples) => samples[0])).toBe(
        "Updated checklist",
      );
      await expect.poll(() => transport.held.length).toBeGreaterThan(0);
    } finally {
      transport.release();
    }
    await expect(label).toHaveText("Updated checklist");
    await expect(label.locator(".otk-rename-pending")).toHaveCount(0);
    expect(await frames.evaluate((samples) => [...new Set(samples)])).toEqual([
      "Updated checklist",
    ]);
    const sessionID = (await page.locator(row).getAttribute("data-session"))!;
    expect((await state.product("session.get", { sessionID })).title).toBe(
      "Updated checklist",
    );
  },
);

for (const kind of ["project", "session"] as const) {
  test(
    `projects.sidebar-rename-${kind}-failure`,
    { tag },
    async ({ isolatedState: state, page }) => {
      const method = kind === "project" ? "project.update" : "session.rename";
      const transport = await wire(
        page,
        (frame) => frame.method === method ? { ...frame, params: {} } : frame,
      );
      await page.reload();
      const sessionRow = ".otk-project-sessions .otk-session-row[data-session]";
      const item = kind === "project"
        ? `[data-project=${JSON.stringify(state.directory)}]`
        : sessionRow;
      const selector = `${item} .otk-sidebar-title-text`;
      const label = page.locator(selector);
      const confirmed = kind === "project"
        ? basename(state.directory)
        : "Release checklist";
      await expect(label).toHaveText(confirmed);
      if (kind === "project") await begin(state, page);
      else await sessionContext(page, sessionRow, "session.rename");
      const input = page.getByRole("textbox", {
        name: `Rename ${kind}`,
        exact: true,
      });
      await input.fill("Rejected fixture");
      const frames = await watchSubmit(page, selector);
      transport.hold((_frame, request) => request?.method === method);
      try {
        await input.press("Enter");
        await expect(label).toHaveText("Rejected fixture");
        await expect(label.locator(".otk-rename-pending")).toBeVisible();
        await expect.poll(() => frames.evaluate((samples) => samples[0]))
          .toBe("Rejected fixture");
        await expect.poll(() => transport.held.length).toBeGreaterThan(0);
      } finally {
        transport.release();
      }
      await expect(label).toHaveText(confirmed);
      await expect(label.locator(".otk-rename-pending")).toHaveCount(0);
      await expect(page.locator(item).getByRole("alert")).toBeVisible();
    },
  );
}

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
      const otherLabel = row(state, other).locator(".otk-sidebar-title-text");
      await expect(otherLabel).toHaveText(basename(state.directory));
      await begin(state, page);
      await save(state, page, "Fixture app");
      await expect(otherLabel).toHaveText("Fixture app");
      await restart(state);
      await page.reload();
      await other.reload();
      await expect(row(state, page).locator(".otk-sidebar-title-text"))
        .toHaveText(
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
    await expect(row(state, page).locator(".otk-sidebar-title-text"))
      .toHaveText(
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
    await expect(row(state, page).locator(".otk-sidebar-title-text"))
      .toHaveText(
        "Fixture app",
      );
    await row(state, page).locator(".otk-project-open").click({
      button: "right",
    });
    await reset(page).click();
    await expect.poll(async () => (await settings(state)).values.name, {
      message: "Reset name applies to the native project",
    }).toBe("");
    await expect(row(state, page).locator(".otk-sidebar-title-text"))
      .toHaveText(
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
    const transport = await wire(page);
    await page.reload();
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
      transport.hold((frame, request) =>
        frame.t === "request.result" && request?.method === "project.update"
      );
      try {
        await editor(page).fill("Fixture app");
        await editor(page).press("Enter");
        await expect(project.locator(".otk-rename-pending")).toHaveText(
          "Fixture app",
        );
        expect((await project.boundingBox())!.height).toBeCloseTo(resting, 1);
        await capture("pending");
      } finally {
        transport.release();
      }
      await expect(project.locator(".otk-rename-pending")).toHaveCount(0);
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
      await expect(project.locator(".otk-sidebar-title-text")).toHaveText(
        basename(state.directory),
      );
    }
  },
);
