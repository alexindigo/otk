// SPDX-License-Identifier: LGPL-3.0-only
import type { WebSocketRoute } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { reply } from "../../pages/composer.ts";

for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
  test(`transport.version-skew-reload preserves unsent work ${theme}`, {
    tag: ["@transport", "@isolated", "@composer"],
  }, async ({ isolatedState: state, page }, info) => {
    await state.product("prefs.set", { key: "theme", value: theme });
    let client: WebSocketRoute | undefined;
    await page.routeWebSocket("**/api/ws", (socket) => {
      client = socket;
      socket.connectToServer();
    });
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Deploy keeps work",
    });
    await openSession(state, page, session.id);
    const prompt = page.locator("textarea[name=prompt]");
    await prompt.fill("This draft must survive the deployment and Reload");
    client!.send(
      JSON.stringify({
        t: "error",
        code: "protocol",
        reason: "client-outdated",
        protocol: 999,
        build: "next-test-build",
      }),
    );
    const status = page.locator(".otk-connection-status").filter({
      hasText: "OTK was updated",
    });
    await expect(status).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Connecting failed");
    await expect(page.locator("body")).not.toContainText(
      "Reconnecting. Your pending action is kept.",
    );
    const reload = status.getByRole("button", { name: "Reload", exact: true });
    await expect(reload).toBeVisible();
    const centers = await status.evaluate((element) => {
      const text = element.querySelector(".otk-feedback-text")!
        .getBoundingClientRect();
      const action = element.querySelector("button")!.getBoundingClientRect();
      return Math.abs(text.y + text.height / 2 - action.y - action.height / 2);
    });
    expect(centers).toBeLessThan(1);
    const screenshot = info.outputPath(`${theme}-updated.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await info.attach("updated-state", {
      path: screenshot,
      contentType: "image/png",
    });
    await reload.click();
    await expect(prompt).toHaveValue(
      "This draft must survive the deployment and Reload",
    );
    await expect(page.locator('[data-connection-state="connected"]').first())
      .toBeVisible();
  });
}

test("transport.reload restores the unsaved prompt editor buffer", {
  tag: ["@transport", "@isolated", "@composer"],
}, async ({ isolatedState: state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Editor custody",
  });
  await openSession(state, page, session.id);
  await page.locator("textarea[name=prompt]").fill("Original prompt");
  await page.getByRole("button", { name: "Edit prompt", exact: true }).click();
  const editor = page.getByRole("dialog").locator("textarea");
  await editor.fill("Unsaved editor bytes, not yet applied to the prompt");
  await page.reload();
  await expect(editor).toHaveValue(
    "Unsaved editor bytes, not yet applied to the prompt",
  );
});

for (const outcome of ["rejected", "preparing"] as const) {
  test(`transport.reload retains ${outcome} send custody`, {
    tag: ["@transport", "@isolated", "@composer", "@messages"],
  }, async ({ isolatedState: state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Reload custody",
    });
    const frames = await wire(page);
    await openSession(state, page, session.id);
    frames.hold((frame, request) =>
      outcome === "preparing"
        ? request?.method === "tasks.create"
        : frame.t === "content" && frame.sessionID === session.id ||
          frame.t === "load.chunk" &&
            (frame.data as { kind?: string })?.kind === "message-page" ||
          request?.method === "session.messages" ||
          request?.method === "session.prompt"
    );
    if (outcome === "rejected") await state.queue(["Held native send"]);
    const prompt = page.locator("textarea[name=prompt]");
    await prompt.fill("Original send retained through reload");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const pending = page.locator('[data-send-state="pending"]');
    await expect(pending).toBeInViewport();
    const id = await pending.getAttribute("data-message");
    if (outcome === "rejected") {
      await expect.poll(() =>
        frames.sent.some(({ frame }) => frame.method === "session.prompt")
      ).toBe(true);
      await expect.poll(async () =>
        JSON.stringify(
          await state.native<unknown>(`/session/${session.id}/message`),
        )
      ).toContain("Held native send");
    } else {
      await expect.poll(() =>
        frames.held.some(({ request }) => request?.method === "tasks.create")
      ).toBe(true);
    }
    await prompt.fill("Newer draft stays independent");
    await page.reload();
    const entry = page.locator(`[data-message="${id}"]`);
    await expect(entry).toContainText("Original send retained through reload");
    await expect(prompt).toHaveValue("Newer draft stays independent");
    await expect(page.locator('[data-connection-state="connected"]').first())
      .toBeVisible();
    if (outcome === "rejected") {
      const request = frames.sent.find(({ frame }) =>
        frame.method === "session.prompt"
      )!.frame;
      frames.fault({
        t: "request.rejected",
        ref: request.ref,
        error: {
          code: "native.rejected",
          diagnosticID: "reload-rejected",
          retry: "new-intent",
          facts: { reason: "Native refused the restored send" },
        },
      });
      await expect(entry).toContainText("Native refused the restored send");
    } else {
      await expect(entry).toContainText("before this message was sent");
      expect(
        frames.sent.filter(({ frame }) => frame.method === "session.prompt"),
      ).toHaveLength(0);
    }
    await expect(entry).toHaveAttribute("data-send-state", "failed");
    await expect(prompt).toHaveValue("Newer draft stays independent");
  });
}

test(
  "transport.updated Reload retains pending-send custody without a second native send",
  {
    tag: ["@transport", "@isolated", "@composer", "@messages"],
  },
  async ({ isolatedState: state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Pending across Reload",
    });
    const frames = await wire(page);
    await openSession(state, page, session.id);
    frames.hold((frame, request) =>
      frame.t === "content" && frame.sessionID === session.id ||
      frame.t === "load.chunk" &&
        (frame.data as { kind?: string })?.kind === "message-page" ||
      request?.method === "session.messages" ||
      request?.method === "session.prompt" && frame.t === "request.result"
    );
    await state.queue(["One native send survived Reload."]);
    const prompt = page.locator("textarea[name=prompt]");
    await prompt.fill("Original pending send, preserve its identity and bytes");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const pending = page.locator('[data-send-state="pending"]');
    await expect(pending).toBeInViewport();
    const id = await pending.getAttribute("data-message");
    const key = await pending.getAttribute("data-send-key");
    await expect.poll(async () =>
      JSON.stringify(
        await state.native<unknown>(`/session/${session.id}/message`),
      )
    ).toContain("One native send survived Reload.");
    await prompt.fill("Newer unsent draft must survive too");
    frames.fault({
      t: "error",
      code: "protocol",
      reason: "client-outdated",
      protocol: 999,
      build: "next-build",
    });
    frames.held.splice(0);
    await page.locator(".otk-connection-status").getByRole("button", {
      name: "Reload",
      exact: true,
    }).click();
    await expect(prompt).toHaveValue("Newer unsent draft must survive too");
    const entry = page.locator(`[data-message="${id}"]`);
    await expect(entry).toHaveAttribute("data-send-key", key!);
    await expect(entry).toContainText("Original pending send");
    frames.release();
    await reply(state, page, session.id, "One native send survived Reload.");
    await expect(entry).toHaveAttribute("data-send-state", "committed");
    await expect(entry).toHaveCount(1);
    await expect(prompt).toHaveValue("Newer unsent draft must survive too");
    expect(
      new Set(
        frames.sent.filter(({ frame }) => frame.method === "session.prompt")
          .map(({ frame }) => frame.ref!.key),
      ).size,
    ).toBe(1);
  },
);
