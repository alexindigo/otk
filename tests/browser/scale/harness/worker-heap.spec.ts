// SPDX-License-Identifier: LGPL-3.0-only
import { createServer } from "node:http";
import { expect, test } from "../../fixtures/evidence.ts";
import { captureHeap, workerHeapPort } from "../../fixtures/heap.ts";
import { messageHeapRetention } from "../../../support/message-heap-analysis.ts";

test(
  "harness.worker-source-retention",
  { tag: ["@harness", "@scale"] },
  async ({ page, browser }, info) => {
    const server = createServer((request, response) => {
      if (request.url === "/worker.js") {
        response.setHeader("content-type", "text/javascript");
        response.end(
          'let held; onmessage=({data})=>{if(data.kind==="retain")held=data.body;else if(data.kind==="release")held=undefined;postMessage("ready")}',
        );
      } else {
        response.setHeader("content-type", "text/html");
        response.end("<!doctype html><body>Heap worker probe</body>");
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    try {
      const address = server.address() as { port: number };
      await page.goto(`http://127.0.0.1:${address.port}`);
      await page.evaluate(`(()=>{
      globalThis.heapWorker=new Worker('/worker.js');globalThis.heapReady=0;heapWorker.onmessage=()=>heapReady++;
      let source='OTK_HEAP_CANARY_'+Array.from({length:1024*1024},(_,i)=>i.toString(36).padStart(5,'0')+'|').join('');
      while(source.length<16*1024*1024)source+=source;
      heapWorker.postMessage({kind:'retain',body:{sessionID:'heap-canary',parts:[{text:source}]}});
    })()`);
      await expect.poll(() => page.evaluate("heapReady")).toBe(1);
      const diagnostic = await browser.newBrowserCDPSession();
      try {
        const target = (await diagnostic.send("Target.getTargets")).targetInfos
          .find((target) =>
            target.type === "worker" &&
            target.url === `http://127.0.0.1:${address.port}/worker.js`
          )!;
        expect(target).toBeTruthy();
        const port = await workerHeapPort(browser, target.targetId);
        try {
          const loaded = messageHeapRetention(
            await captureHeap(port, info.outputPath("loaded.heapsnapshot")),
            "heap-canary",
            "OTK_HEAP_CANARY_",
          );
          expect(loaded.retainedBytes).toBeGreaterThanOrEqual(16 * 1024 * 1024);
          expect(loaded.messageRecords).toBeGreaterThan(0);
          await page.evaluate("heapWorker.postMessage({kind:'release'})");
          await expect.poll(() => page.evaluate("heapReady")).toBe(2);
          const released = messageHeapRetention(
            await captureHeap(port, info.outputPath("released.heapsnapshot")),
            "heap-canary",
            "OTK_HEAP_CANARY_",
          );
          expect(released.retainedBytes).toBe(0);
          expect(released.messageRecords).toBe(0);
          expect(
            (await diagnostic.send("Target.getTargets")).targetInfos.some(
              (item) => item.targetId === target.targetId,
            ),
          ).toBe(true);
          await page.evaluate("heapWorker.postMessage({kind:'ping'})");
          await expect.poll(() => page.evaluate("heapReady")).toBe(3);
          await info.attach("dominator-proof", {
            body: JSON.stringify({ loaded, released }),
            contentType: "application/json",
          });
        } finally {
          await port.close();
        }
      } finally {
        await diagnostic.detach();
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
    }
  },
);
