// SPDX-License-Identifier: LGPL-3.0-only
import type { WebSocketRoute } from "@playwright/test";
import type { Page } from "@playwright/test";
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
