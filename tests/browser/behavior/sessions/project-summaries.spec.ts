// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import type { ProjectSummary } from "@otk/protocol";

test.use({ profile: "isolated" });
test(
  "sessions.server-project-summary-native-transitions-survive-collapse-and-reload",
  {
    tag: ["@sessions", "@attention", "@transport"],
  },
  async ({ isolatedState: state, page }, info) => {
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
  },
);
