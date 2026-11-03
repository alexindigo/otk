// SPDX-License-Identifier: LGPL-3.0-only
import { isolatedTest as test } from "../fixtures/isolated.ts";
import { expect } from "../fixtures/evidence.ts";
import { captureHeap, heapPort, workerHeapPort } from "../fixtures/heap.ts";
import { messageHeapRetention } from "../../support/message-heap-analysis.ts";
import { measureSessionHeap } from "../../support/heap.ts";

test.use({ profile: "contract-scale-heap" });
test(
  "scale.ten-body-cycles-independent-worker",
  { tag: ["@scale"] },
  async ({ isolatedState: state, page, context, browser }, info) => {
    test.setTimeout(1_200_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(state.url);
    await expect(page.locator(".heap-preview .otk-token").first()).toBeAttached(
      { timeout: 60_000 },
    );
    const population = await state.observe<
      {
        a: { id: string };
        counts: unknown;
        expectedCounts: unknown;
        payloadBytes: number;
      }
    >();
    expect(population.counts).toEqual(population.expectedCounts);
    const diagnostic = await browser.newBrowserCDPSession();
    const target = (await diagnostic.send("Target.getTargets")).targetInfos
      .find((t) => t.type === "worker");
    expect(target).toBeTruthy();
    const worker = await workerHeapPort(browser, target!.targetId),
      port = await heapPort(context, page);
    const observations: unknown[] = [];
    try {
      for (let cycle = 0; cycle < 10; cycle++) {
        await page.locator("#heap-open-a").click();
        await expect(page.locator("textarea[name=prompt]")).toBeVisible();
        await expect.poll(async () =>
          Number(await page.locator("#heap-state").getAttribute("data-a-count"))
        ).toBeGreaterThanOrEqual(20);
        if (cycle === 0) {
          await page.locator("textarea[name=prompt]").fill("Unsent heap draft");
          await page.locator("#heap-choice").click();
        } else {await expect(page.locator("textarea[name=prompt]")).toHaveValue(
            "Unsent heap draft",
          );}
        await page.locator("#heap-load-all").click();
        await expect(page.locator("#heap-state")).toHaveAttribute(
          "data-a-count",
          "1525",
          { timeout: 120_000 },
        );
        await expect(page.locator("#heap-state")).toHaveAttribute(
          "data-loading",
          "false",
        );
        await expect(page.locator(".heap-view .otk-token").first())
          .toBeAttached({ timeout: 60_000 });
        const loaded = messageHeapRetention(
          await captureHeap(
            port,
            info.outputPath(`page-loaded-${cycle}.heapsnapshot`),
          ),
          population.a.id,
          "Scale fixture 0/",
        );
        const workerLoaded = messageHeapRetention(
          await captureHeap(
            worker,
            info.outputPath(`worker-loaded-${cycle}.heapsnapshot`),
          ),
          population.a.id,
          "Scale fixture 0/",
        );
        expect(loaded.messageRecords).toBeGreaterThanOrEqual(1525);
        await page.locator("#heap-open-b").click();
        await expect(page.locator(".heap-preview .otk-token").first())
          .toBeAttached();
        await expect(page.locator("textarea[name=prompt]")).toBeVisible();
        await page.locator("#heap-cool").click();
        await expect.poll(() =>
          page.evaluate(
            `(()=>{const s=document.querySelector('#heap-state').dataset;return s.aCount==='0'&&s.aReplies==='0'&&s.aTemperature==='cold'&&s.aSubscribed==='false'&&s.aMetadata==='true'&&s.choice==='true'})()`,
          )
        ).toBe(true);
        await page.evaluate(
          "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
        );
        const released = messageHeapRetention(
          await captureHeap(
            port,
            info.outputPath(`page-cooled-${cycle}.heapsnapshot`),
          ),
          population.a.id,
          "Scale fixture 0/",
        );
        const workerReleased = messageHeapRetention(
          await captureHeap(
            worker,
            info.outputPath(`worker-cooled-${cycle}.heapsnapshot`),
          ),
          population.a.id,
          "Scale fixture 0/",
        );
        const paths = await measureSessionHeap(
          port,
          population.a.id,
          "Scale fixture 0/",
        );
        observations.push({
          cycle,
          loaded,
          workerLoaded,
          released,
          workerReleased,
          paths,
        });
        console.info(
          "Scale heap sample",
          JSON.stringify({
            cycle,
            loaded,
            released,
            workerLoaded,
            workerReleased,
            paths,
          }),
        );
        expect(
          (await diagnostic.send("Target.getTargets")).targetInfos.some((t) =>
            t.targetId === target!.targetId
          ),
        ).toBe(true);
        const { pages } = await state.observe<
          { pages: { before: boolean }[] }
        >();
        expect(pages.filter((p) => !p.before)).toHaveLength(cycle + 1);
      }
    } finally {
      await info.attach("population-control-measurements", {
        body: JSON.stringify({ population, observations }),
        contentType: "application/json",
      });
      await port.close();
      await worker.close();
      await diagnostic.detach();
    }
  },
);
