// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
test.use({ profile: "contract-messages-usage-paging" });
test("messages.complete-usage-pages-duplicates-held-reload", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page }) => {
  interface Observation {
    calls: { before?: string }[];
    pendingPages: number;
    held: boolean;
    total: number;
  }
  const control = (action: "release" | "succeed" | "hold") =>
    state.controller.call("scenario", { lease: state.lease.lease, action });
  let hydrationEnd = 0;
  const hydration = async (expectedSummary: string) => {
    await expect.poll(async () => {
      const observation = await state.observe<Observation>();
      if (observation.pendingPages) {
        await control("release");
        return false;
      }
      return await page.evaluate(async (expectedSummary) => {
        // The legacy settledTranscriptCount joined document.fonts.ready and
        // its caller joined the actual usage summary before sampling geometry.
        // Without those fences a fallback-font range can look stable, then
        // admit another real page after the read inventory was captured.
        await document.fonts.ready;
        const pane = document.querySelector(".otk-messages"),
          flow = document.querySelector<HTMLElement>(".otk-message-flow");
        if (
          !pane || !flow || Number(flow.dataset.messageCount) < 20 ||
          !flow.querySelector(".otk-load-older") ||
          Array.from(document.querySelectorAll(".otk-turn-usage > button")).at(
              -1,
            )?.textContent !== expectedSummary
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
      }, expectedSummary);
    }).toBe(true);
    const observation = await state.observe<Observation>(),
      acquired = Number(
        await page.locator(".otk-message-flow").getAttribute(
          "data-message-count",
        ),
      );
    expect(observation.pendingPages).toBe(0);
    expect(acquired).toBeLessThan(observation.total);
    expect(observation.calls.slice(hydrationEnd)).toEqual(
      Array.from(
        { length: Math.ceil(acquired / 10) },
        (_, i) => i ? { before: `fixture:${observation.total - i * 10}` } : {},
      ),
    );
    hydrationEnd = observation.calls.length;
    return hydrationEnd;
  };
  const last = page.locator(".otk-turn-usage > button").last(),
    cost = page.locator(".otk-context-meter");
  const hoverUsage = async () => {
    // The legacy usagePoint explicitly centered the footer in the transcript.
    // Merely hovering an already-visible footer preserves a different scroll
    // anchor, which can admit another historical page during the next reload.
    await last.evaluate((button) =>
      button.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "instant",
      })
    );
    await last.hover();
  };
  const summary = async (text: string, total: number) => {
    await expect(last).toHaveText(text);
    await expect.poll(() => cost.getAttribute("data-cost").then(Number))
      .toBeCloseTo(total, 6);
  };
  await page.goto(state.url + "/#/local/tstv1-core");
  await hydration("102 model calls · 102 tokens · $1.02");
  await summary("102 model calls · 102 tokens · $1.02", 1.02);
  await page.reload();
  const detailBodyReads = await hydration(
    "102 model calls · 102 tokens · $1.02",
  );
  await expect(last).toHaveText("102 model calls · 102 tokens · $1.02");
  await hoverUsage();
  const rows = page.locator(".otk-usage-breakdown tbody tr");
  await expect(rows).toHaveCount(102);
  await expect(page.locator(".otk-usage-breakdown tfoot tr")).toHaveCount(1);
  expect(
    await rows.evaluateAll((rows) =>
      rows.reduce((sum, row) => sum + Number(row.children[2].textContent), 0)
    ),
  ).toBe(102);
  const foot = page.locator(".otk-usage-breakdown tfoot tr");
  expect(
    await foot.evaluate((row) => row.children[1].firstChild!.textContent),
  )
    .toBe("102");
  expect(
    await rows.evaluateAll((rows) =>
      rows.every((row) =>
        Number(row.children[2].textContent) ===
          Number(row.children[3].textContent) +
            Number(row.children[6].textContent) +
            Number(row.children[7].textContent)
      )
    ),
  ).toBe(true);
  expect(
    await foot.evaluate((row) => row.children[2].firstChild!.textContent),
  )
    .toBe("102");
  expect(
    await rows.evaluateAll((rows) =>
      rows.reduce(
        (sum, row) =>
          sum + Number(row.children[8].textContent!.replace("$", "")),
        0,
      ).toFixed(
        2,
      )
    ),
  ).toBe("1.02");
  expect(await foot.evaluate((row) => row.children[7].textContent)).toBe(
    "$1.02",
  );
  await expect(page.locator(".otk-turn-time")).toHaveText("102.0s");
  await page.locator(".otk-usage-scroll").hover();
  await page.mouse.wheel(0, 5000);
  await expect.poll(() =>
    page.locator(".otk-usage-scroll").evaluate((body) => {
      const foot = body.querySelector("tfoot")!.getBoundingClientRect(),
        bounds = body.getBoundingClientRect();
      return body.scrollTop > 0 && foot.top >= bounds.top &&
        foot.bottom <= bounds.bottom;
    })
  ).toBe(true);
  await page.mouse.move(1, 1);
  expect((await state.observe<Observation>()).calls.length).toBe(
    detailBodyReads,
  );
  await control("succeed");
  await summary("1 model call · 2 tokens · $0.02", 1.04);
  await control("succeed");
  await summary("1 model call · 5 tokens · $0.05", 1.07);
  await control("hold");
  expect((await state.observe<Observation>()).calls.length).toBe(
    detailBodyReads,
  );
  await page.reload();
  const heldBodyReads = await hydration("1 model call · 5 tokens · $0.05");
  await expect(last).toHaveText("1 model call · 5 tokens · $0.05");
  await hoverUsage();
  await expect.poll(() => state.observe<Observation>().then((o) => o.held))
    .toBe(true);
  await control("succeed");
  await summary("1 model call · 7 tokens · $0.07", 1.09);
  await control("succeed");
  await summary("1 model call · 9 tokens · $0.09", 1.11);
  expect((await state.observe<Observation>()).calls.length).toBe(
    heldBodyReads,
  );
  await page.reload();
  await hydration("1 model call · 9 tokens · $0.09");
  await summary("1 model call · 9 tokens · $0.09", 1.11);
});
