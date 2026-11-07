// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { copySelection, wheelTranscript } from "../../pages/transcript.ts";
import { acquireOlderHistory } from "../../pages/history.ts";

test.describe("acquired transcript", () => {
  test.use({ profile: "contract-messages-window" });
  test("messages.timeline-window-native-selection", {
    tag: ["@messages", "@contracts"],
  }, async ({ isolatedState: state, page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSession(state, page, "tstv1-otk");
    await page.locator("[data-panel-view=timeline]").click();
    const timeline = page.locator(".otk-timeline");
    await expect.poll(() =>
      timeline.getAttribute("data-prompt-count").then(Number)
    ).toBeGreaterThanOrEqual(20);
    await acquireOlderHistory(page, 105, page.locator(".otk-timeline-older"));
    await expect(page.locator(".otk-timeline-older")).toHaveCount(0);
    expect(await page.locator("[data-role=user]").count()).toBeLessThan(20);
    await page.locator(".otk-timeline-list").hover();
    await page.mouse.wheel(0, -100000);
    await page.locator("[data-timeline-prompt=prompt-0] .otk-timeline-reveal")
      .click();
    await expect.poll(() =>
      page.evaluate(() => {
        const e = document.activeElement,
          v = document.querySelector(".otk-messages")!.getBoundingClientRect();
        if (
          e?.closest<HTMLElement>("[data-message]")?.dataset.message !==
            "prompt-0"
        ) return false;
        const r = e.getBoundingClientRect();
        return r.top >= v.top && r.bottom <= v.bottom + 1;
      })
    ).toBe(true);
    await page.context().grantPermissions([
      "clipboard-read",
      "clipboard-write",
    ]);
    await page.keyboard.press("Control+a");
    await expect(page.locator("[data-role=user]")).toHaveCount(105);
    await expect.poll(() => page.evaluate(() => getSelection()!.toString()))
      .toContain("Window prompt 104");
    await page.keyboard.press("Control+c");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    for (let i = 0; i < 105; i++) {
      expect(copied).toContain(`Window prompt ${i}`);
    }
    await page.evaluate(() => getSelection()!.removeAllRanges());
    await wheelTranscript(page, -100000);
    await expect(page.locator("[data-message=prompt-2] .otk-text p"))
      .toBeAttached();
    await page.evaluate(() => {
      const first = document.querySelector(
        "[data-message=prompt-0] .otk-text p",
      )!.firstChild!;
      const last = document.querySelector(
        "[data-message=prompt-2] .otk-text p",
      )!.firstChild!;
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(last, last.textContent!.length);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      (globalThis as typeof globalThis & { promptRange: Range }).promptRange =
        range;
    });
    await wheelTranscript(page, 100000);
    await expect.poll(() =>
      page.locator("[data-message=prompt-104]").evaluate((e) => {
        const r = e.getBoundingClientRect(),
          v = e.closest(".otk-messages")!.getBoundingClientRect();
        return r.top < v.bottom && r.bottom > v.top;
      })
    ).toBe(true);
    await page.keyboard.press("Control+c");
    const selected = await page.evaluate(() => navigator.clipboard.readText());
    for (const id of [0, 1, 2]) {
      expect(selected).toContain(`Window prompt ${id}`);
    }
    expect(
      await page.evaluate(() =>
        getSelection()!.getRangeAt(0) ===
          (globalThis as typeof globalThis & { promptRange: Range }).promptRange
      ),
    ).toBe(true);
    await wheelTranscript(page, -100000);
    await expect.poll(() => page.evaluate(() => getSelection()!.toString()))
      .toContain("Window prompt 1");
    await expect.poll(() =>
      page.locator("[data-message=prompt-0]").evaluate((e) =>
        e.getBoundingClientRect().bottom >
          e.closest(".otk-messages")!.getBoundingClientRect().top
      )
    ).toBe(true);
    await page.evaluate(() => getSelection()!.removeAllRanges());
  });
});

test.describe("prepend anchor", () => {
  test.use({ profile: "contract-messages-anchor" });
  test("messages.prepend-one-pixel-anchor", {
    tag: ["@messages", "@contracts"],
  }, async ({ isolatedState: state, page }) => {
    // Older reserve reads are intentionally held; transcript busy is expected.
    await state.product("layout.patch", {
      rightCollapsed: false,
      rightView: "sessions",
    });
    await page.goto(state.url + "/#/local/tstv1-otk");
    await expect(page.locator("textarea[name=prompt]")).toBeAttached();
    await page.locator("[data-panel-view=timeline]").click();
    await page.locator(
      '[data-timeline-prompt="anchor-95"] .otk-timeline-reveal',
    ).click();
    await expect.poll(() =>
      page.evaluate(() =>
        document.activeElement?.closest<HTMLElement>("[data-message]")?.dataset
          .message
      )
    ).toBe("anchor-95");
    await expect.poll(() =>
      state.observe<{ pending: number }>().then((x) => x.pending)
    ).toBeGreaterThan(0);
    await page.evaluate(() =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    );
    const measure = () =>
      page.locator("[data-message=anchor-95]").evaluate((e) => ({
        top: e.getBoundingClientRect().top -
          e.closest(".otk-messages")!.getBoundingClientRect().top,
        count: Number(
          e.closest(".otk-message-flow")!.getAttribute("data-message-count"),
        ),
      }));
    const before = await measure();
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "release",
    });
    await expect.poll(async () => {
      const next = await measure();
      return next.count > before.count && Math.abs(next.top - before.top) <= 1;
    }).toBe(true);
  });
});

test.describe("diff window", () => {
  test.use({ profile: "contract-messages-diff" });
  test("messages.diff-native-range-measured-anchor", {
    tag: ["@messages", "@contracts"],
  }, async ({ isolatedState: state, page }) => {
    await openSession(state, page, "tstv1-otk");
    await page.context().grantPermissions([
      "clipboard-read",
      "clipboard-write",
    ]);
    await page.locator(".otk-messages").hover();
    await page.mouse.wheel(0, -100);
    await page.locator(".otk-tool-toggle").click();
    await expect(page.locator(".otk-diff-text").first()).toHaveText(
      "source_line_0000 = 0;",
    );
    expect(await page.locator(".otk-diff-unified").count()).toBeLessThan(50);
    await page.evaluate(() => {
      const texts = Array.from(document.querySelectorAll(".otk-diff-text")),
        range = document.createRange();
      range.setStart(texts[0].firstChild!, 0);
      range.setEnd(texts[2].firstChild!, texts[2].textContent!.length);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      Object.assign(globalThis, {
        diffRange: range,
        diffSource: selection.toString(),
      });
    });
    await wheelTranscript(page, 900);
    await expect.poll(() =>
      page.evaluate(() => {
        const g = globalThis as typeof globalThis & {
          diffRange: Range;
          diffSource: string;
        };
        return getSelection()!.getRangeAt(0) === g.diffRange &&
          g.diffRange.startContainer.isConnected &&
          getSelection()!.toString() === g.diffSource;
      })
    ).toBe(true);
    await copySelection(
      page,
      Array.from(
        { length: 3 },
        (_, i) => `source_line_${String(i).padStart(4, "0")} = ${i};`,
      ).join("\n"),
    );
    await page.evaluate(() => {
      getSelection()!.removeAllRanges();
      (document.activeElement as HTMLElement)?.blur();
    });
    await expect.poll(() =>
      page.locator(".otk-diff-unified").evaluateAll((rows) => {
        const v = document.querySelector(".otk-messages")!
          .getBoundingClientRect();
        return rows.length > 0 && rows.every((e) => {
          const r = e.getBoundingClientRect();
          return r.bottom > v.top && r.top < v.bottom;
        });
      })
    ).toBe(true);
    const anchor = await page.locator(".otk-diff-unified").evaluateAll(
      (rows) => {
        const v = document.querySelector(".otk-messages")!
            .getBoundingClientRect(),
          r = rows.find((e) => e.getBoundingClientRect().bottom > v.top)!;
        return {
          line: r.getAttribute("data-new-line"),
          top: r.getBoundingClientRect().top - v.top,
        };
      },
    );
    await page.setViewportSize({ width: 800, height: 700 });
    for (const label of ["Collapse projects", "Collapse right panel"]) {
      if (
        await page.getByRole("button", { name: label, exact: true }).count()
      ) await page.getByRole("button", { name: label, exact: true }).click();
    }
    await expect.poll(() =>
      page.evaluate(({ line, top }) => {
        // Query and measure in one task: resize can recycle a row between a
        // locator's handle acquisition and its evaluate callback.
        const pane = document.querySelector(".otk-messages");
        const row = pane?.querySelector(
          `.otk-diff-unified[data-new-line="${line}"]`,
        );
        if (!pane || !row) return Infinity;
        return Math.abs(
          row.getBoundingClientRect().top -
            pane.getBoundingClientRect().top - top,
        );
      }, anchor)
    ).toBeLessThanOrEqual(1);
  });
});
