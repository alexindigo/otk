// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Cdp } from "../support/cdp.ts";
import {
  captureMessageHeap,
  messageHeapRetention,
  workerHeapPort,
} from "../support/message-heap.ts";
import { resources, tempDir, test } from "../support/resources.ts";

test("heap dominator probe detects and releases a 16MiB worker source without terminating that worker", async () => {
  const root = await tempDir("hp-");
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) =>
      new URL(request.url).pathname === "/worker.js"
        ? new Response(
          'let held; onmessage=({data})=>{if(data.kind==="retain")held=data.body;else held=undefined;postMessage("ready")}',
          { headers: { "content-type": "text/javascript" } },
        )
        : new Response(
          "<!doctype html><html><head></head><body>Heap worker probe</body></html>",
          { headers: { "content-type": "text/html" } },
        ),
  );
  resources().defer("heap worker-origin server", () => server.shutdown());
  const browser = await Cdp.launch(root);
  await browser.goto(`http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`);
  await browser.evaluate(`(()=>{
    globalThis.heapWorker=new Worker('/worker.js');
    globalThis.heapReady=0;heapWorker.onmessage=()=>heapReady++;
    let source='OTK_HEAP_CANARY_'+Array.from({length:1024*1024},(_,i)=>i.toString(36).padStart(5,'0')+'|').join('');
    while(source.length<16*1024*1024)source+=source;
    heapWorker.postMessage({kind:'retain',body:{sessionID:'heap-canary',parts:[{text:source}]}});
  })()`);
  await browser.poll("heapReady===1");
  const { targetInfos } = await browser.send("Target.getTargets");
  const target = (targetInfos as { type: string; targetId: string }[]).find((
    t,
  ) => t.type === "worker")!;
  assert(target);
  const worker = await workerHeapPort(browser, target.targetId);
  resources().defer("canary heap attachment", () => worker.close());
  const loaded = messageHeapRetention(
    await captureMessageHeap(worker, join(root, "loaded.heapsnapshot")),
    "heap-canary",
    "OTK_HEAP_CANARY_",
  );
  assert(loaded.retainedBytes >= 16 * 1024 * 1024, JSON.stringify(loaded));
  assert(loaded.messageRecords > 0);
  await browser.evaluate("heapWorker.postMessage({kind:'release'})");
  await browser.poll("heapReady===2");
  const released = messageHeapRetention(
    await captureMessageHeap(worker, join(root, "released.heapsnapshot")),
    "heap-canary",
    "OTK_HEAP_CANARY_",
  );
  assertEquals(released.retainedBytes, 0);
  assertEquals(released.messageRecords, 0);
  const after = await browser.send("Target.getTargets");
  assert(
    (after.targetInfos as { targetId: string }[]).some((t) =>
      t.targetId === target.targetId
    ),
  );
  await Deno.writeTextFile(
    join(root, "dominator-proof.json"),
    JSON.stringify({ loaded, released }, null, 2),
  );
});
