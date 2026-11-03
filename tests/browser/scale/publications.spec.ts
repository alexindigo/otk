// SPDX-License-Identifier: LGPL-3.0-only
import { isolatedTest as test } from "../fixtures/isolated.ts";
import { expect } from "../fixtures/evidence.ts";
import type { Page } from "@playwright/test";

test.use({ profile: "contract-scale-core" });
test(
  "scale.one-four-sixteen-paused-consumers",
  { tag: ["@scale"] },
  async ({ isolatedState: state, browser }, info) => {
    test.setTimeout(180_000);
    const pages: Page[] = [], errors: string[] = [];
    const observations: unknown[] = [];
    for (const count of [1, 4, 16]) {
      while (pages.length < count) {
        const context = await state.newContext(browser),
          page = await context.newPage();
        context.on("weberror", (event) => errors.push(String(event.error())));
        await page.addInitScript(
          `globalThis.paFrames=[];globalThis.WebSocket=class extends WebSocket{constructor(...args){super(...args);this.addEventListener('message',e=>{const f=JSON.parse(e.data);if(f.t==='harness')paFrames.push(f.state)})}}`,
        );
        await page.goto(state.url);
        pages.push(page);
      }
      for (const page of pages) {
        await expect(page.locator(".otk-connection-light")).toHaveAttribute(
          "data-connection-state",
          "connected",
        );
        await page.evaluate("paFrames=[]");
      }
      const page = pages.at(-1)!,
        cdp = await page.context().newCDPSession(page);
      try {
        await cdp.send("Debugger.enable");
        const paused = new Promise<void>((resolve) =>
          cdp.once("Debugger.paused", () => resolve())
        );
        await cdp.send("Debugger.pause");
        const entered = cdp.send("Runtime.evaluate", { expression: "void 0" });
        await paused;
        const publication = await state.controller.call<
          { synchronousMs: number; sections: { name: string; ms: number }[] }
        >("scenario", { lease: state.lease.lease, action: "hold" });
        expect(
          publication.sections.filter((s) => s.name === "serialize:harness"),
        ).toHaveLength(40);
        await cdp.send("Debugger.resume");
        await entered;
        await cdp.send("Debugger.disable");
        const received: number[] = [];
        for (const page of pages) {
          await expect.poll(() => page.evaluate<number>("paFrames.length"))
            .toBe(40);
          const states = await page.evaluate<string[]>("paFrames");
          expect(states).toEqual(
            Array.from(
              { length: 40 },
              (_, n) => n % 2 ? "connected" : "reconnecting",
            ),
          );
          received.push(states.length);
        }
        observations.push({
          browsers: count,
          publications: 40,
          serializations: publication.sections.length,
          synchronousMs: publication.synchronousMs,
          sections: publication.sections,
          pausedReaderPublications: 40,
          received,
          heap: await cdp.send("Runtime.getHeapUsage"),
        });
      } finally {
        await cdp.detach();
      }
    }
    expect(errors).toEqual([]);
    await info.attach("population-control-measurements", {
      body: JSON.stringify({ observations }),
      contentType: "application/json",
    });
  },
);

test(
  "scale.warm-assets-listener-lifetimes",
  { tag: ["@scale"] },
  async ({ isolatedState: state, page, context }, info) => {
    await page.goto(`${state.url}/#/local/tstv1-core`);
    await expect(page.locator(".otk-text")).toHaveText("Core transcript");
    const cdp = await context.newCDPSession(page),
      transfers: string[] = [],
      cycles: unknown[] = [];
    try {
      await cdp.send("HeapProfiler.collectGarbage");
      const baseline = await cdp.send("Memory.getDOMCounters");
      page.on("request", (request) => {
        if (/\.(?:js|css|woff2?)(?:\?|$)/.test(request.url())) {
          transfers.push(request.url());
        }
      });
      for (let n = 0; n < 10; n++) {
        // Hash navigation keeps the original document, asset cache and listener owner.
        await page.goto(`${state.url}/#/local/missing-${n}`);
        await expect(page).toHaveURL(new RegExp(`/missing-${n}$`));
        await expect(page.locator(".otk-text")).toHaveCount(0);
        await page.goto(`${state.url}/#/local/tstv1-core`);
        await expect(page.locator(".otk-text")).toHaveText("Core transcript");
        await cdp.send("HeapProfiler.collectGarbage");
        cycles.push(await cdp.send("Memory.getDOMCounters"));
      }
      expect(transfers).toEqual([]);
      const entries = await page.evaluate(
        "performance.getEntriesByType('resource').map(e=>({name:e.name,transferSize:e.transferSize,encodedBodySize:e.encodedBodySize,duration:e.duration,initiatorType:e.initiatorType}))",
      );
      await info.attach("population-control-measurements", {
        body: JSON.stringify({
          baseline,
          cycles,
          repeatedAssetRequests: transfers,
          entries,
          after: await cdp.send("Memory.getDOMCounters"),
          heap: await cdp.send("Runtime.getHeapUsage"),
        }),
        contentType: "application/json",
      });
    } finally {
      await cdp.detach();
    }
  },
);
