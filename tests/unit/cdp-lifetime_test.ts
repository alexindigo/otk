// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { Cdp } from "../support/cdp.ts";
import { resources, test } from "../support/resources.ts";
import { waitFor } from "../support/opencode.ts";

test("CDP flat-session commands address a real worker independently of the page", async () => {
  const root = await resources().tempDir("cdp-");
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) =>
      new URL(request.url).pathname === "/worker.js"
        ? new Response(
          "globalThis.workerProbe=42;onmessage=()=>{};postMessage(1)",
          { headers: { "content-type": "text/javascript" } },
        )
        : new Response(
          "<!doctype html><html><head></head><body>CDP worker probe</body></html>",
          { headers: { "content-type": "text/html" } },
        ),
  );
  resources().defer("CDP worker-origin server", () => server.shutdown());
  const browser = await Cdp.launch(root);
  await browser.goto(`http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`);
  await browser.evaluate(
    "globalThis.workerProbe=7; globalThis.workerReady=false; globalThis.worker=new Worker('/worker.js');worker.onmessage=()=>workerReady=true",
  );
  await browser.poll("workerReady");
  const { targetInfos } = await browser.send("Target.getTargets");
  const target = (targetInfos as { type: string; targetId: string }[]).find((
    t,
  ) => t.type === "worker")!;
  await browser.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
    filter: [{ type: "worker" }, { exclude: true }],
  });
  const attached = await waitFor(
    () =>
      browser.events.find((event) =>
        event.method === "Target.attachedToTarget" &&
        (event.params.targetInfo as { targetId: string }).targetId ===
          target.targetId
      ),
    Boolean,
  );
  const sessionId = attached!.params.sessionId;
  assert(typeof sessionId === "string");
  await browser.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
  await browser.send("Runtime.enable", {}, sessionId);
  const response = await browser.send("Runtime.evaluate", {
    expression: "workerProbe",
    returnByValue: true,
  }, sessionId);
  assertEquals((response.result as { value: number }).value, 42);
  assertEquals(await browser.evaluate("workerProbe"), 7);
  await browser.send("Target.detachFromTarget", { sessionId });
});

test("CDP send failure releases its pending timer and transport closure rejects owned commands", async () => {
  const root = await resources().tempDir("cdp-"),
    browser = await Cdp.launch(root);
  const original = WebSocket.prototype.send;
  try {
    WebSocket.prototype.send = () => {
      throw new Error("controlled send failure");
    };
    await assertRejects(
      () => browser.send("Runtime.enable"),
      Error,
      "controlled send failure",
    );
  } finally {
    WebSocket.prototype.send = original;
  }
  assertEquals(await browser.evaluate("6 * 7"), 42);
  const pending = browser.send("Runtime.evaluate", {
    expression: "new Promise(() => {})",
    awaitPromise: true,
  });
  const rejected = assertRejects(() => pending, Error, "CDP closed");
  await browser.close();
  await rejected;
});
