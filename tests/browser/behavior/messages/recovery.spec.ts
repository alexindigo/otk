// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";
for (const retry of [false, true]) {
  test.describe(`lost baseline retry ${retry}`, () => {
    test.use({
      profile: retry ? "messages-recovery-retry" : "messages-recovery",
    });
    test(`messages.native-reconnect-terminal-checkpoint-${retry}`, {
      tag: ["@messages"],
    }, async ({ isolatedState: state, page }) => {
      interface O {
        transport: {
          streamCount: number;
          lost: number;
          deltas: number;
          points: string[];
          snapshots: string[];
        };
      }
      const observation = async () => (await state.observe<O>()).transport;
      const control = (action: "hold" | "freeze", sessionID?: string) =>
        state.controller.call("scenario", {
          lease: state.lease.lease,
          action,
          sessionID,
        });
      const session = await state.native<{ id: string; nativeID: string }>(
        "/session",
        "POST",
        { title: "Recovering response review" },
      );
      await control("hold", session.nativeID);
      await page.setViewportSize({ width: 1280, height: 900 });
      await openSession(state, page, session.id);
      const before = (await observation()).streamCount;
      await control("freeze");
      await expect.poll(() => observation().then((o) => o.streamCount))
        .toBeGreaterThan(before);
      await expect(page.locator(".otk-connection-light.is-reconnecting"))
        .toHaveCount(0);
      const chunks = [
          "Checkpoint source begins. ",
          "Later native source continues. ",
          "Final provider source is complete.",
        ],
        reply = await state.queue(chunks, "stepped");
      await prompt(page, "Recover the exact native response");
      await state.release(reply.gate);
      if (retry) {
        await expect(page.locator(".otk-response-recovery")).toContainText(
          "Response refresh unavailable.",
        );
        await page.locator(".otk-response-recovery button").click();
      }
      await expect(page.locator(".otk-response-recovery")).toHaveText(
        "Refreshing response…",
      );
      await expect.poll(() => observation().then((o) => o.snapshots.length))
        .toBe(1);
      const initial = await observation();
      await expect(page.locator("[data-role=assistant] .otk-text")).toHaveText(
        initial.snapshots[0],
      );
      const firstReads = initial.points.length;
      expect(firstReads).toBe(retry ? 2 : 1);
      expect(initial.lost).toBeGreaterThan(0);
      if (!retry) {
        await page.setViewportSize({ width: 800, height: 700 });
        await page.getByRole("button", {
          name: "Collapse projects",
          exact: true,
        }).click();
        await page.getByRole("button", {
          name: "Collapse right panel",
          exact: true,
        }).click();
        await expect.poll(() =>
          page.evaluate(() => {
            const a = document.querySelector(".otk-message-flow")!
                .getBoundingClientRect(),
              b = document.querySelector(".otk-composer-input")!
                .getBoundingClientRect();
            return Math.abs(a.left - b.left) <= 1 &&
              Math.abs(a.right - b.right) <= 1;
          })
        ).toBe(true);
      }
      await state.release(reply.gate);
      await expect.poll(() => observation().then((o) => o.deltas))
        .toBeGreaterThanOrEqual(2);
      // Join the delivered native delta at the consumer with a render/task barrier.
      await page.evaluate(() =>
        new Promise((r) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => setTimeout(r, 0))
          )
        )
      );
      expect((await observation()).points.length).toBe(firstReads);
      await expect(page.locator(".otk-response-recovery")).toHaveText(
        "Refreshing response…",
      );
      await expect(page.locator("[data-role=assistant] .otk-text")).toHaveText(
        initial.snapshots[0],
      );
      await state.release(reply.gate);
      const expected = chunks.join("").trim();
      await expect(page.locator("[data-role=assistant] .otk-text")).toHaveText(
        expected,
      );
      await expect(page.locator(".otk-response-recovery")).toHaveCount(0);
      const native = await state.native<
        {
          info: { id: string; role: string };
          parts: { type: string; text?: string }[];
        }[]
      >(`/session/${session.id}/message`);
      const final = native.filter((m) => m.info.role === "assistant").at(-1)!;
      expect(
        final.parts.filter((p) => p.type === "text").map((p) => p.text).join("")
          .trim(),
      ).toBe(expected);
      expect((await observation()).points.length).toBe(firstReads + 1);
      await page.reload();
      await expect(page.locator("[data-role=assistant] .otk-text")).toHaveText(
        expected,
      );
      await expect(page.locator(".otk-response-recovery")).toHaveCount(0);
      await expect(page.locator(".otk-turn-time")).toBeAttached();
      await expect(page.locator(".otk-turn-time")).not.toHaveText("streaming");
    });
  });
}
