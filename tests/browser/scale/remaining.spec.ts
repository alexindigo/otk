// SPDX-License-Identifier: LGPL-3.0-only
import { isolatedTest as test } from "../fixtures/isolated.ts";
import { expect } from "../fixtures/evidence.ts";

test.use({ profile: "contract-scale-remaining" });
test(
  "scale.thousand-project-visits",
  { tag: ["@scale"] },
  async ({ isolatedState: state, page, context }, info) => {
    await page.goto(state.url);
    await expect.poll(() =>
      page.evaluate("globalThis.remainingOwner?.facts.length")
    ).toBe(100);
    const facts = await page.evaluate<
      {
        currentTitle: string;
        currentInbox: boolean;
        sourceFree: boolean;
        entries: number;
        selected: string;
      }[]
    >("remainingOwner.facts");
    for (const [n, fact] of facts.entries()) {
      expect(fact.currentTitle).toBe(`After ${n}`);
      expect(fact.selected).toBe(`tstv1-${n}`);
      expect(fact.currentInbox && fact.sourceFree).toBe(true);
      expect(fact.entries).toBeLessThan(50);
    }
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send("HeapProfiler.collectGarbage");
      await info.attach("population-control-measurements", {
        body: JSON.stringify({
          projects: 100,
          visits: 1000,
          population: 4615,
          facts,
          retainedOldSeen: await page.evaluate(
            "remainingOwner.retainedOldSeen()",
          ),
          heap: await cdp.send("Runtime.getHeapUsage"),
        }),
        contentType: "application/json",
      });
    } finally {
      await cdp.detach();
    }
    await page.evaluate("remainingOwner.stop()");
  },
);

test(
  "scale.thousand-closed-source-updates",
  { tag: ["@scale"] },
  async ({ isolatedState: state, page, context }, info) => {
    await page.goto(state.url + "/?source");
    await expect(page.locator('[data-message-command="reply.copy"]'))
      .toBeAttached();
    await expect(page.locator(".otk-work-fold")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(page.locator(".otk-work-fold")).toHaveText("Work log");
    await expect(page.locator(".otk-work-body")).toHaveCount(0);
    await page.evaluate("sourceProbe.reset()");
    const start = performance.now();
    await page.evaluate("sourceProbe.run()");
    const ms = performance.now() - start;
    const facts = () =>
      page.evaluate<
        {
          reads: number;
          stringifiedBytes: number;
          bodies: number;
          commands: number;
        }
      >("sourceProbe.facts()");
    const before = await facts();
    expect(before.reads).toBe(0);
    expect(before.stringifiedBytes).toBe(0);
    expect(before.bodies).toBe(0);
    await expect(page.locator(".otk-work-body,[data-source-body]")).toHaveCount(
      0,
    );
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: state.url,
    });
    await page.locator('[data-message-command="reply.copy"]').click();
    await expect.poll(() =>
      page.evaluate(
        "navigator.clipboard.readText().then(value=>value===sourceProbe.expected())",
      )
    ).toBe(true);
    const after = await facts();
    expect(after.reads).toBe(1);
    expect(after.stringifiedBytes).toBeGreaterThan(50000);
    expect(after.bodies).toBe(0);
    expect(after.commands).toBe(before.commands);
    expect(before.commands).toBeGreaterThan(0);
    const cycles: number[] = [];
    for (let n = 0; n < 10; n++) {
      await page.evaluate("sourceProbe.mount(false)");
      await expect.poll(async () => (await facts()).commands).toBe(0);
      await expect(page.locator(".otk-message")).toHaveCount(0);
      cycles.push((await facts()).commands);
      await page.evaluate("sourceProbe.mount(true)");
      await expect.poll(async () => (await facts()).commands).toBe(
        before.commands,
      );
      await expect(page.locator(".otk-message")).toBeAttached();
      cycles.push((await facts()).commands);
    }
    await info.attach("population-control-measurements", {
      body: JSON.stringify({
        updates: 1000,
        before,
        after,
        exactClipboard: true,
        commandCycles: cycles,
        ms,
      }),
      contentType: "application/json",
    });
  },
);
