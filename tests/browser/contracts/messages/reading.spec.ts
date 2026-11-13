// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { revealAcquired } from "../../pages/transcript.ts";
test.use({ profile: "contract-messages-reading" });
test("messages.reading-column-renderers-metadata-retry-tab-title", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page }) => {
  await page.setViewportSize({ width: 2000, height: 1100 });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await openSession(state, page, "tstv1-otk");
  await expect(page.locator(".otk-message-footer")).toHaveCount(1);
  await expect(page).toHaveTitle("Execution — otk — OTK");
  await expect(page.locator(".otk-work-fold")).toHaveCount(1);
  await expect(page.locator(".otk-user-bubble")).toBeVisible();
  await expect(page.locator("[data-role=assistant] .otk-text").first())
    .toBeVisible();
  await page.locator(".otk-work-fold").click();
  await expect(page.locator("[data-role=assistant] .otk-message-role"))
    .toHaveCount(0);
  const geometry = await page.evaluate(() => {
    const p = document.querySelector("[data-message=step-1] .otk-text p")!,
      c = document.querySelector("[data-message=step-1] .otk-code")!,
      a = p.getBoundingClientRect(),
      z = c.getBoundingClientRect(),
      s = getComputedStyle(p);
    return {
      prose: a.width,
      code: z.width,
      left: a.left,
      codeLeft: z.left,
      font: s.fontFamily,
      size: s.fontSize,
      line: s.lineHeight,
    };
  });
  expect(geometry.prose).toBeLessThanOrEqual(736);
  expect(Math.abs(geometry.code - geometry.prose)).toBeLessThan(.5);
  expect(Math.abs(geometry.left - geometry.codeLeft)).toBeLessThan(.5);
  expect(geometry.font).toContain("IBM Plex Sans");
  expect([geometry.size, geometry.line]).toEqual(["14px", "24px"]);
  await expect(page.locator("[data-tool=bash] .otk-tool-toggle"))
    .toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("[data-tool=bash] .otk-tool-body")).toHaveCount(0);
  await page.locator("[data-tool=bash] .otk-tool-toggle").click();
  await expect(page.locator("[data-tool=bash] .otk-tool-output")).toHaveText(
    "reported directory",
  );
  await page.locator("[data-tool=read] .otk-tool-toggle").click();
  await expect(page.locator("[data-tool=edit] .otk-tool-body")).toHaveCount(0);
  await page.locator("[data-tool=edit] .otk-tool-toggle").click();
  await expect(page.locator("[data-tool=read] .otk-tool-output"))
    .toHaveJSProperty(
      "textContent",
      "Unrecognized read result\n<literal>keep me</literal>",
    );
  await expect(page.locator("[data-tool=read] .otk-tool-output literal"))
    .toHaveCount(0);
  await page.locator("[data-tool=read] .otk-tool-toggle").click();
  await expect(page.locator("[data-tool=edit] .otk-tool-toggle"))
    .toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("[data-tool=edit] .otk-diff")).toContainText(
    "const after = true;",
  );
  await expect(page.locator("[data-tool=bash] .otk-tool-state")).not
    .toContainText("completed");
  await expect(page.locator(".otk-reasoning > button")).toHaveText(
    "Thought for 4.0s",
  );
  await expect(page.locator("[data-tool=edit] .otk-tool-target")).toHaveText(
    "source.ts",
  );
  await page.locator(".otk-copy-message").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("The reply is complete.");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("A readable reply");
  expect(copied).not.toContain("Reasoning remains available.");
  await page.locator(".otk-reasoning > button").click();
  await expect(page.locator(".otk-reasoning-body")).toContainText(
    "Reasoning remains available.",
  );
  for (
    const value of [
      "build",
      "test/reported-model",
      "6.0s",
      "interrupted",
      "76 tokens · $0.25",
    ]
  ) await expect(page.locator(".otk-message-footer")).toContainText(value);
  await page.locator(".otk-turn-usage > button").focus();
  await expect(page.locator(".otk-turn-usage :popover-open")).toBeAttached();
  await expect(page.locator(".otk-usage-breakdown tfoot tr")).toBeAttached();
  expect(
    await page.locator(".otk-usage-breakdown tfoot tr").evaluate((row) =>
      Array.from(row.children).slice(2, 7).map((c) => c.textContent)
    ),
  ).toEqual(["20", "40", "10", "4", "2"]);
  await page.keyboard.press("Escape");
  await expect(page.locator(".otk-prompt-context > span").first()).toHaveText(
    "Build",
  );
  await expect(page.locator(".otk-prompt-context .otk-composer-provider"))
    .toHaveText("test");
  await expect(page.locator(".otk-prompt-context .otk-composer-model-name"))
    .toHaveText("reported-model");
  await expect(page.getByRole("button", { name: "Attach files", exact: true }))
    .toBeAttached();
  await revealAcquired(page, ".otk-user-bubble");
  const layout = await page.evaluate(() => {
    const lane = document.querySelector(".otk-message-flow")!,
      scroll = document.querySelector(".otk-messages")!,
      bubble = document.querySelector(".otk-user-bubble")!,
      composer = document.querySelector(".otk-composer")!,
      s = getComputedStyle(composer),
      v = getComputedStyle(scroll);
    return {
      lane: lane.getBoundingClientRect().toJSON(),
      scroll: scroll.getBoundingClientRect().toJSON(),
      bubble: bubble.getBoundingClientRect().toJSON(),
      composer: composer.getBoundingClientRect().toJSON(),
      expected: Math.min(
        736,
        scroll.clientWidth - parseFloat(v.paddingLeft) -
          parseFloat(v.paddingRight),
      ),
      border: s.borderTopWidth,
      radius: s.borderRadius,
      font: getComputedStyle(document.querySelector(".otk-message-footer")!)
        .fontFamily,
      hints: /Enter to send|Shift\+Enter for newline|1 \/ 2 \/ 3|j\/k select/
        .test(
          (document.querySelector(".otk-session-view") as HTMLElement)
            .innerText,
        ),
    };
  });
  expect(layout.lane.width).toBe(layout.expected);
  expect(
    Math.abs(
      layout.lane.left + layout.lane.right - layout.scroll.left -
        layout.scroll.right,
    ),
  ).toBeLessThan(1);
  expect(Math.abs(layout.lane.left - layout.composer.left)).toBeLessThan(.5);
  expect(Math.abs(layout.lane.right - layout.composer.right)).toBeLessThan(.5);
  expect(layout.bubble.width).toBeLessThanOrEqual(layout.lane.width * .8 + .5);
  expect(Math.abs(layout.bubble.right - layout.lane.right)).toBeLessThan(.5);
  expect([layout.border, layout.radius]).toEqual(["1px", "20px"]);
  expect(layout.font).toContain("IBM Plex Sans");
  expect(layout.hints).toBe(false);
  await expect(page.locator(".otk-role-label")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      getComputedStyle(
        document.querySelector(".otk-work-fold .otk-divider-label")!,
      ).font ===
        getComputedStyle(document.querySelector(".otk-work-fold")!).font
    ),
  ).toBe(true);
  const rule = await page.locator(".otk-work-fold .otk-divider-rule").evaluate(
    (e) => {
      const s = getComputedStyle(e), canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const c = canvas.getContext("2d")!,
        rgb = (color: string) => {
          c.clearRect(0, 0, 1, 1);
          c.fillStyle =
            getComputedStyle(document.documentElement).backgroundColor;
          c.fillRect(0, 0, 1, 1);
          c.fillStyle = color;
          c.fillRect(0, 0, 1, 1);
          return Array.from(c.getImageData(0, 0, 1, 1).data).slice(0, 3);
        },
        bg = rgb("transparent"),
        distance = (a: number[]) =>
          a.reduce((n, v, i) => n + Math.abs(v - bg[i]), 0);
      return {
        width: s.borderTopWidth,
        style: s.borderTopStyle,
        ratio: distance(rgb(s.borderTopColor)) / distance(rgb(s.color)),
      };
    },
  );
  expect([rule.width, rule.style]).toEqual(["1px", "solid"]);
  expect(rule.ratio).toBeGreaterThan(0);
  expect(rule.ratio).toBeLessThan(.2);
  for (const width of [1280, 1600, 2000]) {
    await page.setViewportSize({ width, height: 1100 });
    await expect.poll(() =>
      page.evaluate(() => {
        const s = document.querySelector(".otk-messages")!,
          c = getComputedStyle(s),
          lane = document.querySelector(".otk-message-flow")!
            .getBoundingClientRect(),
          composer = document.querySelector(".otk-composer")!
            .getBoundingClientRect();
        return Math.abs(
              lane.width -
                Math.min(
                  736,
                  s.clientWidth - parseFloat(c.paddingLeft) -
                    parseFloat(c.paddingRight),
                ),
            ) < .5 &&
          Math.abs(lane.width - composer.width) < .5 &&
          Math.abs(lane.left - composer.left) < .5;
      })
    ).toBe(true);
  }
  await revealAcquired(page, "[data-tool=patch] .otk-tool-toggle");
  await page.locator("[data-tool=patch] .otk-tool-toggle").click();
  await expect(page.locator("[data-tool=patch] .otk-tool-body")).toBeVisible();
  await expect(page.locator("[data-tool=patch] .otk-tool-target")).toHaveText(
    "new-name.ts",
  );
  await expect(page.locator("[data-tool=patch] .otk-diff > header"))
    .toContainText("old-name.ts");
  await expect(page.locator("[data-tool=patch] .otk-diff > header")).not
    .toContainText("new-name.ts");
  await revealAcquired(page, ".otk-work-fold");
  await page.locator(".otk-work-fold").click();
  await expect(page.locator(".otk-work-body")).toHaveCount(0);
  await expect(page.locator(".otk-work-fold")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page.locator(".otk-work-fold").click();
  await expect(page.locator(".otk-work-body")).toBeVisible();
  await expect(page.locator("[data-tool=edit] .otk-diff")).toBeVisible();
  await expect(page.locator("[data-tool=edit] .otk-diff > header")).toHaveCount(
    0,
  );
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "fail",
  });
  await expect(page.locator(".otk-retry-banner strong")).toHaveText(
    "Retrying · attempt 2",
  );
  await expect(page.locator(".otk-retry-banner p")).toHaveText(
    "Waiting for the agent to retry",
  );
  const before = await page.locator(".otk-retry-banner").textContent();
  await expect(page.locator(".otk-retry-banner")).not.toHaveText(before!);
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "succeed",
  });
  await expect(page.locator(".otk-retry-banner")).toHaveCount(0);
  await openSession(state, page, "tstv1-atmosphera");
  await expect(page).toHaveTitle("Approval — atmosphera — OTK");
});
