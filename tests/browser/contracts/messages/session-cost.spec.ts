// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
test.use({ profile: "contract-messages-session-cost" });
test("messages.unopened-session-helper-costs-live-display-persistence", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page }) => {
  interface O {
    reads: string[];
    contentReads: string[];
    total: number;
    title: string;
  }
  const row = (id: string) =>
      page.locator(`.otk-session-row[data-session="${id}"]`),
    cost = (id: string) => row(id).locator(".otk-session-cost");
  await page.goto(state.url + "/#/local/tstv1-core");
  await expect(page.locator(".otk-turn-usage > button")).toHaveText(
    "102 model calls · 102 tokens · $1.02",
  );
  await page.getByRole("button", { name: "Open right panel", exact: true })
    .click();
  await expect(page.locator(".otk-right-panel")).toBeVisible();
  await expect(page.locator(".otk-session-row")).toHaveCount(4);
  for (
    const [id, text] of [["tstv1-core", "$1.02"], ["tstv1-helper", "$0.07"], [
      "tstv1-idle",
      "$0.00",
    ]]
  ) await expect(cost(id)).toHaveText(text);
  await expect(cost("tstv1-unknown")).toHaveCount(0);
  await expect.poll(() =>
    page.evaluate(async () => {
      const pane = document.querySelector(".otk-messages")!,
        flow = pane.querySelector<HTMLElement>(".otk-message-flow");
      if (
        !flow || Number(flow.dataset.messageCount) < 20 ||
        !flow.querySelector(".otk-load-older")
      ) return false;
      let previous = "", stable = 0;
      while (stable < 5) {
        await new Promise(requestAnimationFrame);
        if (!flow.querySelector(".otk-load-older")) return false;
        const next = JSON.stringify([
          flow.dataset.messageCount,
          pane.scrollTop,
          pane.scrollHeight,
          pane.clientHeight,
        ]);
        stable = next === previous ? stable + 1 : 0;
        previous = next;
      }
      return true;
    })
  ).toBe(true);
  // Visible costs come from metadata, never background family body acquisition.
  await expect.poll(async () =>
    [...new Set((await state.observe<O>()).contentReads)].sort()
  ).toEqual(["tstv1-core"]);
  const observation = await state.observe<O>(),
    acquired = Number(
      await page.locator(".otk-message-flow").getAttribute(
        "data-message-count",
      ),
    );
  expect(acquired).toBeLessThan(observation.total);
  expect(observation.contentReads.filter((id) => id === "tstv1-core"))
    .toHaveLength(Math.ceil(acquired / 10));
  expect([...new Set(observation.contentReads)].sort()).toEqual([
    "tstv1-core",
  ]);
  for (const id of ["tstv1-helper", "tstv1-idle", "tstv1-unknown"]) {
    expect(observation.contentReads.filter((read) => read === id)).toHaveLength(
      0,
    );
  }
  expect(observation.reads.filter((id) => id === "tstv1-core")).toHaveLength(0);
  expect(observation.reads).not.toContain("tstv1-other");
  await expect(row("tstv1-core")).toHaveAttribute(
    "aria-label",
    `${observation.title}, session cost $1.02`,
  );
  await expect(row("tstv1-helper")).toHaveAttribute(
    "aria-label",
    `Explore callers, child of ${observation.title}, session cost $0.07`,
  );
  const geometry = async () => {
    const boxes = await page.locator(".otk-session-row").evaluateAll((rows) =>
      rows.filter((r) => r.querySelector(".otk-session-cost")).map((r) => {
        const c = r.querySelector(".otk-session-cost")!.getBoundingClientRect(),
          t = r.querySelector(".otk-row-title")!.getBoundingClientRect(),
          l = r.querySelector(".otk-status-light")!.getBoundingClientRect(),
          b = r.getBoundingClientRect();
        return {
          right: c.right,
          centre: c.y + c.height / 2,
          titleCentre: t.y + t.height / 2,
          lightCentre: l.y + l.height / 2,
          height: b.height,
          overflow: r.scrollWidth > r.clientWidth,
        };
      })
    );
    expect(boxes).toHaveLength(3);
    for (const b of boxes) {
      expect(Math.abs(b.right - boxes[0].right)).toBeLessThanOrEqual(.5);
      expect(Math.abs(b.centre - b.titleCentre)).toBeLessThanOrEqual(.5);
      expect(Math.abs(b.centre - b.lightCentre)).toBeLessThanOrEqual(.5);
      expect(b.height).toBe(30);
      expect(b.overflow).toBe(false);
    }
  };
  await geometry();
  const prefs = await state.product("prefs.get", {});
  await state.product("layout.patch", { rightWidth: 280 });
  await expect(page.locator(".otk-right-panel")).toHaveCSS("width", "280px");
  await geometry();
  await state.product("layout.patch", {
    rightWidth: prefs.shellLayout.rightWidth,
  });
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "succeed",
  });
  await expect(cost("tstv1-helper")).toHaveText("$0.12");
  await expect(cost("tstv1-core")).toHaveText("$1.05");
  expect((await state.observe<O>()).contentReads).toEqual(
    observation.contentReads,
  );
  await page.reload();
  await expect(cost("tstv1-core")).toHaveText("$1.05");
  await expect(cost("tstv1-helper")).toHaveText("$0.12");
  await page.locator(".otk-display-menu > button").click();
  await page.locator("input[name=showCost]").click();
  await expect(
    page.locator('.otk-session-cost,.otk-project-sessions [aria-label*="$"]'),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect((await state.product("prefs.get", {})).showCost).toBe(false);
  await page.reload();
  await expect(page.locator(".otk-session-row")).toHaveCount(4);
  await expect(page.locator(".otk-turn-usage > button")).toHaveText(
    "103 model calls · 103 tokens",
  );
  await expect(
    page.locator('.otk-session-cost,.otk-project-sessions [aria-label*="$"]'),
  ).toHaveCount(0);
  await state.product("prefs.set", { key: "showCost", value: true });
  await expect(cost("tstv1-core")).toHaveText("$1.05");
  await row("tstv1-idle").click();
  await expect(page).toHaveURL(/tstv1-idle$/);
  await expect(cost("tstv1-core")).toHaveText("$1.05");
  await expect(cost("tstv1-idle")).toHaveText("$0.00");
  await page.goto(state.url + "/#/local/tstv1-other");
  await expect(cost("tstv1-other")).toHaveText("$3.25");
  await expect(page.locator(".otk-session-row")).toHaveCount(1);
  await page.goto(state.url + "/#/local/tstv1-core");
  await expect(cost("tstv1-core")).toHaveText("$1.05");
  await expect(cost("tstv1-helper")).toHaveText("$0.12");
});
