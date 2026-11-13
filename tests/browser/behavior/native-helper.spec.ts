// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../fixtures/evidence.ts";
import { isolatedTest as test } from "../fixtures/isolated.ts";
import { openSession } from "../fixtures/wire.ts";
import { prompt } from "../pages/transcript.ts";

test.use({ profile: "sessions-tasks" });
test("sessions.native-helper-current-tool-uses-shared-name", {
  tag: ["@sessions"],
}, async ({ isolatedState: state, page }, info) => {
  await state.product("prefs.set", { key: "expandWork", value: true });
  await state.product("prefs.set", { key: "expandDelegation", value: true });
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Shared helper tool identity",
  });
  await openSession(state, page, session.id);
  await state.controller.call("queueScript", {
    lease: state.lease.lease,
    chunks: [],
    tool: {
      name: "task",
      input: {
        subagent_type: "general",
        description: "Helper naming proof",
        prompt: "Run the controlled shell probe",
      },
    },
  });
  await state.controller.call("queueScript", {
    lease: state.lease.lease,
    chunks: [],
    tool: {
      name: "bash",
      input: {
        command: "printf helper-name",
        description: "Helper shell probe",
      },
    },
  });
  await state.queue(["Child finished."]);
  await state.queue(["Parent finished."]);
  await prompt(page, "Delegate the controlled helper");
  const card = page.locator("[data-tool=task] .otk-task-card");
  await expect(card).toContainText("bash");
  await expect(page.locator(".otk-permission-dock")).toBeVisible();
  for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await info.attach(`helper-current-${theme}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  }
  await page.locator(".otk-permission-actions > button").first().click();
  await expect(page.locator("[data-tool=task][data-tool-status=completed]"))
    .toContainText("1 tool call");
  await expect(page.locator(".otk-messages")).toContainText("Parent finished.");
});
