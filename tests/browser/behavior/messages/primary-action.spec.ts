// SPDX-License-Identifier: LGPL-3.0-only
// Permanent contract copied from INV-S's missing-Send regression.
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { completeUpload, holdUploads, upload } from "../../pages/composer.ts";

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
      if (process.env.OTK_SND1_SCREENSHOTS) {
        await page.screenshot({
          path:
            `${process.env.OTK_SND1_SCREENSHOTS}/${process.env.OTK_SND1_STAMP}-snd1-${theme}-${state}.png`,
          fullPage: true,
        });
      }
    };
    const blocked = async (reason: string) => {
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
      if (reason !== "Reconnect to send") {
        await expect(input).toHaveValue(draft);
      }
      expect(
        frames.sent.filter(({ frame }) => frame.method === "session.prompt"),
      ).toHaveLength(before);
    };
    await expect(input).toHaveValue("");
    await blocked("Write a message");
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
    await blocked("Waiting for attachment");
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
    await blocked("Remove or retry the failed attachment");
    await page.getByRole("button", { name: "Remove [Image 1]", exact: true })
      .click();

    // Hold a real mutation receipt, not a fabricated pending product state.
    const running = await state.queue(["A running turn"], "held");
    frames.hold((frame, request) =>
      frame.t === "request.result" && request?.method === "session.prompt"
    );
    await input.fill("Start a running turn");
    await send.click();
    await expect(send).toHaveAttribute("aria-description", "Sending");
    const prompts = () =>
      frames.sent.filter(({ frame }) => frame.method === "session.prompt");
    // Preparation precedes the wire; extra RPCs are measured after the original.
    await expect.poll(() => prompts().length).toBe(1);
    await blocked("Sending");
    frames.release();
    await expect(send).not.toHaveAttribute("aria-description", "Sending");
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
    await blocked("Reconnect to send");
    await capture("offline");
    await page.context().setOffline(false);
    await expect(send).toBeEnabled();
    // Without a connection Enter keeps its native newline, as before.
    await expect(input).toHaveValue(
      "Keep this draft during the running turn\n",
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
