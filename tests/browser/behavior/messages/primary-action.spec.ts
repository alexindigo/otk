// SPDX-License-Identifier: LGPL-3.0-only
// Permanent contract copied from INV-S's missing-Send regression.
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { completeUpload, holdUploads, upload } from "../../pages/composer.ts";
import { send as composerPrimary } from "../../pages/primary-action.ts";

for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
  test(`composer.primary-action-visible-${theme}`, {
    tag: ["@composer", "@messages"],
  }, async ({ state, page }, info) => {
    const target = await state.native<{ id: string }>("/session", "POST", {
      title: "Primary action contract",
    });
    const frames = await wire(page);
    await state.product("prefs.set", { key: "theme", value: theme });
    await state.product("prefs.set", { key: "animationsOff", value: true });
    await page.setViewportSize({ width: 1280, height: 800 });
    await openSession(state, page, target.id);
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    const send = page.getByRole("button", { name: "Send", exact: true });
    const input = page.locator("textarea[name=prompt]");
    const capture = async (state: string) => {
      const proof = process.env.OTK_COMPOSER_REFUSAL_SCREENSHOTS;
      if (proof && state.startsWith("refusal-")) {
        const frame = page.locator(".otk-composer-refusal");
        await expect(frame).toBeVisible();
        const primary = composerPrimary(page);
        await primary.focus();
        await expect(primary).toBeFocused();
        const box = (await primary.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        const spacing = await frame.evaluate((node) => {
          const surface = node.getBoundingClientRect();
          const label = node.querySelector(".otk-control-label")!
            .getBoundingClientRect();
          const css = getComputedStyle(node);
          return {
            gaps: [
              label.left - surface.left,
              surface.right - label.right,
              label.top - surface.top,
              surface.bottom - label.bottom,
            ],
            padding: [
              css.paddingLeft,
              css.paddingRight,
              css.paddingTop,
              css.paddingBottom,
            ].map(parseFloat),
          };
        });
        for (const [i, gap] of spacing.gaps.entries()) {
          expect(gap).toBeGreaterThanOrEqual(spacing.padding[i] - 0.5);
        }
        expect(Math.abs(spacing.gaps[0] - spacing.gaps[1])).toBeLessThanOrEqual(
          1,
        );
        await page.screenshot({
          path: `${proof}/composer-${state}-${theme}.png`,
          fullPage: true,
        });
        await page.mouse.move(1, 1);
      }
      if (process.env.OTK_SND1_SCREENSHOTS) {
        await page.screenshot({
          path:
            `${process.env.OTK_SND1_SCREENSHOTS}/${process.env.OTK_SND1_STAMP}-snd1-${theme}-${state}.png`,
          fullPage: true,
        });
      }
    };
    const blocked = async (reason: string, screenshot?: string) => {
      await expect(send).toBeVisible();
      await expect(send).toBeDisabled();
      await expect(send).toHaveAttribute("title", reason);
      await expect(send).toHaveAttribute("aria-description", reason);
      const before = frames.sent.filter(({ frame }) =>
        frame.method === "session.prompt"
      ).length;
      const draft = await input.inputValue();
      await input.press("Enter");
      await send.evaluate((button) => (button as HTMLButtonElement).click());
      await expect(page.locator(".otk-composer-refusal")).toHaveText(reason);
      if (screenshot) await capture(`refusal-${screenshot}`);
      await expect(input).toHaveValue(draft);
      expect(
        frames.sent.filter(({ frame }) => frame.method === "session.prompt"),
      ).toHaveLength(before);
    };
    await expect(input).toHaveValue("");
    await blocked("Write a message", "empty");
    await send.focus();
    await expect(send).toBeFocused();
    const original = await send.elementHandle();
    const emptyBox = await send.boundingBox();
    await capture("empty");
    await input.fill("   ");
    await blocked("Write a message");
    await input.fill("A sendable draft");
    await expect(send).toBeEnabled();
    expect(await send.boundingBox()).toEqual(emptyBox);
    await capture("typed");
    await input.fill("");
    await blocked("Write a message");
    expect(await send.evaluate((node, original) => node === original, original))
      .toBe(true);

    await holdUploads(page);
    await upload(page, [{
      name: "image.png",
      mime: "image/png",
      bytes:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=",
    }]);
    await blocked("Waiting for attachment", "reading-attachment");
    await completeUpload(page, 0);
    await expect(send).toBeEnabled(); // Image-only is sendable.
    await page.getByRole("button", { name: "Remove [Image 1]", exact: true })
      .click();
    await page.evaluate(() => {
      File.prototype.arrayBuffer = () =>
        Promise.reject(new Error("file read failed"));
    });
    await upload(page, [{
      name: "broken.png",
      mime: "image/png",
      bytes: "YQ==",
    }]);
    await blocked("Remove or retry the failed attachment", "failed-attachment");
    await page.getByRole("button", { name: "Remove [Image 1]", exact: true })
      .click();

    // Hold a real mutation receipt, not a fabricated pending product state.
    const running = await state.queue(["A running turn"], "held");
    frames.hold((frame, request) =>
      frame.t === "request.result" && request?.method === "session.prompt"
    );
    await input.fill("Start a running turn");
    await send.click();
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    await expect(stop).toBeEnabled();
    await expect(stop).toBeFocused();
    expect(await stop.boundingBox()).toEqual(emptyBox);
    const gaps = await stop.evaluate((node) => {
      const button = node.getBoundingClientRect();
      const icon = node.querySelector("rect")!.getBoundingClientRect();
      return [
        icon.left - button.left,
        button.right - icon.right,
        icon.top - button.top,
        button.bottom - icon.bottom,
      ];
    });
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
    await expect(page.getByLabel("Message destination")).toBeInViewport();
    await capture("stop");
    const prompts = () =>
      frames.sent.filter(({ frame }) => frame.method === "session.prompt");
    // Preparation precedes the wire; extra RPCs are measured after the original.
    await expect.poll(() => prompts().length).toBe(1);
    await input.press("Enter");
    await expect(page.locator(".otk-composer-refusal")).toHaveText(
      "Type a message to send",
    );
    await capture("refusal-enter-cannot-stop");
    expect(prompts()).toHaveLength(1);
    await input.fill("Second message retained while sending");
    await blocked("Previous message still sending", "previous-send");
    await input.fill("");
    frames.release();
    await expect(stop).toBeEnabled();
    // Enter while sending is consumed; the sent draft clears.
    await expect(input).toHaveValue("");
    await expect(page.locator(`[data-session="${target.id}"]`)).toHaveAttribute(
      "data-status",
      "busy",
    );
    await input.fill("Keep this draft during the running turn");
    await expect(send).toBeEnabled();
    await capture("running");
    expect(frames.sent.filter(({ frame }) => frame.method === "session.abort"))
      .toHaveLength(0);
    expect(prompts()).toHaveLength(1);
    const payload = frames.sent.find(({ frame }) =>
      frame.method === "session.prompt"
    )!.frame.params!;
    expect(payload).not.toHaveProperty("delivery"); // Keep today's native delivery.

    // Prevent reconnection while closing the actual product socket.
    await page.context().setOffline(true);
    frames.close();
    await blocked("Reconnecting - message kept", "reconnecting");
    await capture("offline");
    await page.context().setOffline(false);
    await expect(send).toBeEnabled();
    // A refused Enter keeps the exact draft and never inserts a newline.
    await expect(input).toHaveValue(
      "Keep this draft during the running turn",
    );
    await page.getByRole("button", { name: "Collapse projects", exact: true })
      .click();
    await page.getByRole("button", {
      name: "Collapse right panel",
      exact: true,
    }).click();
    await page.setViewportSize({ width: 600, height: 800 });
    await expect(send).toBeInViewport();
    expect((await send.boundingBox())!.width).toBe(emptyBox!.width);
    await state.release(running.gate);
    await info.attach("send-control", {
      body: JSON.stringify({
        emptyBox,
        finalBox: await send.boundingBox(),
        sameNode: await send.evaluate(
          (node, original) => node === original,
          original,
        ),
      }),
      contentType: "application/json",
    });
    expect(await send.evaluate((node, original) => node === original, original))
      .toBe(true);
  });
}

test(
  "composer.primary-action-unsupported-capability",
  { tag: "@composer" },
  async ({ state, page }) => {
    let prompts = 0;
    await page.routeWebSocket("**/ws", (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((message) => {
        const frame = JSON.parse(message.toString());
        if (frame.method === "session.prompt") prompts++;
        server.send(message);
      });
      server.onMessage((message) => {
        const frame = JSON.parse(message.toString());
        if (frame.t === "welcome") {
          frame.sidecar.harness.capabilities = frame.sidecar.harness
            .capabilities.filter((capability: string) =>
              capability !== "prompt"
            );
        }
        socket.send(JSON.stringify(frame));
      });
    });
    const target = await state.native<{ id: string }>("/session", "POST", {
      title: "Unavailable prompt capability",
    });
    await openSession(state, page, target.id);
    await page.locator("textarea[name=prompt]").fill("Keep this draft");
    const send = page.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeVisible();
    await expect(send).toBeDisabled();
    await expect(send).toHaveAttribute(
      "aria-description",
      "Sending is not supported here",
    );
    await page.locator("textarea[name=prompt]").press("Enter");
    await send.evaluate((node) => (node as HTMLButtonElement).click());
    expect(prompts).toBe(0);
  },
);
