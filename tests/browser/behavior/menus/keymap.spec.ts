// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { isolatedTest } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { messages, prompt, reply } from "../../pages/composer.ts";
const palette = "dialog[aria-label=Commands][open]";
const keys = 'dialog[aria-label="Keyboard shortcuts"][open]';

test("menus.palette-project-and-slash-share-native-create-command", {
  tag: ["@menus"],
}, async ({ state, page }) => {
  const seed = await state.native<{ id: string }>("/session", "POST", {
    title: "Command invokers",
  });
  const frames = await wire(page);
  await openSession(state, page, seed.id);
  await page.locator(".otk-sidebar-commands button").first().click();
  await expect(page.locator(palette)).toBeVisible();
  await page.locator("input[name=command-search]").fill("New session");
  await page.locator('[data-command="session.new"]').click();
  await expect(page).not.toHaveURL(new RegExp(seed.id + "$"));
  await expect(page.locator(palette)).toHaveCount(0);
  await expect(prompt(page)).toBeVisible();
  const first = page.url();
  await page.locator(".otk-project-tabs .otk-new-session").click();
  await expect(page).not.toHaveURL(first);
  const second = page.url();
  await prompt(page).fill("/new");
  await expect(page.locator(".otk-autocomplete")).toContainText("/new");
  await page.keyboard.press("Enter");
  await expect(page).not.toHaveURL(second);
  await expect(prompt(page)).toHaveValue("");
  expect(
    (await state.native<{ directory: string }[]>("/session")).filter((row) =>
      row.directory === state.directory
    ),
  ).toHaveLength(4);
  expect(frames.sent.filter(({ frame }) => frame.method === "session.create"))
    .toHaveLength(3);
});

test("menus.escape-layer-priority-then-double-escape-native-interrupt", {
  tag: ["@menus"],
}, async ({ state, page }) => {
  const seed = await state.native<{ id: string }>("/session", "POST", {
    title: "Escape layers",
  });
  const frames = await wire(page);
  await openSession(state, page, seed.id);
  await state.controller.call("queueScript", {
    lease: state.lease.lease,
    chunks: [],
    tool: {
      name: "bash",
      input: { command: "echo layers", description: "layer proof" },
    },
  });
  await state.queue(["After permission."]);
  await prompt(page).pressSequentially("Run the layer probe");
  await prompt(page).press("Enter");
  await page.locator(".otk-permission-actions button").nth(1).click();
  await expect(page.locator(".otk-permission-confirm")).toBeVisible();
  await page.keyboard.press("Control+k");
  await expect(page.locator(palette)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(palette)).toHaveCount(0);
  await expect(page.locator(".otk-permission-confirm")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".otk-permission-confirm")).toHaveCount(0);
  await expect(page.locator(".otk-permission-dock")).toBeVisible();
  expect(frames.sent.filter(({ frame }) => frame.method === "session.abort"))
    .toHaveLength(0);
  await page.locator(".otk-permission-actions button").first().click();
  await reply(state, page, seed.id, "After permission.");
  const held = await state.queue(["stream "], "held");
  await prompt(page).fill("Interrupt this long turn");
  await prompt(page).press("Enter");
  await expect(page.locator(`[data-session="${seed.id}"]`)).toHaveAttribute(
    "data-status",
    "busy",
  );
  await expect(
    page.locator("[data-role=assistant] .otk-text").filter({
      hasText: "stream ",
    }),
  ).toContainText("stream");
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-interrupt-confirmation]")).toHaveText(
    "Esc again to interrupt",
  );
  await expect(page.locator(".otk-prompt button[type=submit]")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(`[data-session="${seed.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await expect(
    page.locator(".otk-message-footer").filter({ hasText: "interrupted" }),
  ).toBeVisible();
  expect(frames.sent.filter(({ frame }) => frame.method === "session.abort"))
    .toHaveLength(1);
  await state.release(held.gate);
});

test("menus.rebind-conflict-save-native-key-reload-and-reset", {
  tag: ["@menus"],
}, async ({ state, page }) => {
  const seed = await state.native<{ id: string }>("/session", "POST", {
    title: "Rebind proof",
  });
  const frames = await wire(page);
  await openSession(state, page, seed.id);
  await page.locator(".otk-keys-entry").click();
  await expect(page.locator(keys)).toBeVisible();
  await expect(page.locator('[data-binding="prompt.newline"] > span'))
    .toContainText("Insert newline");
  await expect(page.locator('[data-binding="prompt.submit"] > span'))
    .toContainText("Send prompt");
  await page.locator('[data-binding="palette.open"] button').first().click();
  await page.locator('[data-binding="palette.open"] input').click();
  await page.keyboard.press("Shift+?");
  await expect(page.locator(".otk-dialog [role=alert]")).toContainText(
    "Conflicts with help.keys",
  );
  expect(frames.sent.filter(({ frame }) => frame.method === "prefs.set"))
    .toHaveLength(0);
  await page.keyboard.press("Control+j");
  await expect(page.locator('[data-binding="palette.open"] kbd')).toHaveText(
    "Ctrl+j",
  );
  await expect(page.locator('[data-binding="palette.open"] input')).toHaveCount(
    0,
  );
  await page.keyboard.press("Escape");
  await prompt(page).click();
  await page.keyboard.press("Control+j");
  await expect(page.locator(palette)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(prompt(page)).toBeVisible();
  await page.locator(".otk-keys-entry").click();
  await expect(page.locator('[data-binding="palette.open"] kbd')).toHaveText(
    "Ctrl+j",
  );
  await page.keyboard.press("Escape");
  await prompt(page).click();
  await page.keyboard.press("Control+j");
  await expect(page.locator(palette)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator(".otk-keys-entry").click();
  await page.locator('[data-binding="palette.open"] button').last().click();
  await expect(page.locator('[data-binding="palette.open"] kbd')).toHaveText(
    "Mod+k",
  );
  await page.keyboard.press("Escape");
  await prompt(page).click();
  await page.keyboard.press("Control+k");
  await expect(page.locator(palette)).toBeVisible();
  await page.keyboard.press("Escape");
});

test("menus.essential-agent-forward-reverse-newline-and-native-selection", {
  tag: ["@menus"],
}, async ({ state, page }) => {
  const seed = await state.native<{ id: string }>("/session", "POST", {
    title: "Agent keys",
  });
  const frames = await wire(page);
  await openSession(state, page, seed.id);
  await expect(page.locator(".otk-composer-agent")).toHaveText("Build");
  await prompt(page).click();
  for (
    const [key, agent] of [["Tab", "Plan"], ["Shift+Tab", "Build"], [
      "Tab",
      "Plan",
    ]]
  ) {
    await page.keyboard.press(key);
    await expect(page.locator(".otk-composer-agent")).toHaveText(agent);
  }
  await state.queue(["Selected plan replied."]);
  await prompt(page).pressSequentially("Use the selected agent");
  await page.keyboard.press("Shift+Enter");
  await expect(prompt(page)).toHaveValue("Use the selected agent\n");
  expect((await state.observe<{ requests: unknown[] }>()).requests)
    .toHaveLength(0);
  await page.keyboard.press("Enter");
  await reply(state, page, seed.id, "Selected plan replied.");
  expect(
    frames.sent.find(({ frame }) => frame.method === "session.prompt")!.frame
      .params!.agent,
  ).toBe("plan");
  expect(
    (await messages(state, seed.id)).some((row) =>
      row.info.role === "user" && row.info.agent === "plan"
    ),
  ).toBe(true);
  await prompt(page).click();
  await page.keyboard.press("Shift+?");
  await expect(prompt(page)).toHaveValue("?");
  await expect(page.locator(keys)).toHaveCount(0);
});

isolatedTest.describe("configured primary order", () => {
  isolatedTest.use({ profile: "menus-default" });
  isolatedTest(
    "menus.configured-default-primary-order-preserves-unselected-send",
    { tag: ["@menus", "@isolated"] },
    async ({ isolatedState: state, page }) => {
      const seed = await state.native<{ id: string }>("/session", "POST", {
        title: "Configured default cycle",
      });
      // Read the native catalog through the same public directory catalog port.
      const catalog = await state.product("agents.list", {
        sessionID: seed.id,
        primary: true,
      });
      expect(catalog.map((agent) => agent.name)).toEqual(["plan", "build"]);
      const frames = await wire(page);
      await openSession(state, page, seed.id);
      await expect(page.locator(".otk-composer-agent")).toHaveText("Plan");
      await state.queue(["Default plan replied."]);
      await prompt(page).fill("Keep the backend default");
      await prompt(page).press("Enter");
      await reply(state, page, seed.id, "Default plan replied.");
      expect(
        frames.sent.find(({ frame }) => frame.method === "session.prompt")!
          .frame.params!.agent,
      ).toBe("plan");
      await prompt(page).click();
      for (
        const [key, agent] of [["Tab", "Build"], ["Shift+Tab", "Plan"], [
          "Shift+Tab",
          "Build",
        ]]
      ) {
        await page.keyboard.press(key);
        await expect(page.locator(".otk-composer-agent")).toHaveText(agent);
      }
      await state.queue(["Cycled build replied."]);
      await prompt(page).pressSequentially("Send the cycled agent");
      await prompt(page).press("Enter");
      await reply(state, page, seed.id, "Cycled build replied.");
      expect(
        (await messages(state, seed.id)).filter((row) =>
          row.info.role === "user"
        ).map((row) => row.info.agent),
      ).toEqual(["plan", "build"]);
    },
  );
});
