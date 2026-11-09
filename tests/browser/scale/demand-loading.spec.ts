// SPDX-License-Identifier: LGPL-3.0-only
import { isolatedTest as test } from "../fixtures/isolated.ts";
import { expect } from "../fixtures/evidence.ts";
import type { WebSocketRoute } from "@playwright/test";

test.use({ profile: "isolated" });
test("demand.session-pages-loading-search-and-window-anchor", {
  tag: ["@load", "@sessions", "@transport"],
}, async ({ isolatedState: state, page }, info) => {
  test.setTimeout(120_000);
  const sessions: { id: string; title: string }[] = [];
  for (let i = 0; i < 65; i++) {
    sessions.push(
      await state.native("/session", "POST", {
        title: `Demand session ${String(i).padStart(3, "0")}`,
      }),
    );
  }
  await state.product("layout.patch", {
    rightCollapsed: false,
    rightView: "sessions",
  });
  let hold = true;
  const methods = new Map<
    string,
    {
      method: string;
      params: { before?: string; query?: string; limit?: number };
    }
  >();
  const held: { socket: WebSocketRoute; message: string | Buffer }[] = [];
  const pages: { items: { id: string }[]; older: string | null }[] = [];
  await page.routeWebSocket("**/api/ws", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (frame.t === "request") methods.set(frame.ref.key, frame);
      server.send(message);
    });
    server.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (
        frame.t === "request.result" &&
        methods.get(frame.ref.key)?.method === "sessions.list" &&
        frame.outcome.ok
      ) {
        pages.push(frame.outcome.result);
        if (hold) {
          held.push({ socket, message });
          return;
        }
      }
      socket.send(message);
    });
  });
  await page.goto(`${state.url}/#/local/${sessions.at(-1)!.id}`);
  const loading = page.locator(".otk-session-loading-row");
  await expect(loading).toBeVisible();
  await expect(loading).toHaveText("Loading sessions...");
  await expect(page.getByText("Start a conversation below.", { exact: true }))
    .toBeVisible();
  await expect(page.getByText("Saving viewed conversation", { exact: true }))
    .toHaveCount(0);
  for (
    const [theme, name] of [["otk-dark", "dark"], ["otk-light", "linen"], [
      "otk-light-stone",
      "stone",
    ]]
  ) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await page.screenshot({
      path: info.outputPath(`q3-${name}-session-list-loading.png`),
      fullPage: true,
    });
  }
  const loadingSlot = page.locator(".otk-session-loading-slot");
  const geometry = await loadingSlot.evaluate((row) => {
    const label = row.querySelector(".otk-progress-status")!;
    const bounds = row.getBoundingClientRect(),
      text = label.getBoundingClientRect();
    return {
      rowHeight: bounds.height,
      textHeight: text.height,
      nowrap: getComputedStyle(label).whiteSpace,
      centreDelta: Math.abs(
        bounds.y + bounds.height / 2 - text.y - text.height / 2,
      ),
    };
  });
  expect(geometry.nowrap).toBe("nowrap");
  expect(geometry.centreDelta).toBeLessThanOrEqual(1);
  expect(geometry.rowHeight).toBe(30);
  const typography = await page.evaluate(() => {
    const style = (selector: string) => {
      const value = getComputedStyle(document.querySelector(selector)!);
      return {
        weight: value.fontWeight,
        size: value.fontSize,
        line: value.lineHeight,
        family: value.fontFamily,
        color: value.color,
      };
    };
    return {
      row: style(".otk-session-loading-row"),
      shell: style(".otk-shell-progress"),
    };
  });
  expect(typography.row).toEqual(typography.shell);
  expect(typography.row.weight).toBe("400");
  await info.attach("q3-status-typography", {
    body: JSON.stringify(typography),
    contentType: "application/json",
  });
  await info.attach("q3-loading-row-geometry", {
    body: JSON.stringify(geometry),
    contentType: "application/json",
  });
  hold = false;
  for (const value of held.splice(0)) value.socket.send(value.message);
  await expect(page.locator(".otk-session-row").first()).toBeVisible();
  await expect(loading).toHaveCount(0);
  expect(pages.every((page) => page.items.length <= 20)).toBe(true);
  expect(pages[0].items.length).toBe(20);
  const viewport = page.locator(".otk-project-session-tree");
  const mounted = async () => {
    const value = await viewport.evaluate((element) => ({
      height: element.clientHeight,
      count: element.querySelectorAll(".otk-session-row").length,
    }));
    expect(value.count).toBeLessThanOrEqual(Math.ceil(value.height / 30) + 12);
  };
  await mounted();
  const beforeCount = pages.length;
  const anchor = await viewport.evaluate((element) => {
    element.scrollTop = Math.max(
      0,
      element.scrollHeight - element.clientHeight - 30,
    );
    const bounds = element.getBoundingClientRect();
    const row = Array.from(
      element.querySelectorAll<HTMLElement>("[data-virtual-key]"),
    )
      .find((row) => row.getBoundingClientRect().bottom > bounds.top + 1)!;
    return {
      key: row.dataset.virtualKey,
      top: row.getBoundingClientRect().top - bounds.top,
    };
  });
  await expect.poll(() => pages.length).toBeGreaterThan(beforeCount);
  await mounted();
  const delta = await viewport.evaluate((element, anchor) => {
    const row = Array.from(
      element.querySelectorAll<HTMLElement>("[data-virtual-key]"),
    )
      .find((row) => row.dataset.virtualKey === anchor.key);
    return row
      ? Math.abs(
        row.getBoundingClientRect().top - element.getBoundingClientRect().top -
          anchor.top,
      )
      : Infinity;
  }, anchor);
  expect(delta).toBeLessThanOrEqual(1);
  await page.getByRole("searchbox", { name: "Search sessions by title" }).fill(
    "Demand session 000",
  );
  await expect(page.locator(`[data-session="${sessions[0].id}"]`))
    .toBeVisible();
  expect(
    [...methods.values()].some((request) =>
      request.method === "sessions.list" &&
      request.params.query === "Demand session 000"
    ),
  ).toBe(true);
  await mounted();
});
