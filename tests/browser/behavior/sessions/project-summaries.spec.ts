// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import type { ProjectSummary } from "@otk/protocol";

test.use({ profile: "isolated" });
test(
  "sessions.server-project-summary-native-transitions-survive-collapse-and-reload",
  {
    tag: ["@sessions", "@attention", "@transport"],
  },
  async ({ isolatedState: state, page }, info) => {
    const capture = await wire(page);
    const selected = await state.native<{ id: string }>("/session", "POST", {
      title: "Selected project",
    });
    const background = await state.controller.call<
      { id: string; nativeID: string; directory: string }
    >("nativeRequest", {
      lease: state.lease.lease,
      path: "/session",
      method: "POST",
      project: "secondary",
      body: { title: "Background work" },
    });
    await openSession(state, page, selected.id);
    const summary = async () =>
      (await state.product("inbox.get", {})).inbox.summaries
        ?.[background.directory];
    const row = page.locator(
      `[data-project=${JSON.stringify(background.directory)}]`,
    );
    const check = async (status: ProjectSummary["status"], unseen: number) => {
      if (status === "idle") {
        await state.product("layout.patch", { discoveredCollapsed: false });
      }
      await expect.poll(async () => {
        const s = await summary();
        return s && [s.status, s.unseenCount, s.sessionCount, s.authority];
      }).toEqual([status, unseen, 1, "current"]);
      await expect(row).toHaveAttribute("data-rollup", status!);
      await expect(row.locator(`.otk-status-light[data-state=${status}]`))
        .toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${selected.id}$`));
    };
    const begin = (text: string) =>
      state.controller.call("nativeRequest", {
        lease: state.lease.lease,
        path: `/session/${background.nativeID}/prompt_async`,
        method: "POST",
        project: "secondary",
        body: {
          model: { providerID: "fake", modelID: "scripted" },
          parts: [{ type: "text", text }],
        },
      });
    await check("idle", 0);
    const held = await state.queue(["Background working"], "held");
    await begin("Keep this background session working");
    await check("working", 0);
    await state.product("layout.patch", {
      leftCollapsed: true,
      rightCollapsed: true,
      discoveredCollapsed: true,
    });
    await page.reload();
    await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    await expect(page.locator(".otk-right-panel")).toBeHidden();
    await check("working", 0);
    await state.release(held.gate);
    await expect.poll(async () => (await summary())?.status).toBe("finished");
    await state.product("sessions.seen", { sessionID: background.id });
    await check("idle", 0);
    await state.product("layout.patch", { discoveredCollapsed: true });
    await state.controller.call("queueScript", {
      lease: state.lease.lease,
      chunks: [],
      tool: {
        name: "bash",
        input: {
          command: "printf summary_proof",
          description: "Project summary permission",
        },
      },
    });
    const final = await state.queue(["Background completed"], "held");
    await begin("Ask for permission in the background project");
    await check("blocked", 0);
    await page.screenshot({
      path: info.outputPath("project-summary-blocked-collapsed.png"),
      fullPage: true,
    });
    const permissions = await state.product("permission.list", {
      sessionID: background.id,
    });
    expect(permissions).toHaveLength(1);
    await state.product("permission.reply", {
      sessionID: background.id,
      requestID: permissions[0].id,
      reply: "once",
    });
    await state.release(final.gate);
    await check("finished", 1);
    await page.reload();
    await check("finished", 1);
    await page.screenshot({
      path: info.outputPath("project-summary-finished-reloaded.png"),
      fullPage: true,
    });
    await state.product("sessions.seen", { sessionID: background.id });
    await check("idle", 0);
    const entries = capture.received.flatMap((frame) => {
      if (frame.t === "index.snapshot") {
        return frame.entries as import("@otk/protocol").IndexEntry[];
      }
      if (frame.t === "index.patch") {
        return (frame.ops as {
          op: string;
          entry?: import("@otk/protocol").IndexEntry;
        }[])
          .flatMap((op) => op.entry ?? []);
      }
      return [];
    });
    const pending = entries.filter((entry) => entry.id === background.id);
    expect(pending.length).toBeGreaterThan(0);
    for (const entry of pending) {
      expect(
        entry.attention.permissions + entry.attention.questions +
          entry.attention.childPermissions + entry.attention.childQuestions,
      ).toBeGreaterThan(0);
      expect(entry.status).toBe("idle");
      expect(entry.timeUpdated).toBe(0);
      expect(entry.digest).toEqual({
        state: "digesting",
        revision: 0,
        turns: {},
      });
    }
    expect(capture.received.some((frame) =>
      frame.t === "index.patch" &&
      (frame.ops as { op: string; id?: string }[]).some((op) =>
        op.op === "evict" && op.id === background.id
      )
    )).toBe(true);
    const task = await state.product("tasks.create", {
      directory: background.directory,
      name: "Acquired background task",
      sessions: [background.id],
    });
    await page.getByRole("button", { name: "Expand projects", exact: true })
      .click();
    await row.locator(".otk-project-open").click();
    await page.getByRole("button", { name: "Open right panel", exact: true })
      .click();
    await expect(page.locator(`[data-tab=${JSON.stringify(task.id)}]`))
      .toBeVisible();
    await expect(
      page.locator(`[data-session=${JSON.stringify(background.id)}]`),
    ).toBeVisible();
    await page.locator(`[data-session=${JSON.stringify(background.id)}]`)
      .click();
    await expect(page).toHaveURL(new RegExp(`${background.id}$`));
    await expect(page.getByRole("region", { name: "Transcript", exact: true }))
      .toHaveAttribute("aria-busy", "false");
    await page.screenshot({
      path: info.outputPath("view-acquired-project.png"),
      fullPage: true,
    });
  },
);
