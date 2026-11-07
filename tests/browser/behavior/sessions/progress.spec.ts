// SPDX-License-Identifier: LGPL-3.0-only
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { expect } from "../../fixtures/evidence.ts";
test.use({ profile: "contract-sessions-progress" });
test("progress.count-rate-eta-and-stalled-wait", {
  tag: ["@sessions", "@messages", "@transport", "@visual"],
}, async ({ isolatedState: state, page }, info) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.clock.install();
  const { session } = await state.observe<{ session: { id: string } }>();
  await state.product("layout.patch", {
    rightCollapsed: false,
    rightView: "sessions",
  });
  await page.goto(`${state.url}/#/local/${session.id}`);
  const status = page.locator(".otk-shell-progress");
  await expect(status).toHaveText("Indexing sessions: 80 of 251");
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "succeed",
  });
  await page.clock.runFor(1100);
  await expect(status).toHaveText(
    "Indexing sessions: 83 of 251, about 1 min left",
  );
  await expect(page.locator(".otk-shell-progress")).toHaveCount(1);
  await expect(
    page.getByText(/Local summaries|Crumb summaries|Summary pending/),
  ).toHaveCount(0);
  await expect(page.locator(".otk-session-digest-state")).toHaveText("Pending");
  const listStatus = page.locator(".otk-session-loading-slot").getByRole(
    "status",
  );
  await expect(listStatus).toHaveText("Loading sessions...");
  const rowBefore = await page.locator(".otk-session-row").first()
    .boundingBox();
  await expect(status).not.toContainText(
    /sessions\/s|reading page|crumb|summar/i,
  );
  const pageStatus = page.getByRole("region", {
    name: "Transcript",
    exact: true,
  }).getByRole("status");
  await expect(pageStatus).toContainText("Loading messages...");
  await page.clock.runFor(18000);
  await expect(pageStatus).toHaveText(/Loading messages\.\.\. \d+ s/);
  for (
    const [theme, name] of [["otk-dark", "dark"], ["otk-light", "linen"], [
      "otk-light-stone",
      "stone",
    ]]
  ) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await page.screenshot({
      path: info.outputPath(`p5-${name}-eta-session.png`),
      fullPage: true,
    });
  }
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "succeed",
  });
  await page.clock.runFor(1100);
  await expect(status).toContainText("86 of 251");
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "hold",
  });
  await page.clock.setFixedTime(
    new Date(await page.evaluate(() => Date.now()) + 61000),
  );
  await page.clock.runFor(1100);
  for (
    const copy of [
      "No progress for",
      "waiting for the open session to load first",
      "86 of 251",
    ]
  ) {
    await expect(status).toContainText(copy);
  }
  await expect(status).toContainText(/No progress for \d+ s/);
  await expect(pageStatus).toHaveText(
    /Still loading messages \(\d+ s\): waiting for opencode to respond/,
  );
  await expect(listStatus).toHaveText(
    /Still loading sessions \(\d+ s\): waiting for opencode to respond/,
  );
  const rowHeld = await page.locator(".otk-session-row").first().boundingBox();
  expect(rowHeld?.y).toBe(rowBefore?.y);
  for (
    const [theme, name] of [["otk-dark", "dark"], ["otk-light", "linen"], [
      "otk-light-stone",
      "stone",
    ]]
  ) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await page.screenshot({
      path: info.outputPath(`p5-${name}-stalled.png`),
      fullPage: true,
    });
  }
  const geometry = await page.locator(".otk-progress-status").evaluateAll((
    nodes,
  ) =>
    nodes.map((node) => ({
      text: node.textContent,
      height: node.getBoundingClientRect().height,
      line: parseFloat(getComputedStyle(node).lineHeight),
      whiteSpace: getComputedStyle(node).whiteSpace,
    }))
  );
  expect(geometry.every((value) => value.whiteSpace === "nowrap")).toBe(true);
  await info.attach("progress-geometry", {
    body: JSON.stringify(geometry),
    contentType: "application/json",
  });
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "release",
  });
  await expect(page.getByText("Core transcript", { exact: true }))
    .toBeVisible();
  await expect(listStatus).toHaveCount(0);
  await expect(pageStatus).toHaveCount(0);
  expect((await page.locator(".otk-session-row").first().boundingBox())?.y)
    .toBe(rowBefore?.y);
});

test(
  "progress.boundary-page-paints-before-metadata-and-completes-without-row-movement",
  {
    tag: ["@load", "@sessions", "@messages", "@transport", "@visual"],
  },
  async ({ isolatedState: state, page }, info) => {
    const wire: unknown[] = [];
    page.on("websocket", (socket) => {
      socket.on("framereceived", (frame) => {
        const value = JSON.parse(String(frame.payload));
        if (value.t === "load.chunk") wire.push(value);
      });
      socket.on("framesent", (frame) => {
        const value = JSON.parse(String(frame.payload));
        if (
          value.t === "view" ||
          value.t === "request" && value.method === "session.messages"
        ) wire.push(value);
      });
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.clock.install();
    const { session } = await state.observe<{ session: { id: string } }>();
    await state.product("layout.patch", {
      rightCollapsed: false,
      rightView: "sessions",
    });
    await page.goto(`${state.url}/#/local/${session.id}`);
    await expect(
      page.getByRole("region", { name: "Transcript", exact: true }).getByRole(
        "status",
      ),
    )
      .toHaveText("Loading messages...");
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "thaw",
    });
    await expect(page.getByText("Core transcript", { exact: true }))
      .toBeVisible();
    await info.attach("q5-boundary-wire", {
      body: JSON.stringify(wire),
      contentType: "application/json",
    });
    const status = page.locator(".otk-shell-progress");
    await expect(status).toHaveText("Loading messages...");
    const row = page.locator(".otk-session-row").first();
    const before = await row.boundingBox();
    const bodyBefore = await page.getByText("Core transcript", { exact: true })
      .boundingBox();
    await page.clock.setFixedTime(
      new Date(await page.evaluate(() => Date.now()) + 61000),
    );
    await page.clock.runFor(1100);
    await expect(status).toHaveText(
      /Still loading messages \(\d+ s\): waiting for opencode to respond/,
    );
    await expect(page.locator(".otk-session-loading-row")).toContainText(
      /Still loading sessions/,
    );
    await expect(status).toHaveCount(1);
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
      await page.screenshot({
        path: info.outputPath(`q5-${name}-boundary-wait.png`),
        fullPage: true,
      });
    }
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "release",
    });
    await expect(page.locator(".otk-session-loading-row")).toHaveCount(0);
    await expect(status).not.toContainText(/loading messages/i);
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "freeze",
    });
    await expect(status).toHaveText("");
    expect((await row.boundingBox())?.y).toBe(before?.y);
    expect(
      (await page.getByText("Core transcript", { exact: true }).boundingBox())
        ?.y,
    ).toBe(bodyBefore?.y);
  },
);
