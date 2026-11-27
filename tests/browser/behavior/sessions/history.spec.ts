// SPDX-License-Identifier: LGPL-3.0-only
import type { Locator, Page } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import type { TestState } from "../../fixtures/test-state.ts";
import { openSession, wire } from "../../fixtures/wire.ts";

type Session = { id: string; directory: string };
async function sessions(state: TestState) {
  const a = await state.native<Session>("/session", "POST", {
    title: "First session",
  });
  const b = await state.controller.call<Session>("nativeRequest", {
    lease: state.lease.lease,
    path: "/session",
    method: "POST",
    project: "secondary",
    body: { title: "Second session" },
  });
  await state.product("layout.patch", {
    leftCollapsed: false,
    discoveredCollapsed: false,
  });
  return { a, b };
}

function selected(page: Page, session: Session) {
  return Promise.all([
    expect(page).toHaveURL(new RegExp(`#\\/local/${session.id}$`)),
    expect(page.locator(`[data-crumb=${JSON.stringify(session.id)}]`))
      .toBeVisible(),
  ]);
}

async function openProject(page: Page, session: Session) {
  await page.locator(
    `.otk-project-row[data-project=${
      JSON.stringify(session.directory)
    }] .otk-project-open`,
  ).click();
  await selected(page, session);
}

const tags = { tag: ["@sessions", "@contracts"] };

const project = (page: Page, directory: string) =>
  page.locator(`.otk-project-row[data-project=${JSON.stringify(directory)}]`);

async function keyboardFocus(page: Page, control: Locator) {
  // Set real keyboard modality; isolate the history transition from the
  // number of other controls between this item and the current native focus.
  await page.keyboard.press("Tab");
  await control.focus();
  await expect.poll(() =>
    control.evaluate((el) => el.matches(":focus-visible"))
  ).toBe(true);
}

test("sessions.history-hands-project-focus-to-current-row", tags, async ({
  isolatedState: state,
  page,
}) => {
  const { a, b } = await sessions(state);
  await page.goto(state.url);
  await openProject(page, a);
  await openProject(page, b);
  const control = (session: Session) =>
    project(page, session.directory)
      .locator(".otk-project-open");
  await page.mouse.move(650, 420);
  await keyboardFocus(page, control(b));
  await expect(project(page, b.directory).locator(".otk-sidebar-control"))
    .toHaveCSS("opacity", "1");
  for (
    const [travel, previous, next] of [
      [() => page.goBack(), b, a],
      [() => page.goForward(), a, b],
    ] as const
  ) {
    await travel();
    await selected(page, next);
    await expect.soft(control(previous)).not.toBeFocused();
    await expect.soft(
      project(page, previous.directory).locator(".otk-sidebar-control"),
    )
      .toHaveCSS("opacity", "0");
    await expect.soft(control(next)).toBeFocused();
    await expect.poll(() =>
      control(next).evaluate((el) => el.matches(":focus-visible"))
    ).toBe(true);
  }
});

test("sessions.project-menu-pointer-dismissal-stays-quiet", tags, async ({
  isolatedState: state,
  page,
}) => {
  const { a, b } = await sessions(state);
  await page.goto(state.url);
  await openProject(page, a);
  const old = project(page, b.directory);
  const menu = old.locator(".otk-sidebar-control");
  const trigger = menu.locator(".otk-project-menu").getByRole("button");
  await trigger.click();
  await expect(page.getByRole("menu")).toBeVisible();
  await trigger.click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.mouse.move(650, 420);
  await expect.soft(old.locator(":focus-visible")).toHaveCount(0);
  await expect.soft(menu).toHaveCSS("opacity", "0");
  await trigger.click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.mouse.click(650, 420);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(old.locator(":focus-visible")).toHaveCount(0);
  await expect(menu).toHaveCSS("opacity", "0");
});

for (const surface of ["tab", "session"] as const) {
  test(`sessions.history-hands-${surface}-focus-to-current-item`, tags, async ({
    isolatedState: state,
    page,
  }) => {
    const create = (title: string) =>
      state.native<Session>("/session", "POST", { title });
    const a = await create("First session"), b = await create("Second session");
    const task = (name: string, sessions: string[]) =>
      state.product("tasks.create", {
        directory: state.directory,
        name,
        sessions,
      });
    const first = await task("First task", [
      a.id,
      ...(surface === "tab" ? [] : [b.id]),
    ]);
    const second = surface === "tab"
      ? await task("Second task", [b.id])
      : first;
    await state.product("layout.patch", {
      rightCollapsed: false,
      rightView: "sessions",
    });
    await page.goto(`${state.url}/#/local/${a.id}`);
    await selected(page, a);
    const control = (s: Session, taskID: string) =>
      page.locator(
        surface === "tab"
          ? `button[data-tab=${JSON.stringify(taskID)}]`
          : `.otk-session-row[data-session=${
            JSON.stringify(s.id)
          }] .otk-session-open`,
      );
    const one = control(a, first.id), two = control(b, second.id);
    await two.click();
    await selected(page, b);
    await keyboardFocus(page, two);
    await page.goBack();
    await selected(page, a);
    await expect.soft(two).not.toBeFocused();
    await expect.soft(one).toBeFocused();
    await page.goForward();
    await selected(page, b);
    await expect.soft(one).not.toBeFocused();
    await expect.soft(two).toBeFocused();
  });
}

test.describe("trail focus", () => {
  test.use({ profile: "contract-sessions-hierarchy" });
  test("sessions.history-hands-crumb-focus-to-current-item", tags, async ({
    isolatedState: state,
    page,
  }) => {
    const main = "tstv1-otk", helper = "tstv1-helper";
    await state.product("tasks.create", {
      directory: state.directory,
      name: "Root task",
      sessions: [main],
    });
    await openSession(state, page, main);
    await page.locator(
      `.otk-session-row[data-session="${helper}"] .otk-session-open`,
    ).click();
    await expect(page).toHaveURL(new RegExp(`${helper}$`));
    const parent = page.locator(`a[data-crumb="${main}"]`);
    const child = page.locator(`a[data-crumb="${helper}"]`);
    await parent.click();
    await expect(page).toHaveURL(new RegExp(`${main}$`));
    await keyboardFocus(page, parent);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${helper}$`));
    await expect.soft(parent).not.toBeFocused();
    await expect.soft(child).toBeFocused();
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`${main}$`));
    await expect(parent).toBeFocused();
  });
});

test("sessions.history-project-click-single-entry", tags, async ({
  isolatedState: state,
  page,
}) => {
  const { a, b } = await sessions(state);
  await page.goto(state.url);
  await openProject(page, a);
  await openProject(page, b);
  await page.goBack();
  await selected(page, a);
  await page.goForward();
  await selected(page, b);
});

test(
  "sessions.history-reload",
  tags,
  async ({ isolatedState: state, page }) => {
    const { a, b } = await sessions(state);
    await page.goto(state.url);
    await openProject(page, a);
    await openProject(page, b);
    await page.reload();
    await selected(page, b);
    await page.goBack();
    await selected(page, a);
    await page.goForward();
    await selected(page, b);
  },
);

function toolbar(page: Page) {
  const nav = page.getByRole("navigation", { name: "Session history" });
  return {
    back: nav.getByRole("button").nth(0),
    forward: nav.getByRole("button").nth(1),
  };
}

const inProject = (session: Session, title: string) =>
  `${title} in ${session.directory.split("/").at(-1)}`;
const earlier = "No earlier session in this tab",
  later = "No later session in this tab";
async function targets(page: Page, backLabel: string, forwardLabel: string) {
  const { back, forward } = toolbar(page);
  for (
    const [control, label] of [[back, backLabel], [
      forward,
      forwardLabel,
    ]] as const
  ) {
    await expect(control).toHaveAccessibleName(label);
    await expect(control).toHaveAttribute("title", label);
    if (label === earlier || label === later) {
      await expect(control).toBeDisabled();
    } else await expect(control).toBeEnabled();
  }
}

test(
  "sessions.history-buttons-cross-project",
  tags,
  async ({ isolatedState: state, page }) => {
    const { a, b } = await sessions(state);
    await page.goto(`${state.url}/#/local/${a.id}`);
    await selected(page, a);
    await openProject(page, b);
    await targets(page, `Back to ${inProject(a, "First session")}`, later);
    await state.native(`/session/${a.id}`, "PATCH", {
      title: "Renamed off screen",
    });
    await targets(page, `Back to ${inProject(a, "Renamed off screen")}`, later);
    await toolbar(page).back.click();
    await selected(page, a);
    await targets(
      page,
      earlier,
      `Forward to ${inProject(b, "Second session")}`,
    );
    await toolbar(page).forward.click();
    await selected(page, b);
  },
);

test(
  "sessions.history-browser-and-button-agree",
  tags,
  async ({ isolatedState: state, page }) => {
    const connection = await wire(page);
    const { a, b } = await sessions(state);
    const c = await state.native<Session>("/session", "POST", {
      title: "Third session",
    });
    const aLabel = inProject(a, "First session"),
      bLabel = inProject(b, "Second session"),
      cLabel = inProject(c, "Third session");
    await page.goto(`${state.url}/#/local/${a.id}`);
    await selected(page, a);
    await openProject(page, b);
    await page.goto(`${state.url}/#/local/${c.id}`);
    await selected(page, c);
    await targets(page, `Back to ${bLabel}`, later);
    await page.goBack();
    await selected(page, b);
    await targets(page, `Back to ${aLabel}`, `Forward to ${cLabel}`);
    const currentView = () =>
      connection.sent.filter(({ frame }) => frame.t === "view").at(-1)?.frame;
    await expect.poll(() => currentView()?.historyNeighbors).toEqual([
      a.id,
      c.id,
    ]);
    expect(currentView()?.selected).toBe(b.id);
    expect(currentView()?.crumbs).not.toContain(a.id);
    expect(currentView()?.crumbs).not.toContain(c.id);
    await toolbar(page).back.click();
    await selected(page, a);
    await targets(page, earlier, `Forward to ${bLabel}`);
    await expect.poll(() => currentView()?.historyNeighbors).toEqual([b.id]);
    await page.goForward();
    await selected(page, b);
    await targets(page, `Back to ${aLabel}`, `Forward to ${cLabel}`);
    await toolbar(page).forward.click();
    await selected(page, c);
    await targets(page, `Back to ${bLabel}`, later);
  },
);

test("sessions.history-guard", tags, async ({ isolatedState: state, page }) => {
  const { a, b } = await sessions(state);
  await page.goto(`${state.url}/#/local/${a.id}`);
  await selected(page, a);
  await openProject(page, b);
  await page.getByRole("button", { name: "Edit prompt", exact: true }).click();
  const editor = page.locator("textarea[name=editor]");
  await editor.fill("Keep this unsaved editor text");
  // The modal deliberately makes the real toolbar inert; dispatch activation
  // straight to its button to exercise the same binding with the editor live.
  const back = page.locator(".otk-history button").first();
  const declined = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.message()).toContain("Discard unsaved editor");
    await dialog.dismiss();
  });
  await back.dispatchEvent("click");
  await declined;
  await selected(page, b);
  await expect(editor).toHaveValue("Keep this unsaved editor text");
  await expect(page.locator(".otk-history button").last()).toBeDisabled();
  const accepted = page.waitForEvent("dialog").then((dialog) =>
    dialog.accept()
  );
  await back.dispatchEvent("click");
  await accepted;
  await selected(page, a);
  await expect(editor).toHaveCount(0);
  await expect(toolbar(page).forward).toBeEnabled();
});

test(
  "sessions.history-deleted-target",
  tags,
  async ({ isolatedState: state, page }) => {
    const { a, b } = await sessions(state);
    await state.product("tasks.create", {
      directory: a.directory,
      name: "Retain history target",
      sessions: [a.id],
    });
    await page.goto(`${state.url}/#/local/${a.id}`);
    await selected(page, a);
    await openProject(page, b);
    await state.native(`/session/${a.id}`, "DELETE");
    await targets(
      page,
      `Back to ${inProject(a, "First session")} (deleted)`,
      later,
    );
    await toolbar(page).back.click();
    await expect(page).toHaveURL(new RegExp(`#\\/local/${a.id}$`));
    await expect(page.locator(".otk-deleted-session")).toContainText(
      "First session",
    );
  },
);

test(
  "sessions.history-tabs-independent",
  tags,
  async ({ isolatedState: state, page, context }) => {
    const { a, b } = await sessions(state);
    await page.goto(`${state.url}/#/local/${a.id}`);
    await selected(page, a);
    await openProject(page, b);
    const other = await context.newPage();
    await other.goto(`${state.url}/#/local/${b.id}`);
    await selected(other, b);
    await targets(other, earlier, later);
    await openProject(other, a);
    await targets(other, `Back to ${inProject(b, "Second session")}`, later);
    await targets(page, `Back to ${inProject(a, "First session")}`, later);
    await selected(page, b);
  },
);

test(
  "sessions.history-collapsed-rail",
  tags,
  async ({ isolatedState: state, page }) => {
    const { a, b } = await sessions(state);
    await page.goto(`${state.url}/#/local/${a.id}`);
    await selected(page, a);
    await openProject(page, b);
    await page.getByRole("button", { name: "Collapse projects" }).click();
    const rail = page.getByRole("complementary", { name: "Projects" });
    await expect(rail).toHaveAttribute("data-collapsed", "true");
    await expect(
      rail.getByRole("navigation", { name: "Session history" }).getByRole(
        "button",
      ).filter({ visible: true }),
    ).toHaveCount(2);
    await targets(page, `Back to ${inProject(a, "First session")}`, later);
    await toolbar(page).back.click();
    await selected(page, a);
    await targets(
      page,
      earlier,
      `Forward to ${inProject(b, "Second session")}`,
    );
  },
);
