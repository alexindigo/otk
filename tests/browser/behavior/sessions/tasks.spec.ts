// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt, revealAcquired } from "../../pages/transcript.ts";

test.use({ profile: "sessions-tasks" });
test("sessions.real-task-progress-helper-sibling-parent-history-and-draft", {
  tag: ["@sessions", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  test.setTimeout(120_000);
  await state.product("prefs.set", { key: "expandWork", value: true });
  await state.product("prefs.set", { key: "expandDelegation", value: true });
  const root = await state.native<{ id: string }>("/session", "POST", {
    title: "Subagents",
  });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await openSession(state, page, root.id);
  const tool = (name: string, input: Record<string, string>) =>
    state.controller.call("queueScript", {
      lease: state.lease.lease,
      chunks: [],
      tool: { name, input },
    });
  await tool("task", {
    subagent_type: "general",
    description: "First inspection",
    prompt: "Run the child probe",
  });
  await tool("bash", {
    command: "echo child_one",
    description: "Child current command",
  });
  await state.queue(["First child completed."]);
  await state.queue(["First parent completed."]);
  await prompt(page, "Delegate first");
  const task = page.locator("[data-tool=task]");
  await expect(task.locator(".otk-tool-state")).toContainText(
    "First inspection",
  );
  await expect(task.locator(".otk-task-card")).toContainText("Open task");
  await expect(task.locator(".otk-task-card")).toContainText("bash");
  await expect(page.locator(".otk-permission-dock")).toBeVisible();
  await page.locator(".otk-permission-actions > button").first().click();
  await expect(page.locator("[data-tool=task][data-tool-status=completed]"))
    .toContainText("1 tool call", { timeout: 60000 });
  await expect(page.locator("[data-tool=task][data-tool-status=completed]")).not
    .toContainText("1 tool calls");
  await expect(page.locator(".otk-messages")).toContainText(
    "First parent completed.",
  );
  await expect(page.locator(`[data-session="${root.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await tool("task", {
    subagent_type: "general",
    description: "Second inspection",
    prompt: "Answer the second child probe",
  });
  await state.queue(["Second child completed."]);
  await state.queue(["Second parent completed."]);
  await prompt(page, "Delegate second");
  await expect(
    page.locator("[data-tool=task][data-tool-status=completed] .otk-tool-brief")
      .filter({ hasText: /^Second inspection$/ }),
  ).toBeVisible({ timeout: 60000 });
  await expect.poll(async () =>
    (await state.native<
      {
        parts: { tool?: string; name?: string; state?: { status: string } }[];
      }[]
    >(`/session/${root.id}/message`)).flatMap((r) => r.parts).filter((p) =>
      (state.controller.info!.version.startsWith("2.")
        ? p.name === "subagent"
        : p.tool === "task") && p.state?.status === "completed"
    ).length
  ).toBe(2);
  await expect(page.locator(".otk-messages")).toContainText(
    "Second parent completed.",
  );
  await expect(page.locator(`[data-session="${root.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  const raw = await state.native<{ id: string; title: string }[]>(
    `/session/${root.id}/children`,
  );
  expect(raw).toHaveLength(2);
  const children = raw.map((c) => ({ ...c, id: state.sessionID(c.id) }));
  const first = children.find((c) => c.title.includes("First inspection"))!,
    second = children.find((c) => c.title.includes("Second inspection"))!;
  await page.locator("textarea[name=prompt]").fill("Unsent parent work");
  await expect(page.locator(".otk-send-button")).toBeEnabled();
  const card =
    '[data-tool=task]:has(.otk-tool-brief[title="First inspection"]) .otk-task-card';
  await revealAcquired(page, card);
  await page.locator(card).click();
  await expect(page).toHaveURL(new RegExp(`#\/local/${root.id}/${first.id}$`));
  await expect(page.locator(".otk-subagent-bar")).toContainText(
    "First inspection",
  );
  await expect(page.locator(".otk-prompt")).toHaveCount(0);
  await page.locator(".otk-subagent-bar button").nth(2).click();
  await expect(page).toHaveURL(new RegExp(`${second.id}$`));
  await expect(page.locator(".otk-subagent-bar")).toContainText(
    "Second inspection",
  );
  await page.locator(".otk-subagent-bar button").nth(1).click();
  await expect(page).toHaveURL(new RegExp(`${first.id}$`));
  await page.locator(".otk-subagent-bar button").first().click();
  await expect(page).toHaveURL(new RegExp(`#\/local/${root.id}$`));
  await expect(page.locator("textarea[name=prompt]")).toHaveValue(
    "Unsent parent work",
  );
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(new RegExp(`${first.id}$`));
  await expect(page.locator(".otk-subagent-bar")).toContainText(
    "First inspection",
  );
  await expect(page.locator(".otk-prompt")).toHaveCount(0);
  await page.evaluate(() => history.forward());
  await expect(page).toHaveURL(new RegExp(`#\/local/${root.id}$`));
  await expect(page.locator("textarea[name=prompt]")).toHaveValue(
    "Unsent parent work",
  );
  await revealAcquired(page, card);
  await expect(page.locator(card)).toContainText("1 tool call");
  await expect(page.locator(card)).not.toContainText("1 tool calls");
  await expect(page.locator(card)).toContainText(/\ds/);
});
