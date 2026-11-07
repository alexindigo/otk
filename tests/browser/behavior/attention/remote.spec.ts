// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import {
  closeSettings,
  file,
  seed,
  settings,
  tool,
} from "../../pages/attention.ts";
import { focusNotifications, toast } from "../../pages/notifications.ts";
import { collapsed } from "../../pages/sessions.ts";

test.use({ profile: "contract-attention-remote" });
test(
  "attention.remote-child-notification-allow-once-keeps-local-draft-and-produces-file",
  { tag: ["@attention", "@isolated", "@smoke", "@smoke.attention"] },
  async ({ isolatedState: state, page }) => {
    test.setTimeout(90_000);
    const a = await seed(state, "Local selected");
    const b = await state.controller.call<{ id: string; nativeID: string }>(
      "nativeRequest",
      {
        lease: state.lease.lease,
        path: "/session",
        method: "POST",
        body: { title: "Remote parent" },
        target: "remote",
      },
    );
    const { remoteUrl } = await state.observe<{ remoteUrl: string }>();
    const frames = await wire(page);
    await openSession(state, page, a.id);
    await focusNotifications(page);
    await settings(page);
    await page.locator("input[name=url]").fill(remoteUrl);
    await page.locator("input[name=label]").fill("Remote notification host");
    await page.locator(".otk-settings-content > .otk-form button[type=submit]")
      .click();
    await expect(
      page.locator(".otk-toast[data-kind=info]").filter({
        hasText: "Server added",
      }),
    ).toBeVisible();
    const server = page.locator("[data-settings-sidecar]").filter({
      hasText: "Remote notification host",
    });
    await expect(server).toContainText("connected");
    const sidecar = (await server.getAttribute("data-settings-sidecar"))!;
    await closeSettings(page);
    await page.getByRole("button", { name: "Collapse projects", exact: true })
      .click();
    await page.locator(".otk-panel-collapse").click();
    await collapsed(page);
    await page.locator("textarea[name=prompt]").fill("Retain local draft");
    await tool(state, "task", {
      subagent_type: "general",
      description: "Notification child",
      prompt: "Run permission tool",
    }, "remote");
    await tool(state, "bash", {
      command:
        "printf notification-tool-result > notification-result.txt; cat notification-result.txt",
      description: "Notification tool result",
    }, "remote");
    for (const text of ["Child accepted", "Parent accepted"]) {
      await state.controller.call("queueScript", {
        lease: state.lease.lease,
        chunks: [text],
        target: "remote",
      });
    }
    await state.controller.call("nativeRequest", {
      lease: state.lease.lease,
      path: `/session/${b.id}/prompt_async`,
      method: "POST",
      body: {
        parts: [{ type: "text", text: "Delegate notification permission" }],
      },
      target: "remote",
    });
    const children = () =>
      state.controller.call<{ id: string }[]>("nativeRequest", {
        lease: state.lease.lease,
        path: `/session/${b.id}/children`,
        target: "remote",
      });
    await expect.poll(async () => (await children()).length).toBe(1);
    const [child] = await children();
    const note = page.locator(toast(b.id, sidecar));
    await expect(note).toContainText("Allow once");
    await expect(note).toHaveCount(1);
    await collapsed(page);
    await note.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect.poll(async () => {
      const rows = await state.controller.call<
        {
          parts: {
            type: string;
            state?: { status: string; output?: string };
          }[];
        }[]
      >("nativeRequest", {
        lease: state.lease.lease,
        path: `/session/${child.id}/message`,
        target: "remote",
      });
      return rows.some((m) =>
        m.parts.some((p) =>
          p.type === "tool" && p.state?.status === "completed" &&
          p.state.output?.includes("notification-tool-result")
        )
      );
    }).toBe(true);
    await file(
      state,
      "notification-result.txt",
      "notification-tool-result",
      true,
    );
    expect(
      frames.sent.some(({ frame }) =>
        frame.method === "permission.reply" &&
        frame.params?.sessionID === child.id
      ),
    ).toBe(true);
    await expect(page.locator("textarea[name=prompt]")).toHaveValue(
      "Retain local draft",
    );
    await expect(page).toHaveURL(new RegExp(`${a.id}$`));
  },
);
