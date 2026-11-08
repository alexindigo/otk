// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { seed, tool } from "../../pages/attention.ts";

test.use({ profile: "isolated", timezoneId: "America/Los_Angeles" });
for (
  const view of [
    "direct",
    "crumb",
    "parent",
    "reload",
    "reconnect",
    "cold",
    "publication",
  ]
) {
  test(`attention.permission-owner-helper-${view}`, {
    tag: ["@attention", "@sessions", "@messages", "@transport", "@isolated"],
  }, async ({ isolatedState: state, page }, info) => {
    const parent = await seed(state, "Permission owner parent");
    const frames = await wire(page);
    await openSession(state, page, parent.id);
    if (view === "publication") {
      frames.hold((f) => f.t === "index.patch" || f.t === "index.snapshot");
    }
    const child = await seed(
      state,
      "Execute optimized-preview-build plan",
      parent.id,
    );
    await tool(state, "bash", {
      command: "printf permission-owner-output",
      description: "Helper permission owner probe",
    });
    await state.queue(["Helper permission owner completed"]);
    await state.native(`/session/${child.id}/prompt_async`, "POST", {
      parts: [{ type: "text", text: "Run the helper permission probe" }],
    });
    await expect.poll(async () =>
      (await state.native<{ sessionID: string }[]>("/permission")).some((p) =>
        p.sessionID === child.nativeID
      )
    ).toBe(true);
    if (view === "publication") {
      await expect.poll(() =>
        frames.received.some((f) =>
          f.t === "content" &&
          (f.event as { op?: string })?.op === "permission.upsert"
        )
      ).toBe(true);
      frames.release();
    }
    if (view === "cold") {
      await state.controller.call("restart", {
        lease: state.lease.lease,
        target: "sidecar",
      });
      await page.reload();
    }
    await info.attach("pending-authority-before-presentation", {
      body: JSON.stringify({
        view,
        native: await state.native("/permission"),
        child: await state.product("permission.list", { sessionID: child.id }),
        parent: await state.product("permission.list", {
          sessionID: parent.id,
        }),
        frames: frames.received,
      }),
      contentType: "application/json",
    });
    const parentRow = page.locator(`[data-session="${parent.id}"]`);
    const childRow = page.locator(`[data-session="${child.id}"]`);
    await expect(parentRow).toContainText("P 1");
    await expect(childRow).toContainText("P 1");
    const crumb = page.locator(`[data-crumb="${child.id}"]`);
    await expect(crumb.locator(".otk-status-light")).toHaveAttribute(
      "data-state",
      "blocked",
    );
    if (view === "direct") {
      await page.clock.setFixedTime(Date.now() + 12 * 86400_000 + 60_000);
      await page.goto(`${state.url}/#/local/${child.id}`);
    } else if (view !== "parent" && view !== "publication") await crumb.click();
    if (view === "reload") await page.reload();
    if (view === "reconnect") {
      const before = frames.connections().opened;
      frames.close();
      await expect.poll(() => frames.connections().opened).toBeGreaterThan(
        before,
      );
    }
    const requests = await state.product("permission.list", {
      sessionID: child.id,
    });
    const family = await state.product("permission.list", {
      sessionID: parent.id,
    });
    expect(requests).toHaveLength(1);
    expect(family).toEqual(requests);
    await info.attach("permission-owners", {
      body: JSON.stringify({
        view,
        requests,
        family,
        content: frames.received.filter((f) => f.t === "content"),
      }),
      contentType: "application/json",
    });
    await expect(page.locator(".otk-permission-dock")).toBeVisible();
    await expect(page.locator(".otk-permission-command")).toHaveText(
      "printf permission-owner-output",
    );
    for (const name of ["Allow once", "Always allow", "Reject"]) {
      await expect(page.getByRole("button", { name, exact: true }))
        .toBeVisible();
    }
    const hasComposer = view === "parent" || view === "publication";
    await expect(page.locator(".otk-draft-kept")).toHaveCount(
      hasComposer ? 1 : 0,
    );
    if (view === "direct") {
      await expect(page.locator(".otk-permission-dock .otk-request-age"))
        .toHaveText("Session idle 12 days");
      await expect(
        page.getByRole("button", { name: "Allow once", exact: true }),
      )
        .toHaveAccessibleDescription("Resumes work paused 12 days ago");
      for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
        await state.product("prefs.set", { key: "theme", value: theme });
        await expect(page.locator("html")).toHaveAttribute(
          "data-otk-theme",
          theme,
        );
        await page.getByRole("button", { name: "Allow once", exact: true })
          .focus();
        const geometry = await page.locator(".otk-permission-dock").evaluate(
          (dock) => {
            const box = dock.getBoundingClientRect();
            const surface = dock.querySelector(".otk-surface")!
              .getBoundingClientRect();
            const controls = Array.from(
              dock.querySelectorAll(".otk-permission-actions button"),
              (el) => el.getBoundingClientRect(),
            );
            return {
              dockBottom: box.bottom,
              surfaceBottom: surface.bottom,
              viewport: innerHeight,
              controls: controls.map((r) => ({
                top: r.top,
                bottom: r.bottom,
                center: (r.top + r.bottom) / 2,
              })),
            };
          },
        );
        expect(Math.abs(geometry.dockBottom - geometry.surfaceBottom))
          .toBeLessThan(.5);
        expect(geometry.surfaceBottom).toBeLessThanOrEqual(geometry.viewport);
        expect(
          Math.max(...geometry.controls.map((r) => r.center)) -
            Math.min(...geometry.controls.map((r) => r.center)),
        ).toBeLessThan(.5);
        await page.screenshot({
          path: info.outputPath(`permission-owner-${theme}.png`),
        });
      }
      await page.getByRole("button", { name: "Always allow", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Confirm allow always", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("button", { name: "Reject", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Reject request", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
    }
    const pendingTool = view === "parent" || view === "publication"
      ? "task"
      : "bash";
    if (pendingTool === "bash") {
      await expect(page.locator("[data-tool=bash]")).toContainText(
        "Awaiting permission",
      );
      await expect(page.locator("textarea[name=prompt]")).toHaveCount(0);
    }
    // Replies go through the visible existing dock, to the asking helper.
    await page.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect(page.locator(".otk-permission-dock")).toHaveCount(0);
    if (pendingTool === "bash") {
      await expect(page.locator(".otk-composer-dock")).toHaveCount(0);
    }
    await expect(parentRow).not.toContainText("P 1");
    await expect(childRow).not.toContainText("P 1");
    await expect.poll(async () =>
      (await state.native<
        {
          parts: {
            tool?: string;
            state?: { status?: string; output?: string };
          }[];
        }[]
      >(`/session/${child.id}/message`))
        .some((m) =>
          m.parts.some((p) =>
            p.tool === "bash" && p.state?.status === "completed" &&
            p.state.output === "permission-owner-output"
          )
        )
    ).toBe(true);
    if (pendingTool === "bash") {
      await expect(page.locator("[data-tool=bash]")).not.toContainText(
        "Awaiting permission",
      );
    }
    expect(
      frames.sent.some(({ frame }) =>
        frame.method === "permission.reply" &&
        frame.params?.sessionID === child.id
      ),
    ).toBe(true);
    await expect.poll(async () =>
      (await state.native<
        {
          info: { role: string; time: { completed?: number } };
          parts: { type: string; text?: string }[];
        }[]
      >(`/session/${child.id}/message`))
        .some((m) =>
          m.info.role === "assistant" && m.info.time.completed !== undefined &&
          m.parts.some((p) =>
            p.type === "text" && p.text === "Helper permission owner completed"
          )
        )
    ).toBe(true);
  });
}
