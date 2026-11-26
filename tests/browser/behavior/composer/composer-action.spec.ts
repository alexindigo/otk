// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import type { TestState } from "../../fixtures/test-state.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { seed, tool } from "../../pages/attention.ts";
import { messages, reply } from "../../pages/composer.ts";
import { send } from "../../pages/primary-action.ts";

async function waitForProvider(state: TestState, prompt: string) {
  await expect.poll(async () => {
    const { requests } = await state.observe<{ requests: unknown[] }>({
      fields: ["requests"],
    });
    return requests.some((request) => {
      const body = JSON.stringify(request);
      return body.includes(prompt) &&
        !body.includes("Generate a title for this conversation:");
    });
  }, { timeout: 30_000, message: `Native provider received: ${prompt}` })
    .toBe(true);
}

for (const source of ["enter", "click"] as const) {
  test(
    `composer.action-${source}`,
    { tag: ["@composer", "@isolated"] },
    async ({ isolatedState: state, page }) => {
      const frames = await wire(page);
      const parent = await seed(state, "Composer activation");
      await openSession(state, page, parent.id);
      const button = send(page);
      const input = page.locator("textarea[name=prompt]");
      const notice = page.locator(".otk-composer-notice [role=status]");
      const activate = async () => {
        if (source === "enter") await input.press("Enter");
        else {
          const box = (await button.boundingBox())!;
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        }
      };
      const sends = () =>
        frames.sent.filter(({ frame }) => frame.method === "session.prompt");
      const stops = () =>
        frames.sent.filter(({ frame }) => frame.method === "session.abort");
      const refusal = async (reason: string) => {
        const draft = await input.inputValue(), sent = sends().length;
        for (let i = 0; i < 2; i++) {
          await activate();
          await expect(notice.filter({ hasText: reason })).toHaveCount(1);
          await expect(notice.filter({ hasText: reason })).toBeVisible();
          await expect(input).toHaveValue(draft);
          expect(sends()).toHaveLength(sent);
        }
      };
      await refusal("Write a message");

      await input.fill("Keep this draft while disconnected");
      await page.context().setOffline(true);
      frames.close();
      await expect(button).toBeDisabled();
      await refusal("Reconnecting - message kept");
      await page.context().setOffline(false);
      await expect(button).toBeEnabled({ timeout: 25000 });
      expect(sends()).toHaveLength(0); // Reconnection does not replay a refusal.

      const { gate } = await state.queue(["Held provider reply"], "held");
      frames.hold((frame, request) =>
        frame.t === "request.result" && request?.method === "session.prompt"
      );
      try {
        await activate();
        await expect.poll(() => frames.held.length).toBeGreaterThan(0);
        expect(sends()).toHaveLength(1);
        await expect(input).toHaveValue("");
        await expect(button).toHaveAccessibleName("Stop");
        if (source === "enter") {
          await refusal("Type a message to send");
          expect(stops()).toHaveLength(0);
        }
        await input.fill("Second draft while receipt is held");
        await refusal("Previous message still sending");
      } finally {
        frames.release();
      }
      await expect(button).toBeEnabled();
      await expect(notice.filter({ hasText: "Previous message still sending" }))
        .toHaveCount(0);
      expect(sends()).toHaveLength(1);
      await state.release(gate);
      await reply(state, page, parent.id, "Held provider reply");
      await state.queue(["Second draft received"]);
      await activate();
      await expect.poll(() => sends().length).toBe(2);
      await expect(input).toHaveValue("");
      await reply(state, page, parent.id, "Second draft received");
      await expect.poll(async () =>
        JSON.stringify(await messages(state, parent.id))
      )
        .toContain("Second draft while receipt is held");
    },
  );

  test(`composer.action-delegated-${source}`, {
    tag: ["@composer", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    const frames = await wire(page);
    const parent = await seed(state, "Composer activation during delegation");
    await openSession(state, page, parent.id);
    const input = page.locator("textarea[name=prompt]");
    const button = send(page);
    const status = (id: string) => page.locator(`[data-session="${id}"]`);
    const activation = () =>
      source === "enter" ? input.press("Enter") : button.click();
    const sends = () =>
      frames.sent.filter(({ frame }) => frame.method === "session.prompt");
    const receipt = async (count: number) => {
      await expect.poll(() => sends().length).toBe(count);
      const key = sends()[count - 1].frame.ref!.key;
      await expect.poll(
        () =>
          frames.received.find((frame) =>
            frame.t === "request.result" && frame.ref?.key === key
          )?.outcome,
        { timeout: 30_000 },
      ).toMatchObject({ ok: true });
    };
    await tool(state, "task", {
      subagent_type: "general",
      description: "Held helper",
      prompt: "Run the controlled helper",
    });
    const helper = await state.queue(["Held child response"], "held");
    await input.fill("Start native delegation");
    await button.click();
    await receipt(1);
    await waitForProvider(state, "Run the controlled helper");
    const children = () =>
      state.native<{ id: string }[]>(`/session/${parent.id}/children`);
    await expect.poll(async () => (await children()).length).toBe(1);
    const [child] = await children();
    const childID = child.id.startsWith("ses_")
      ? state.sessionID(child.id)
      : child.id;
    await expect(status(childID)).toHaveAttribute("data-status", "busy");
    await expect(status(parent.id)).toHaveAttribute("data-status", "busy");
    await input.fill("New message during native delegation");
    await expect(button).toHaveAccessibleName("Send");
    await expect(button).toBeEnabled();
    await activation();
    await receipt(2);
    await expect(input).toHaveValue("");
    // Until release, these are actual held native runs, not elapsed-time hopes.
    await expect(status(parent.id)).toHaveAttribute("data-status", "busy");
    await expect(status(childID)).toHaveAttribute("data-status", "busy");
    await state.queue(["Parent answered"]);
    await state.release(helper.gate);
    await expect.poll(async () =>
      JSON.stringify(await messages(state, parent.id))
    )
      .toContain("New message during native delegation");
    await expect(status(parent.id)).toHaveAttribute("data-status", "idle");

    const held = await state.queue(["Reply to stop"], "held");
    await input.fill("Start another run");
    await button.click();
    await receipt(3);
    await waitForProvider(state, "Start another run");
    await expect(status(parent.id)).toHaveAttribute("data-status", "busy");
    await expect(button).toHaveAccessibleName("Stop");
    await button.click();
    await expect.poll(() =>
      frames.sent.some(({ frame }) => frame.method === "session.abort")
    ).toBe(true);
    await state.release(held.gate);
    await expect(status(parent.id)).toHaveAttribute("data-status", "idle");
    await state.queue(["Response after Stop"]);
    await input.fill("Send after Stop worked");
    await expect(button).toBeEnabled();
    await activation();
    await receipt(4);
    await expect.poll(async () =>
      JSON.stringify(await messages(state, parent.id))
    )
      .toContain("Send after Stop worked");
  });
}
