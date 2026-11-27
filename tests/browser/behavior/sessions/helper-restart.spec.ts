// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { openLatestWork, prompt } from "../../pages/transcript.ts";

test.use({ profile: "sessions-tasks" });

test("sessions.running-helper-recovers-after-sidecar-restart", {
  tag: ["@sessions", "@transport", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const welcomes: { build: string; instance: string }[] = [];
  let documents = 0;
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents++;
  });
  page.on("websocket", (socket) => {
    if (!new URL(socket.url()).pathname.endsWith("/api/ws")) return;
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const frame = JSON.parse(payload);
      if (frame.t === "welcome") welcomes.push(frame.sidecar);
    });
  });
  await state.product("prefs.set", { key: "expandDelegation", value: true });
  const parent = await state.native<{ id: string }>("/session", "POST", {
    title: "Helper restart parent",
  });
  await openSession(state, page, parent.id);
  await state.controller.call("queueScript", {
    lease: state.lease.lease,
    chunks: [],
    tool: {
      name: "task",
      input: {
        subagent_type: "general",
        description: "Held helper",
        prompt: "Reply after the restart",
      },
    },
  });
  const held = await state.queue(["The helper is still here"], "stepped");
  await state.queue(["The parent received the reply"]);
  await prompt(page, "Start a helper");
  await openLatestWork(page);
  const running = page.locator("[data-tool=task][data-tool-status=running]");
  const task = running.locator(".otk-task-card");
  await expect(task).toContainText("Open task");
  await expect(task).toContainText("0 tool calls");
  const children = await state.native<{ id: string }[]>(
    `/session/${parent.id}/children`,
  );
  expect(children).toHaveLength(1);
  const childID = state.sessionID(children[0].id);

  await state.controller.call("restart", {
    lease: state.lease.lease,
    target: "sidecar",
  });
  await expect.poll(() => welcomes.at(-1)?.instance).not.toBe(
    welcomes[0].instance,
  );
  expect(welcomes.at(-1)?.build).toBe(welcomes[0].build);
  await expect(page.getByRole("region", { name: "Transcript", exact: true }))
    .toHaveAttribute("aria-busy", "false");
  // Only the running call can satisfy these; the provider is not released yet.
  await expect(task).toContainText("Open task");
  await expect(task).toContainText("0 tool calls");
  await task.click();
  await expect(page).toHaveURL(new RegExp(`${childID}$`));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${parent.id}$`));
  expect(documents).toBe(1);

  await state.release(held.gate);
  await expect(page.getByRole("region", { name: "Transcript", exact: true }))
    .toContainText("The parent received the reply");
});
