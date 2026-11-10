// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, throughDuration, wire } from "../../fixtures/wire.ts";

test.describe("bootstrap", () => {
  test.use({ profile: "transport-bootstrap" });
  test("transport.bootstrap-activity", {
    tag: ["@transport", "@isolated", "@attention"],
  }, async ({ isolatedState: state, page }) => {
    const { bootstrap } = await state.observe<
      {
        bootstrap: {
          busy: { id: string };
          blocked: { id: string };
          directory: string;
        };
      }
    >();
    await page.goto(state.url);
    const project = page.locator(`[data-project="${bootstrap.directory}"]`);
    await project.locator(".otk-project-open").click();
    const inspect = async () => {
      for (
        const [session, status] of [[bootstrap.busy, "working"], [
          bootstrap.blocked,
          "blocked",
        ]] as const
      ) {
        const lamp = page.locator(
          `.otk-tab[data-kind=phantom] [data-tab="${session.id}"] .otk-status-light[data-state=${status}]`,
        );
        await expect(lamp).toBeVisible();
        await expect(lamp).toBeInViewport({ ratio: 1 });
      }
      await expect(project).toHaveAttribute("data-rollup", "blocked");
    };
    await inspect();
    await state.product("layout.patch", {
      leftCollapsed: true,
      rightCollapsed: true,
    });
    await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    await expect(page.locator(".otk-right-panel")).toBeHidden();
    await page.reload();
    await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    await expect(page.locator(".otk-right-panel")).toBeHidden();
    await inspect();
  });
});

test("transport.initial-native-permission", {
  tag: ["@transport", "@isolated", "@attention", "@readiness"],
}, async ({ isolatedState: state, page }) => {
  const session = await state.native<{ id: string; nativeID: string }>(
    "/session",
    "POST",
    { title: "Direct pending permission" },
  );
  await state.controller.call("queueScript", {
    lease: state.lease.lease,
    chunks: [],
    tool: {
      name: "bash",
      input: { command: "git status --short", description: "Inspect tree" },
    },
  });
  await state.native(`/session/${session.id}/prompt_async`, "POST", {
    parts: [{ type: "text", text: "Inspect working tree" }],
  });
  await expect.poll(async () =>
    (await state.native<{ sessionID: string }[]>("/permission")).some((row) =>
      row.sessionID === session.nativeID
    )
  ).toBe(true);
  const pending =
    (await state.native<{ id: string; sessionID: string }[]>("/permission"))
      .find((row) => row.sessionID === session.nativeID)!;
  const frames = await wire(page);
  for (const phase of ["direct", "reload"]) {
    frames.hold(() => true);
    if (phase === "direct") {
      await page.goto(`${state.url}/#/local/${session.id}`);
    } else await page.reload();
    await expect(page.locator(".otk-app")).toBeVisible();
    await expect.poll(() => frames.held.length).toBeGreaterThan(0);
    await expect(
      page.locator(".otk-prompt button[type=submit],.otk-permission-dock"),
    ).toHaveCount(0);
    frames.release();
    await expect(page.locator(".otk-messages")).toContainText(
      "git status --short",
    );
    await expect(page.locator(".otk-permission-dock")).toBeVisible();
    await expect(page.locator(".otk-permission-dock")).toContainText(
      "git status --short",
    );
    await expect(page.locator(".otk-permission-actions button").first())
      .toBeEnabled();
    await expect(page).toHaveURL(`${state.url}/#/local/${session.id}`);
    expect(
      (await state.native<{ id: string }[]>("/permission")).some((row) =>
        row.id === pending.id
      ),
    ).toBe(true);
  }
});

test.describe("independent enrichment", () => {
  test.use({ profile: "transport-enrichment" });
  test("transport.optional-clock-independence", {
    tag: ["@transport", "@isolated", "@duration", "@attention", "@messages"],
  }, async ({ isolatedState: state, page, browser }, info) => {
    test.setTimeout(120_000);
    const a = await state.native<{ id: string; nativeID: string }>(
      "/session",
      "POST",
      { title: "A optional clock" },
    );
    const b = await state.native<{ id: string; nativeID: string }>(
      "/session",
      "POST",
      { title: "B independent authority" },
    );
    const second = await (await state.newContext(browser)).newPage();
    await page.context().grantPermissions(
      ["clipboard-read", "clipboard-write"],
      { origin: state.url },
    );
    const frames = await wire(page);
    await openSession(state, page, a.id);
    await openSession(state, second, b.id);
    await state.product("commands.list", { sessionID: b.id });
    await state.product("agents.list", { sessionID: b.id });
    await state.product("models.list", { sessionID: b.id });
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "hold",
      sessionID: a.nativeID,
    });
    const v2 = info.project.name === "oc-2.2.6";
    await state.queue(["A terminal source stays complete."]);
    await page.locator("textarea[name=prompt]").fill(
      "Complete A before its optional clock",
    );
    await page.locator("textarea[name=prompt]").press("Enter");
    if (v2) {
      // V2 carries the persisted output clock on step.streamed: no optional
      // point-message enrichment should be acquired at all.
      await expect(page.locator("[data-role=assistant] .otk-text")).toHaveText(
        "A terminal source stays complete.",
      );
      await expect(page.locator(`[data-session="${a.id}"]`)).toHaveAttribute(
        "data-status",
        "idle",
      );
    } else {await expect.poll(async () =>
        (await state.observe<{ transport: { entered: boolean } }>()).transport
          .entered
      ).toBe(true);}
    const heldAt = performance.now();
    await state.controller.call("queueScript", {
      lease: state.lease.lease,
      chunks: ["B source is visible while A waits."],
      tool: {
        name: "bash",
        input: { command: "echo independent-b", description: "B permission" },
      },
    });
    await state.queue(["B finished."]);
    const sentAt = performance.now();
    await second.locator("textarea[name=prompt]").fill(
      "Show B and ask for its permission",
    );
    await second.getByRole("button", { name: "Send", exact: true }).click();
    await expect(second.locator(`[data-session="${b.id}"]`)).toHaveAttribute(
      "data-status",
      "busy",
    );
    await expect(second.locator(".otk-messages")).toContainText(
      "B source is visible while A waits.",
    );
    await expect(second.locator(".otk-permission-command")).toHaveText(
      "echo independent-b",
    );
    await expect(page.locator("[data-role=assistant] .otk-text")).toHaveText(
      "A terminal source stays complete.",
    );
    await expect(page.locator(`[data-session="${a.id}"]`)).toHaveAttribute(
      "data-status",
      "idle",
    );
    expect(
      frames.received.some((frame) =>
        frame.t === "content" && frame.sessionID === a.id &&
        JSON.stringify(frame.event).includes('"op":"message.upsert"') &&
        JSON.stringify(frame.event).includes('"completed":')
      ),
    ).toBe(true);
    const paintedMs = performance.now() - sentAt;
    await throughDuration(
      Math.max(0, 40_000 - (performance.now() - heldAt)),
      async () => {
        await expect(second.locator(".otk-permission-command")).toHaveText(
          "echo independent-b",
        );
        expect(
          (await state.observe<{ transport: { holding: boolean } }>()).transport
            .holding,
        ).toBe(true);
      },
    );
    const { transport } = await state.observe<
      {
        transport: {
          holding: boolean;
          entered: boolean;
          reads: number;
          clockAborts: number;
          stripped: number;
          permissionAcceptedAt?: number;
        };
      }
    >();
    if (v2) {
      expect(transport.entered).toBe(false);
      expect(transport.stripped).toBe(0);
      expect(transport.clockAborts).toBe(0);
      expect(transport.reads).toBe(0);
      const native = await state.native<
        { info: { role: string; time: { streamed?: number } } }[]
      >(`/session/${a.id}/message`);
      const clock = native.find((row) =>
        row.info.role === "assistant"
      )!.info.time.streamed;
      expect(clock).toBeGreaterThan(0);
      expect(frames.received.some((frame) =>
        frame.t === "content" && frame.sessionID === a.id &&
        JSON.stringify(frame.event).includes(`"lastOutput":${clock}`)
      )).toBe(true);
    } else {
      expect(transport.entered).toBe(true);
      expect(transport.stripped).toBeGreaterThan(0);
      expect(transport.clockAborts).toBeGreaterThan(0);
      expect(transport.reads - transport.clockAborts).toBe(1);
    }
    expect(transport.permissionAcceptedAt).toBeDefined();
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "release",
    });
    await page.locator('[data-message-command="reply.copy"]').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("A terminal source stays complete.");
    const approval =
      (await state.native<{ id: string; sessionID: string }[]>("/permission"))
        .find((row) => row.sessionID === b.nativeID)!;
    expect(approval).toBeDefined();
    await state.native(`/permission/${approval.id}/reply`, "POST", {
      reply: "once",
    });
    await expect(second.locator("[data-role=assistant] .otk-text").last())
      .toHaveText("B finished.");
    await expect(second.locator(`[data-session="${b.id}"]`)).toHaveAttribute(
      "data-status",
      "idle",
    );
    await page.reload();
    await expect(page.locator("[data-role=assistant] .otk-text")).toHaveText(
      "A terminal source stays complete.",
    );
    await info.attach("enrichment-timing", {
      body: JSON.stringify({
        heldMs: performance.now() - heldAt,
        paintedMs,
        transport,
      }),
      contentType: "application/json",
    });
  });
});
