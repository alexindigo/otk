// SPDX-License-Identifier: LGPL-3.0-only
import type { WebSocketRoute } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({ profile: "contract-sessions-inbox" });

test("sessions.project-order-no-reorder-on-load", {
  tag: ["@sessions", "@contracts", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const a = "/ws/atmosphera", o = "/ws/otk", b = "/ws/ndash";
  const replacement = "/ws/otk-relocated";
  const clone = "/ws/otk-clone",
    review = "/ws/otk.review",
    ride = "/ws/otk.ride";
  const selector = '.otk-project-row[data-group="active"]:not(.is-subproject)';
  await page.addInitScript((selector) => {
    const trace: string[][] = [];
    Object.assign(window, { projectOrderTrace: trace });
    new MutationObserver(() => {
      const row = Array.from(document.querySelectorAll(selector)).map((node) =>
        node.getAttribute("data-project")!
      );
      if (JSON.stringify(trace.at(-1)) !== JSON.stringify(row)) trace.push(row);
    }).observe(document, { childList: true, attributes: true, subtree: true });
  }, selector);
  let socket: WebSocketRoute, epoch = 0, revision = 0;
  let eligible = false, applied = 0;
  await page.routeWebSocket("**/ws", (client) => {
    socket = client;
    const native = client.connectToServer();
    client.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (frame.t === "hello") {
        epoch = frame.view?.epoch ?? 0;
        native.send(message);
      }
      if (frame.t === "view") epoch = frame.epoch;
      if (frame.t === "index.applied") applied++;
    });
    native.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (["welcome", "harness"].includes(frame.t)) client.send(message);
      if (frame.t === "prefs") {
        client.send(JSON.stringify({
          ...frame,
          prefs: {
            ...frame.prefs,
            shellLayout: {
              ...frame.prefs.shellLayout,
              leftCollapsed: false,
              projectCollapsed: {},
            },
          },
        }));
        eligible = true;
      }
    });
  });
  const frame = (payload: object) =>
    socket.send(JSON.stringify({ ...payload, epoch }));
  const rows = () =>
    page.locator(selector).evaluateAll((rows) =>
      rows.map((r) => r.getAttribute("data-project"))
    );
  const entry = (id: string, directory: string) => ({
    id,
    directory,
    projectID: directory,
    title: id,
    status: "idle",
    archived: false,
    timeCreated: 1,
    timeUpdated: 2,
    digest: { state: "digesting", revision: 0, turns: {} },
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  });
  function publishOrder(root: string, multi = false) {
    frame({
      t: "projects.order",
      revision: ++revision,
      projects: [
        { id: "a", directories: [a] },
        {
          id: "o",
          directories: multi ? [o, ride, review] : root === o ? [o] : [root, o],
        },
        ...(multi ? [{ id: "clone", directories: [clone] }] : []),
        { id: "b", directories: [b] },
      ],
    });
  }
  function baseline(root: string, multi = false) {
    const projects =
      (multi ? [a, o, clone, b] : root === o ? [a, o, b] : [a, b]).map((
        directory,
      ) => ({
        directory,
        added: true,
        inactive: false,
        lastVisit: 1,
      }));
    const summaries = Object.fromEntries(
      (multi ? [a, root, b, clone, review, ride] : [a, root, b]).map((
        directory,
      ) => [directory, {
        directory,
        topology: {
          canonicalRoot: directory === review || directory === ride
            ? o
            : directory,
          repoID: [root, clone, review, ride].includes(directory)
            ? o
            : directory,
          leafDirectory: directory,
          ...(directory === review || directory === ride
            ? { parentDirectory: o }
            : {}),
        },
        authority: "current",
        hasSessions: true,
        sessionCount: 1,
        unseenCount: 0,
        lastActivity: 1,
      }]),
    );
    frame({
      t: "inbox.snapshot",
      generation: "repro",
      revision: ++revision,
      inbox: {
        projects,
        tasks: [],
        seen: {},
        finishes: {},
        pathTemplates: [],
        summaries,
      },
    });
  }
  await page.goto(state.url);
  await expect.poll(() => eligible).toBe(true);
  publishOrder(o);
  frame({
    t: "index.snapshot",
    rev: 0,
    entries: [entry("tstv1-ndash", b), entry("tstv1-otk", o)],
  });
  // Hold the inbox until the index actually paints. The old UI renders b,o.
  await expect.poll(async () => (await rows()).length).toBe(2);
  expect.soft(await rows(), "index-only first paint").toEqual([o, b]);
  baseline(o);
  await expect.poll(async () => (await rows()).length).toBe(3);
  expect.soft(await rows(), "after delayed inbox").toEqual([a, o, b]);
  const trace = await page.evaluate(() =>
    (window as unknown as { projectOrderTrace: string[][] }).projectOrderTrace
  );
  for (const seen of trace) {
    expect.soft([a, o, b].filter((row) => seen.includes(row))).toEqual(seen);
  }

  // Exercise ordinary reloads with a main checkout, a separate clone of the
  // same repo and two worktrees. Deliberately deliver rows before order and
  // vary their arrival order; none may paint until the owner frame arrives.
  const expected = [a, o, clone, b];
  for (
    const arrival of [[b, clone, review, o, ride, a], [
      ride,
      o,
      a,
      b,
      review,
      clone,
    ], [clone, review, a, ride, b, o]]
  ) {
    eligible = false;
    const before = applied;
    await page.reload();
    await expect.poll(() => eligible).toBe(true);
    frame({
      t: "index.snapshot",
      rev: 0,
      entries: arrival.map((directory) =>
        entry(`tstv1-${directory.split("/").at(-1)}`, directory)
      ),
    });
    await expect.poll(() => applied).toBeGreaterThan(before);
    baseline(o, true);
    await page.evaluate(() =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done()))
      )
    );
    expect.soft(await rows(), "early rows must not paint on reload").toEqual(
      [],
    );
    publishOrder(o, true);
    await expect.poll(async () => (await rows()).length).toBe(expected.length);
    expect.soft(await rows(), "all reloads use the published order").toEqual(
      expected,
    );
    const branch = page.locator(".otk-project-tree").filter({
      has: page.locator(`[data-project="${ride}"][data-project-parent="${o}"]`),
    });
    expect(await branch.count()).toBeGreaterThan(0);
    const worktrees = page.locator(`[data-project-parent="${o}"]`);
    await expect(worktrees).toHaveCount(2);
    expect.soft(
      await worktrees.evaluateAll((rows) =>
        rows.map((row) => row.getAttribute("data-project"))
      ),
    ).toEqual([ride, review]);
    const reloadTrace = await page.evaluate(() =>
      (window as unknown as { projectOrderTrace: string[][] }).projectOrderTrace
    );
    expect.soft(reloadTrace.filter((row) => row.length > 0)).toEqual([
      expected,
    ]);
  }

  eligible = false;
  await page.reload();
  await expect.poll(() => eligible).toBe(true);
  publishOrder(o);
  frame({ t: "index.snapshot", rev: 0, entries: [] });
  baseline(o);
  await expect.poll(rows).toEqual([a, o, b]);
  publishOrder(replacement);
  baseline(replacement);
  await expect.poll(rows, {
    message: "replacement checkout inherits the project's slot",
  }).toEqual([a, replacement, b]);
});

const tags = { tag: ["@sessions", "@contracts", "@isolated"] };
const active = (page: Page) =>
  page.locator('.otk-project-row[data-group="active"]:not(.is-subproject)');
const activeOrder = (page: Page) =>
  active(page).evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-project"))
  );
async function sidebar(page: Page, url: string) {
  await page.goto(url);
  await expect.poll(async () => (await activeOrder(page)).length)
    .toBeGreaterThanOrEqual(3);
}

test(
  "sessions.project-order-drag-edges-and-touch",
  tags,
  async ({ isolatedState: state, page }, info) => {
    const { root } = await state.observe<{ root: string }>();
    const parents = join(root, "order-fixture");
    for (let i = 0; i < 20; i++) {
      await mkdir(join(parents, `project-${String(i).padStart(2, "0")}`), {
        recursive: true,
      });
    }
    await state.product("projects.templates", {
      templates: [join(parents, "{project}")],
    });
    await state.product("layout.patch", { leftCollapsed: false });
    await page.setViewportSize({ width: 1280, height: 400 });
    await sidebar(page, state.url);
    const original = await activeOrder(page);
    const cdp = await page.context().newCDPSession(page);
    try {
      const box =
        (await active(page).nth(2).locator(".otk-project-open").boundingBox())!;
      const to = (await active(page).nth(1).boundingBox())!;
      const x = Math.round(box.x + box.width / 2),
        y = Math.round(box.y + box.height / 2);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y }],
      });
      await expect(page.locator(".is-lifted")).toHaveCount(1);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: Math.round(to.y + 2) }],
      });
      await expect(page.locator(".otk-project-drop")).toHaveCount(1);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await expect.poll(() => activeOrder(page)).toEqual([
        original[0],
        original[2],
        original[1],
        ...original.slice(3),
      ]);
      await expect(page.locator(".is-lifted")).toHaveCount(0);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y }],
      });
      await expect(page.locator(".is-lifted")).toHaveCount(1);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await expect(page.getByRole("menuitem", { name: "Move up", exact: true }))
        .toBeVisible();
      await page.keyboard.press("Escape");
    } finally {
      await cdp.detach();
    }
    const discoveredToggle = page.locator(".otk-discovered-toggle");
    if (await discoveredToggle.getAttribute("aria-expanded") === "false") {
      await discoveredToggle.click();
    }
    const projects = page.locator(
      '[data-project-section="Discovered"] [data-project-root]',
    );
    await expect(projects).toHaveCount(20);
    const source = (await projects.first().boundingBox())!;
    const viewport = page.locator(".otk-inbox-scroll");
    const view = (await viewport.boundingBox())!;
    const x = source.x + source.width / 2, y = view.y + view.height - 5;
    await page.mouse.move(x, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 5 });
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(100);
    await expect.poll(() =>
      viewport.evaluate((el) =>
        el.scrollHeight - el.clientHeight - el.scrollTop
      )
    ).toBeLessThanOrEqual(1);
    await expect(page.locator(".otk-project-drop")).toHaveCount(1);
    await page.mouse.up();
    await expect(projects.last()).toHaveAttribute(
      "data-project-root",
      /project-00/,
    );
    await expect(page.locator(".is-lifted")).toHaveCount(0);
    await projects.first().scrollIntoViewIfNeeded();
    const next = (await projects.first().boundingBox())!;
    await page.mouse.move(x, next.y + next.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, next.y + next.height * 2);
    await expect(page.locator(".is-lifted")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(page.locator(".is-lifted, .otk-project-drop")).toHaveCount(0);
    await expect(projects.first()).toHaveAttribute(
      "data-project-root",
      /project-01/,
    );
    await state.product("projects.inactive", {
      directory: join(parents, "project-00"),
      inactive: true,
    });
    await expect(projects).toHaveCount(19);
    const inactiveToggle = page.locator(".otk-inactive-toggle");
    if (
      await inactiveToggle.getAttribute("aria-expanded") === "false"
    ) await inactiveToggle.click();
    const inactive = page.locator(
      '[data-project-section="Inactive"] [data-project-root]',
    ).last();
    await inactive.scrollIntoViewIfNeeded();
    const before = await projects.evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-project-root"))
    );
    const start = (await projects.last().boundingBox())!;
    const target = (await inactive.boundingBox())!;
    await page.mouse.move(x, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, target.y + target.height / 2, { steps: 4 });
    await expect(page.locator(".is-lifted")).toHaveCount(1);
    await expect(page.locator(".otk-project-drop")).toHaveCount(0);
    await page.mouse.up();
    await expect(page.locator(".is-lifted")).toHaveCount(0);
    expect(
      await projects.evaluateAll((rows) =>
        rows.map((row) => row.getAttribute("data-project-root"))
      ),
    ).toEqual(before);
    await info.attach("project-order-boundaries", {
      body: "Touch lift/move/menu, scroll edge, Escape",
      contentType: "text/plain",
    });
  },
);

test(
  "sessions.project-order-keyboard-and-menu-move",
  tags,
  async ({ isolatedState: state, page }) => {
    await state.product("layout.patch", { leftCollapsed: false });
    await sidebar(page, state.url);
    const initial = await activeOrder(page);
    const moved = [initial[0], initial[2], initial[1], ...initial.slice(3)];
    const row = page.locator(
      `.otk-project-row[data-project=${JSON.stringify(initial[2])}]`,
    );
    const button = row.locator(".otk-project-open");
    await button.focus();
    await button.press("Alt+ArrowUp");
    await expect.poll(() => activeOrder(page)).toEqual(moved);
    await expect(button).toBeFocused();
    await expect(page.locator(".otk-project-order-status")).toContainText(
      `moved to position 2 of ${initial.length} in Active`,
    );
    await row.locator(".otk-project-menu > button").click();
    await page.getByRole("menuitem", { name: "Move down", exact: true })
      .click();
    await expect.poll(() => activeOrder(page)).toEqual(initial);
    await active(page).first().locator(".otk-project-menu > button").click();
    await expect(page.getByRole("menuitem", { name: "Move up", exact: true }))
      .toBeDisabled();
    await page.reload();
    await expect.poll(() => activeOrder(page)).toEqual(initial);
  },
);

test(
  "sessions.project-order-drag-persists-across-reload-and-second-browser",
  tags,
  async ({ isolatedState: state, page, browser }) => {
    await state.product("layout.patch", { leftCollapsed: false });
    await sidebar(page, state.url);
    const initial = await activeOrder(page);
    const moved = [initial[0], initial[2], initial[1], ...initial.slice(3)];
    const from =
      (await active(page).nth(2).locator(".otk-project-open").boundingBox())!;
    const to = (await active(page).nth(1).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, to.y + 3, { steps: 8 });
    await expect(page.locator(".otk-project-tree.is-lifted")).toHaveCount(1);
    await expect(page.locator(".otk-project-drop")).toHaveCount(1);
    expect(await activeOrder(page)).toEqual(initial);
    await page.mouse.up();
    await expect.poll(() => activeOrder(page)).toEqual(moved);
    await expect(page.locator(".otk-project-drop")).toHaveCount(0);
    await page.reload();
    await expect.poll(() => activeOrder(page)).toEqual(moved);
    const other = await browser.newContext();
    try {
      const second = await other.newPage();
      await second.goto(state.url);
      await expect.poll(() => activeOrder(second)).toEqual(moved);
    } finally {
      await other.close();
    }
  },
);
