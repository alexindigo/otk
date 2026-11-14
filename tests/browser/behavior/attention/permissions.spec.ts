// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { file, prompt, reply, seed, tool } from "../../pages/attention.ts";

test.use({ profile: "contract-attention-native" });
test("attention.permission-typed-read-edit-rejection-keeps-real-file", {
  tag: ["@attention", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  const session = await seed(state, "Typed permission details");
  await openSession(state, page, session.id);
  await tool(state, "read", { filePath: `${state.directory}/README.md` });
  await tool(state, "edit", {
    filePath: `${state.directory}/README.md`,
    oldString: "# OTK fixture",
    newString: "# Changed fixture",
  });
  await prompt(page, "Describe the proposed edit");
  const dock = page.locator(".otk-permission-dock");
  await expect(dock.locator(".otk-takeover-where")).toContainText("read");
  await expect(dock).toContainText("README.md");
  await dock.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(dock).toContainText("README.md");
  await expect(dock).toContainText("+1 / \u22121");
  for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await info.attach(`permission-native-preview-${theme}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  }
  await dock.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.locator("textarea[name=rejection]")).toBeVisible();
  await dock.getByRole("button", { name: "Reject request", exact: true })
    .click();
  await expect(dock).toHaveCount(0);
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await file(state, "README.md", "# OTK fixture\n");
  await tool(state, "read", { filePath: `${state.directory}/README.md` });
  await prompt(page, "Describe the read permission");
  await expect(dock.locator(".otk-takeover-where")).toContainText("read");
  await expect(dock).toContainText("README.md");
  await dock.getByRole("button", { name: "Reject", exact: true }).click();
  await dock.getByRole("button", { name: "Reject request", exact: true })
    .click();
  await expect(dock).toHaveCount(0);
});
test("attention.permission-once-completes-native-output-and-idle", {
  tag: ["@attention", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const session = await seed(state, "Permission once");
  await openSession(state, page, session.id);
  await tool(state, "bash", {
    command: "echo otk",
    description: "permission probe",
  });
  await state.queue(["Permission completed"]);
  await prompt(page, "Run the permission probe");
  await expect(page.locator(".otk-permission-command")).toHaveText("echo otk");
  const bounds = await page.locator(".otk-permission-dock").evaluate((
    dock,
  ) => ({
    dock: dock.getBoundingClientRect().bottom,
    surface: dock.querySelector(".otk-surface")!.getBoundingClientRect().bottom,
  }));
  expect(Math.abs(bounds.dock - bounds.surface)).toBeLessThan(.5);
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.locator(".otk-permission-dock")).toHaveCount(0);
  await expect(page.locator("[data-tool=bash][data-tool-status=completed]"))
    .toContainText("otk");
  await reply(page, session.id, "Permission completed");
  const history = await state.native<
    { parts: { type: string; state?: { output?: string } }[] }[]
  >(`/session/${session.id}/message`);
  expect(
    history.some((m) =>
      m.parts.some((p) => p.type === "tool" && p.state?.output?.includes("otk"))
    ),
  ).toBe(true);
});
test("attention.permission-child-routes-real-parent-dock-to-native-child", {
  tag: ["@attention", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const session = await seed(state, "Parent delegation"),
    frames = await wire(page);
  await openSession(state, page, session.id);
  await tool(state, "task", {
    subagent_type: "general",
    description: "OTK child permission probe",
    prompt: "Run the scripted bash probe",
  });
  await tool(state, "bash", {
    command: "echo otk",
    description: "permission probe",
  });
  await state.queue(["Child completed"]);
  await state.queue(["Parent completed"]);
  await prompt(page, "Delegate the permission probe");
  await expect.poll(async () =>
    (await state.native<unknown[]>(`/session/${session.id}/children`)).length
  ).toBe(1);
  const [child] = await state.native<{ id: string; title: string }[]>(
    `/session/${session.id}/children`,
  );
  await expect(page.locator(".otk-permission-child")).toContainText(
    child.title,
  );
  await expect(page.locator(".otk-permission-command")).toHaveText("echo otk");
  await expect(page.locator(`[data-tab="${child.id}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-crumb="${child.id}"] .otk-status-light`))
    .toHaveAttribute("data-state", "blocked");
  await expect(
    page.locator(`[data-session="${child.id}"]`).locator(
      "xpath=ancestor::*[@data-parent][1]",
    ),
  ).toHaveAttribute("data-parent", session.id);
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.locator(".otk-permission-dock")).toHaveCount(0);
  await reply(page, session.id, "Parent completed");
  // The child's finish was never viewed, so its crumb stays (AXIOM 1).
  await expect(page.locator(`[data-crumb="${child.id}"] .otk-status-light`))
    .toHaveAttribute("data-state", "finished");
  await expect(page.locator(`[data-tab="${child.id}"]`)).toHaveCount(0);
  expect(
    frames.sent.some(({ frame }) =>
      frame.method === "permission.reply" &&
      frame.params?.sessionID === child.id
    ),
  ).toBe(true);
  const history = await state.native<
    {
      parts: { tool?: string; state?: { status: string; output?: string } }[];
    }[]
  >(`/session/${child.id}/message`);
  expect(
    history.some((m) =>
      m.parts.some((p) =>
        p.tool === "bash" && p.state?.status === "completed" &&
        p.state.output?.includes("otk")
      )
    ),
  ).toBe(true);
});
test.describe("native helper lifecycle", () => {
  test.use({ profile: "isolated" });
  test("sessions.native-helper-phantom-parent-task-rollup-and-crumb-lifetime", {
    tag: ["@sessions", "@attention", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    const parent = await seed(state, "No-task parent"),
      child = await seed(state, "Live helper", parent.id),
      other = await seed(state, "Other session");
    await openSession(state, page, other.id);
    await tool(state, "bash", {
      command: "echo otk",
      description: "Helper permission",
    });
    const gate = await state.queue(["Helper finished"], "held");
    await state.native(`/session/${child.id}/prompt_async`, "POST", {
      parts: [{ type: "text", text: "Run the helper probe" }],
    });
    const parentTab = page.locator(`[data-tab="${parent.id}"]`);
    await expect(parentTab.locator(".otk-status-light"))
      .toHaveAttribute("data-state", "blocked");
    await expect(page.locator(`[data-tab="${child.id}"]`)).toHaveCount(0);
    await parentTab.click();
    const crumb = page.locator(`[data-crumb="${child.id}"]`);
    await expect(crumb.locator(".otk-status-light")).toHaveAttribute(
      "data-state",
      "blocked",
    );
    const task = await state.product("tasks.create", {
      directory: state.directory,
      name: "Supervised task",
      sessions: [parent.id],
    });
    const tab = page.locator(`[data-tab="${task.id}"]`);
    await expect(tab.locator(".otk-status-light")).toHaveAttribute(
      "data-state",
      "blocked",
    );
    await expect(parentTab).toHaveCount(0);
    await page.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect(crumb.locator(".otk-status-light")).toHaveAttribute(
      "data-state",
      "working",
    );
    await expect(tab.locator(".otk-status-light")).toHaveAttribute(
      "data-state",
      "working",
    );
    await crumb.click();
    await expect(page).toHaveURL(new RegExp(`${child.id}$`));
    await state.release(gate.gate);
    await expect(crumb).toHaveCount(0);
    await expect(page.locator(`[data-session="${child.id}"]`)).toBeVisible();
    // The viewed finish is acknowledged; with no evidence left the lamp is grey.
    await expect(tab.locator(".otk-status-light")).toHaveAttribute(
      "data-state",
      "none",
    );
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await page.reload();
    await expect(crumb).toHaveCount(0);
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(`[data-tab="${child.id}"]`)).toHaveCount(0);
  });
});
test(
  "attention.permission-reopen-always-confirmation-covered-command-and-dirty-reject",
  { tag: ["@attention", "@isolated"] },
  async ({ isolatedState: state, page }) => {
    const session = await seed(state, "Permission choices"),
      other = await seed(state, "Other session"),
      frames = await wire(page);
    await openSession(state, page, other.id);
    await tool(state, "bash", {
      command: "echo otk",
      description: "permission probe",
    });
    await state.queue(["Always completed"]);
    await state.native(`/session/${session.id}/prompt_async`, "POST", {
      parts: [{ type: "text", text: "Ask while not viewed" }],
    });
    await expect.poll(async () =>
      (await state.native<{ sessionID: string }[]>("/permission")).some((p) =>
        p.sessionID === session.nativeID
      )
    ).toBe(true);
    await openSession(state, page, session.id);
    const dock = page.locator(".otk-permission-dock");
    await dock.locator("h2").click();
    await page.keyboard.press("2");
    await expect(page.locator(".otk-permission-confirm")).toContainText(
      "echo *",
    );
    expect(
      frames.sent.filter(({ frame }) => frame.method === "permission.reply"),
    ).toHaveLength(0);
    await page.getByRole("button", {
      name: "Confirm allow always",
      exact: true,
    }).click();
    await reply(page, session.id, "Always completed");
    await tool(state, "bash", {
      command: "echo covered",
      description: "permission probe",
    });
    await state.queue(["Covered command completed"]);
    await prompt(page, "Use the approved echo pattern");
    await reply(page, session.id, "Covered command completed");
    await expect(
      page.locator("[data-tool-status=completed]").filter({
        hasText: "echo covered",
      }),
    ).toBeVisible();
    expect(
      frames.sent.filter(({ frame }) => frame.method === "permission.reply"),
    ).toHaveLength(1);
    await tool(state, "bash", {
      command: "printf rejected",
      description: "permission probe",
    });
    await state.queue(["Rejection handled"]);
    await prompt(page, "Ask for a different command");
    await expect(page.locator(".otk-permission-command")).toHaveText(
      "printf rejected",
    );
    await dock.locator("h2").click();
    await page.keyboard.press("3");
    const rejection = page.locator("textarea[name=rejection]"),
      first = page.locator(".otk-permission-actions button").first();
    await expect(rejection).toBeVisible();
    await expect(first).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(rejection).toHaveCount(0);
    await expect(first).toBeFocused();
    await page.keyboard.press("3");
    await expect(rejection).toBeVisible();
    await expect(first).toBeFocused();
    await rejection.fill("Please use another approach");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.locator(`[data-session="${other.id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${session.id}$`));
    await expect(rejection).toHaveValue("Please use another approach");
    await page.getByRole("button", { name: "Reject request", exact: true })
      .click();
    await expect(dock).toHaveCount(0);
    await expect(page.locator("[data-tool-status=denied]")).toBeVisible();
    await expect(page.locator("[data-tool-status=denied] .otk-tool-toggle"))
      .toHaveCSS("text-decoration-line", "line-through");
    const replies = frames.sent.filter(({ frame }) =>
      frame.method === "permission.reply"
    ).map(({ frame }) => frame.params);
    expect(replies.some((p) => p?.reply === "always")).toBe(true);
    expect(
      replies.some((p) =>
        p?.reply === "reject" && p.message === "Please use another approach"
      ),
    ).toBe(true);
    await reply(page, session.id, "Rejection handled");
  },
);
