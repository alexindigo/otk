// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt, settledNativeReply } from "../../pages/transcript.ts";

test.use({ profile: "messages-forms" });

test("messages.reply-footer-overflow", { tag: "@messages" }, async ({
  isolatedState: state,
  page,
  context,
}, info) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Reply footer review",
  });
  await state.product("prefs.set", { key: "theme", value: "otk-dark" });
  await openSession(state, page, session.id);
  for (let i = 1; i < 21; i++) {
    await state.controller.call("queueScript", {
      lease: state.lease.lease,
      chunks: [`Check ${i} completed.`],
      tool: {
        name: "bash",
        input: { command: "pwd", description: `Check ${i}` },
      },
    });
  }
  const line = "const dependencies = [" + '"dependency", '.repeat(45) + "];";
  const answer = `The dependency checks passed.\n\n\`\`\`ts\n${line}\n\`\`\``;
  await state.queue([answer]);
  await prompt(page, "Check the dependencies and show the complete list.");
  await settledNativeReply(state, session.id, answer);
  const transcript = page.getByRole("region", {
    name: "Transcript",
    exact: true,
  });
  const reply = transcript.locator("[data-role=assistant]");
  const footer = reply.locator(".otk-message-footer");
  const chip = footer.locator(".otk-reply-start .otk-entity-pill");
  const code = reply.locator(".otk-code-content");
  await expect(reply.getByText("The dependency checks passed.")).toBeVisible();
  await expect(footer.locator(".otk-turn-usage > button")).toContainText(
    "21 model calls",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-otk-theme",
    "otk-dark",
  );

  const cdp = await context.newCDPSession(page);
  for (
    const [name, width, zoom] of [
      ["100", 1500, 1],
      ["175", 857, 1.75],
      ["narrow", 700, 1],
    ] as const
  ) {
    await test.step(name, async () => {
      const height = Math.round(1150 / zoom);
      await page.setViewportSize({ width, height });
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: zoom,
        mobile: false,
      });
      expect(await page.evaluate(() => [innerWidth, devicePixelRatio])).toEqual(
        [
          width,
          zoom,
        ],
      );
      await page.evaluate(() => document.fonts.ready);
      await expect(footer).toBeInViewport();
      await expect(code).toBeInViewport();
      const capture = process.env.OTK_REPLY_FOOTER_SCREENSHOTS;
      if (capture) {
        await page.screenshot({
          path: `${capture}/${info.project.name}-${name}.png`,
          animations: "disabled",
        });
      }
      expect.soft(await chip.count(), "one chip per distinct agent").toBe(1);
      expect.soft(await chip.first().textContent()).toBe("build");
      expect.soft(
        await code.evaluate((port) => port.scrollWidth - port.clientWidth),
      )
        .toBeGreaterThan(0);
      const bounds = () =>
        footer.evaluate((row) => {
          const port = row.closest(".otk-messages")!;
          const lane = port.querySelector(".otk-message-flow")!
            .getBoundingClientRect();
          const box = row.getBoundingClientRect();
          return {
            inside: box.left >= lane.left && box.right <= lane.right,
            overflow: port.scrollWidth - port.clientWidth,
            left: port.scrollLeft,
          };
        });
      expect.soft(await bounds()).toEqual({
        inside: true,
        overflow: 0,
        left: 0,
      });
      const oversized = await footer.evaluateHandle((row) => {
        const fact = document.createElement("span");
        fact.textContent = "Oversized footer fact ".repeat(100);
        row.querySelector(".otk-message-details")!.append(fact);
        return fact;
      });
      try {
        await expect.poll(() => oversized.evaluate((fact) => fact.hidden)).toBe(
          true,
        );
        expect.soft(await bounds()).toEqual({
          inside: true,
          overflow: 0,
          left: 0,
        });
        await transcript.evaluate((port) =>
          port.scrollBy({ left: port.scrollWidth })
        );
        expect.soft(await bounds()).toEqual({
          inside: true,
          overflow: 0,
          left: 0,
        });
      } finally {
        await oversized.evaluate((fact) => fact.remove());
        await oversized.dispose();
      }
    });
  }
});
