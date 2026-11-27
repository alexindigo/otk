// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { messages, prompt, reply } from "../../pages/composer.ts";

test("composer.join-delivered-child-and-send", {
  tag: ["@composer", "@sessions", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await state.product("prefs.set", { key: "theme", value: "otk-dark" });
  await state.product("prefs.set", { key: "notify.toast", value: false });
  const v2 = info.project.metadata.nativeVersion === "2.2.6";
  const parent = await state.native<{ id: string }>("/session", "POST", {
    title: "Project planning",
  });
  await state.controller.call("queueScript", {
    lease: state.lease.lease,
    chunks: [],
    tool: {
      name: v2 ? "subagent" : "task",
      input: {
        description: "Review the project plan",
        prompt: "Identify one improvement to the project plan.",
        ...(v2 ? { agent: "explore" } : { subagent_type: "general" }),
      },
    },
  });
  await state.queue([
    "Make the success criteria measurable before work starts.",
  ]);
  await state.queue(["The plan review is complete."]);
  await state.native(`/session/${parent.id}/prompt_async`, "POST", {
    parts: [{ type: "text", text: "Delegate a review of the project plan." }],
  });
  await openSession(state, page, parent.id);
  await reply(state, page, parent.id, "The plan review is complete.");
  const children = await state.product("session.children", {
    sessionID: parent.id,
  });
  expect(children.items).toHaveLength(1);
  const child = children.items[0].id;
  await page.locator(`[data-session="${child}"]`).click();
  await expect(page).toHaveURL(new RegExp(`${child}$`));
  const transcript = page.getByRole("region", {
    name: "Transcript",
    exact: true,
  });
  await expect(transcript).toContainText(
    "Make the success criteria measurable before work starts.",
  );
  const join = page.getByRole("button", { name: "Join the conversation" });
  await expect(join).toBeVisible();
  await expect(prompt(page)).toBeHidden();
  await expect(page.getByRole("button", { name: "Attach files" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Edit prompt" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Send", exact: true }))
    .toBeHidden();
  await expect(page.getByRole("button", { name: /^Model:/ })).toBeHidden();
  const shield = page.getByRole("button", { name: "Auto-approve" });
  await expect(shield).toHaveAttribute("aria-pressed", "false");
  await expect(shield).toHaveAccessibleDescription(
    "Applies to Project planning and its helpers",
  );
  await shield.click();
  await expect(shield).toHaveAttribute("aria-pressed", "true");
  await shield.click();
  await expect(shield).toHaveAttribute("aria-pressed", "false");
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: info.outputPath("child-collapsed-dark.png"),
    animations: "disabled",
  });
  await join.click();
  await expect(prompt(page)).toBeFocused();
  await expect(prompt(page)).toBeVisible();
  await expect(join).toBeHidden();
  await expect(page.getByRole("button", { name: /^Model:/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Attach files" }))
    .toBeVisible();
  await expect(page.getByRole("button", { name: "Edit prompt" })).toBeVisible();
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: info.outputPath("child-joined-dark.png"),
    animations: "disabled",
  });
  const text = "What should we measure first?";
  const answer =
    "Start by measuring how many acceptance criteria can be verified.";
  await state.queue([answer]);
  await prompt(page).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await reply(state, page, child, answer);
  expect(
    (await messages(state, child)).flatMap((message) => message.parts)
      .some((part) => part.text === text),
  ).toBe(true);
});
