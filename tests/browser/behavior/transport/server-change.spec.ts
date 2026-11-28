// SPDX-License-Identifier: LGPL-3.0-only
import type { Page, TestInfo, WebSocketRoute } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, throughDuration, wire } from "../../fixtures/wire.ts";
import { reply } from "../../pages/composer.ts";
import { auditUiRules } from "../../pages/ui-rules.ts";

const tag = ["@transport", "@isolated", "@composer"];
const themes = {
  dark: "otk-dark",
  linen: "otk-light",
  stone: "otk-light-stone",
};
const nextBuild = "next-build";
const serverToast = '[data-note="server/local"]';
const footer = ".otk-connection-status";

test(
  "transport.server-change-toast Reload retains one pending send and a newer draft",
  { tag },
  async ({ isolatedState: state, page }) => {
    const frames = await wire(page);
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Pending across Reload",
    });
    await openSession(state, page, session.id);
    frames.hold((frame, request) =>
      frame.t === "content" && frame.sessionID === session.id ||
      frame.t === "load.chunk" &&
        (frame.data as { kind?: string })?.kind === "message-page" ||
      request?.method === "session.messages" ||
      request?.method === "session.prompt" && frame.t === "request.result"
    );
    const answer = "Accepted only once.";
    await state.queue([answer]);
    const prompt = page.locator("textarea[name=prompt]");
    await prompt.fill("Keep this pending submission");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const pending = page.locator('[data-send-state="pending"]');
    await expect(pending).toBeInViewport();
    const id = await pending.getAttribute("data-message");
    const key = await pending.getAttribute("data-send-key");
    await expect.poll(async () =>
      JSON.stringify(
        await state.native<unknown>(`/session/${session.id}/message`),
      )
    ).toContain(answer);
    await prompt.fill("Keep this newer draft too");
    frames.fault({
      t: "error",
      code: "protocol",
      protocol: 999,
      build: nextBuild,
    });
    frames.held.splice(0);
    await page.locator(serverToast).getByRole("button", {
      name: "Reload",
      exact: true,
    }).click();
    await expect(prompt).toHaveValue("Keep this newer draft too");
    const entry = page.locator(`[data-message="${id}"]`);
    await expect(entry).toHaveAttribute("data-send-key", key!);
    await expect(entry).toContainText("Keep this pending submission");
    frames.release();
    await reply(state, page, session.id, answer);
    await expect(entry).toHaveAttribute("data-send-state", "committed");
    await expect(entry).toHaveCount(1);
    await expect(prompt).toHaveValue("Keep this newer draft too");
    expect(
      new Set(
        frames.sent.filter(({ frame }) => frame.method === "session.prompt")
          .map(({ frame }) => frame.ref?.key),
      ),
    ).toEqual(new Set([key]));
  },
);

async function scenario(page: Page) {
  const state = { next: false, down: false, attempts: 0, documents: 0 };
  let socket: WebSocketRoute | undefined;
  const welcomes: { build: string; instance: string }[] = [];
  await page.routeWebSocket("**/api/ws", (client) => {
    if (state.down) return client.close();
    socket = client;
    const server = client.connectToServer();
    client.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const frame = JSON.parse(message.toString());
      if (frame.t !== "welcome") return client.send(message);
      welcomes.push({
        build: frame.sidecar.build,
        instance: frame.sidecar.instance,
      });
      if (state.next) frame.sidecar.build = nextBuild;
      client.send(JSON.stringify(frame));
    });
    client.onClose(() => void server.close());
  });
  await page.route(/\/api\/(session|health)(?:\?|$)/, (route) => {
    if (!state.down) return route.continue();
    if (new URL(route.request().url()).pathname.endsWith("/session")) {
      state.attempts++;
    }
    return route.abort("connectionrefused");
  });
  await page.route("**/*", (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
    state.documents++;
    if (state.down) return route.abort("connectionrefused");
    return route.continue();
  });
  return { state, welcomes, disconnect: () => socket!.close() };
}

async function bootstrapNextDocument(page: Page) {
  // Keep the real document response and its loopback address space. Fulfilling
  // a synthetic navigation can make Chromium block the next loopback socket.
  await page.addInitScript((build) => {
    const observer = new MutationObserver(() => {
      const bootstrap = document.querySelector("#otk-bootstrap");
      if (!bootstrap?.textContent) return;
      observer.disconnect();
      bootstrap.textContent = JSON.stringify({
        ...JSON.parse(bootstrap.textContent),
        build,
      });
    });
    observer.observe(document, { subtree: true, childList: true });
  }, nextBuild);
}

async function shot(page: Page, info: TestInfo, state: string, theme: string) {
  const name = `server-${state}-${theme}.png`;
  const path = info.outputPath(name);
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

async function auditToastSpacing(page: Page) {
  const toast = page.locator(serverToast);
  const reload = toast.getByRole("button", { name: "Reload", exact: true });
  const verify = () =>
    toast.evaluate((surface) => {
      const card = surface.getBoundingClientRect();
      const boxes = [
        ".otk-toast-title",
        ".otk-toast-close svg",
        ".otk-toast-action",
      ].map((selector) => {
        const node = surface.querySelector(selector)!;
        if (node instanceof SVGElement) return node.getBoundingClientRect();
        const text = document.createRange();
        text.selectNodeContents(node);
        return text.getBoundingClientRect();
      });
      const text = boxes[2];
      const button = surface.querySelector(".otk-toast-action")!;
      const action = button.getBoundingClientRect();
      const start = text.left - action.left, end = action.right - text.right;
      return {
        outer: Math.min(
          ...boxes.flatMap((
            box,
          ) => [
            box.left - card.left,
            card.right - box.right,
            box.top - card.top,
            card.bottom - box.bottom,
          ]),
        ),
        actionInset: Math.min(start, end),
        asymmetry: Math.abs(start - end),
        token: parseFloat(getComputedStyle(button).paddingInlineStart),
      };
    });
  const check = async () => {
    const gaps = await verify();
    expect(gaps.outer).toBeGreaterThanOrEqual(11);
    expect(gaps.actionInset).toBeGreaterThanOrEqual(gaps.token - 1);
    expect(gaps.asymmetry).toBeLessThanOrEqual(1);
  };
  await check();
  await reload.hover();
  await check();
  await page.mouse.move(0, 0);
  await toast.getByRole("button", { name: "Dismiss notification" }).focus();
  await page.keyboard.press("Tab");
  await expect(reload).toBeFocused();
  await check();
}

for (const [theme, preference] of Object.entries(themes)) {
  test(
    `transport.server-change-new-build-reload ${theme}`,
    { tag },
    async ({ isolatedState, page }, info) => {
      await isolatedState.product("prefs.set", {
        key: "theme",
        value: preference,
      });
      const { state, welcomes } = await scenario(page);
      const session = await isolatedState.native<{ id: string }>(
        "/session",
        "POST",
        { title: "Deploy keeps work" },
      );
      await openSession(isolatedState, page, session.id);
      const prompt = page.locator("textarea[name=prompt]");
      await prompt.fill("Draft survives the deploy");
      const { instance } = welcomes[0];
      state.next = true;
      await isolatedState.controller.call("restart", {
        lease: isolatedState.lease.lease,
        target: "sidecar",
      });
      const toast = page.locator(serverToast);
      await expect(toast).toHaveCount(1, { timeout: 20_000 });
      await expect(toast).toContainText("OTK was updated");
      await expect(toast).toContainText("Drafts are kept");
      await expect(page.locator(footer)).toContainText("OTK was updated");
      expect(welcomes.at(-1)?.instance).not.toBe(instance);
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        preference,
      );
      await auditUiRules(page, info, `server-updated-${theme}`);
      await shot(page, info, "updated", theme);
      await auditToastSpacing(page);
      const reload = toast.getByRole("button", { name: "Reload", exact: true });
      const documents = state.documents;
      await bootstrapNextDocument(page);
      await Promise.all([page.waitForEvent("load"), reload.click()]);
      expect(state.documents).toBe(documents + 1);
      expect(
        JSON.parse((await page.locator("#otk-bootstrap").textContent())!).build,
      ).toBe(nextBuild);
      await expect(prompt).toHaveValue("Draft survives the deploy");
      await expect(page.locator('[data-connection-state="connected"]').first())
        .toBeVisible();
      await expect(page.locator('[data-note^="server/"]')).toHaveCount(0);
    },
  );

  test(
    `transport.server-change-same-build-restart ${theme}`,
    { tag },
    async ({ isolatedState, page }, info) => {
      await isolatedState.product("prefs.set", {
        key: "theme",
        value: preference,
      });
      const { state, welcomes } = await scenario(page);
      const session = await isolatedState.native<{ id: string }>(
        "/session",
        "POST",
        { title: "Server restarted" },
      );
      await openSession(isolatedState, page, session.id);
      const first = welcomes[0];
      const documents = state.documents;
      await isolatedState.controller.call("restart", {
        lease: isolatedState.lease.lease,
        target: "sidecar",
      });
      const toast = page.locator(serverToast);
      await expect(toast).toHaveCount(1, { timeout: 20_000 });
      expect(welcomes.at(-1)?.build).toBe(first.build);
      expect(welcomes.at(-1)?.instance).not.toBe(first.instance);
      await expect(toast).toContainText("OTK server restarted");
      await expect(toast).toContainText("Reconnected");
      await expect(toast.getByRole("button", { name: "Reload" })).toHaveCount(
        0,
      );
      await expect(page.locator("body")).not.toContainText("OTK was updated");
      await shot(page, info, "restarted", theme);
      await expect(toast).toHaveCount(0, { timeout: 8000 });
      expect(state.documents).toBe(documents);
    },
  );

  test(
    `transport.server-change-unreachable-single-toast ${theme}`,
    { tag },
    async ({ isolatedState, page }, info) => {
      test.setTimeout(90_000);
      await isolatedState.product("prefs.set", {
        key: "theme",
        value: preference,
      });
      const { state, disconnect } = await scenario(page);
      const session = await isolatedState.native<{ id: string }>(
        "/session",
        "POST",
        { title: "Retry keeps work" },
      );
      await openSession(isolatedState, page, session.id);
      const prompt = page.locator("textarea[name=prompt]");
      await prompt.fill("Draft stays while offline");
      await page.evaluate(() => document.body.dataset.mark = "same-page");
      const documents = state.documents;
      state.down = true;
      await disconnect();
      const toast = page.locator(serverToast);
      await expect(page.locator(footer)).toContainText(
        "Reconnecting to OTK...",
      );
      await throughDuration(
        8000,
        async () => expect(await toast.count()).toBe(0),
      );
      await expect(toast).toHaveCount(1);
      await expect(toast).toContainText("Can't reach OTK");
      await expect(toast).toContainText("Retrying. Drafts are kept.");
      await shot(page, info, "unreachable", theme);
      await toast.evaluate((el) => el.dataset.mark = "same-toast");
      const attempts = state.attempts;
      await expect.poll(() => state.attempts, { timeout: 25_000 })
        .toBeGreaterThanOrEqual(attempts + 2);
      await expect(toast).toHaveCount(1);
      await expect(toast).toHaveAttribute("data-mark", "same-toast");
      await toast.getByRole("button", { name: "Reload", exact: true }).click();
      await expect(toast).toContainText(
        "Still unreachable. Page not reloaded.",
      );
      await expect(page.locator(footer)).toContainText(
        "Still unreachable. Page not reloaded.",
      );
      await expect(page.locator("body")).toHaveAttribute(
        "data-mark",
        "same-page",
      );
      await expect(prompt).toHaveValue("Draft stays while offline");
      expect(state.documents).toBe(documents);
      await shot(page, info, "refused", theme);
      state.down = false;
      state.next = true;
      // The production backoff can already have reached its 30-second cap.
      await expect(toast).toContainText("OTK was updated", { timeout: 35_000 });
      await expect(toast).toHaveAttribute("data-mark", "same-toast");
    },
  );
}
