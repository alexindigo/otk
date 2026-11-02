// SPDX-License-Identifier: LGPL-3.0-only
import { assert } from "@std/assert";
import type { Cdp } from "./cdp.ts";
import { waitFor } from "./opencode.ts";
import type { MessageHeapSnapshot } from "./message-heap-analysis.ts";
export {
  messageHeapRetention,
  type MessageHeapSnapshot,
} from "./message-heap-analysis.ts";
export type { HeapPort } from "./heap-port.ts";
import type { HeapPort } from "./heap-port.ts";

/** Legacy target transport retained only for the still-active legacy heap suite. */
export async function workerHeapPort(
  browser: Cdp,
  targetId: string,
): Promise<HeapPort & { close(): Promise<void> }> {
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
        (event.params.targetInfo as { targetId: string }).targetId === targetId
      ),
    Boolean,
  );
  const sessionId = attached!.params.sessionId;
  assert(typeof sessionId === "string");
  await browser.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
  await browser.send("Runtime.enable", {}, sessionId);
  const events: HeapPort["events"] = [];
  let cursor = browser.events.length;
  return {
    events,
    async send(method, params = {}) {
      const result = await browser.send(method, params, sessionId);
      while (cursor < browser.events.length) {
        const event = browser.events[cursor++];
        if (event.sessionId !== sessionId) continue;
        events.push({ method: event.method, params: event.params });
        if (event.method === "HeapProfiler.addHeapSnapshotChunk") {
          event
            .params = {};
        }
      }
      return result;
    },
    async close() {
      await browser.send("Target.detachFromTarget", { sessionId });
    },
  };
}
export async function captureMessageHeap(
  port: HeapPort,
  path: string,
): Promise<MessageHeapSnapshot> {
  await port.send("HeapProfiler.enable");
  await port.send("HeapProfiler.collectGarbage");
  const start = port.events.length;
  await port.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  const captured = port.events.splice(start);
  const chunks = captured.filter((e) =>
    e.method === "HeapProfiler.addHeapSnapshotChunk"
  );
  port.events.push(
    ...captured.filter((e) => e.method !== "HeapProfiler.addHeapSnapshotChunk"),
  );
  const source = chunks.map((e) => e.params.chunk).join("");
  assert(source.length > 0, "No heap snapshot chunks received");
  await Deno.writeTextFile(path, source);
  return JSON.parse(source);
}
