// SPDX-License-Identifier: LGPL-3.0-only
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Page,
} from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { HeapPort } from "../../support/heap-port.ts";
import type { MessageHeapSnapshot } from "../../support/message-heap-analysis.ts";

/** Only diagnostic protocol traffic crosses this port, never input or readiness. */
export async function heapPort(context: BrowserContext, page: Page) {
  const session = await context.newCDPSession(page);
  const events: HeapPort["events"] = [];
  session.on(
    "HeapProfiler.addHeapSnapshotChunk",
    (params) =>
      events.push({ method: "HeapProfiler.addHeapSnapshotChunk", params }),
  );
  return {
    events,
    send: (method: string, params = {}) =>
      session.send(
        method as Parameters<CDPSession["send"]>[0],
        params,
      ) as Promise<Record<string, unknown>>,
    close: () => session.detach(),
  };
}

export async function captureHeap(port: HeapPort, path: string) {
  await port.send("HeapProfiler.enable");
  await port.send("HeapProfiler.collectGarbage");
  const start = port.events.length;
  await port.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  const chunks = port.events.splice(start).filter((event) =>
    event.method === "HeapProfiler.addHeapSnapshotChunk"
  );
  const source = chunks.map((event) => event.params.chunk).join("");
  if (!source.length) throw new Error("No heap snapshot chunks received");
  await writeFile(path, source);
  return JSON.parse(source) as MessageHeapSnapshot;
}

/** Worker diagnostic sub-session, routed by the public Playwright CDPSession. */
export async function workerHeapPort(browser: Browser, targetId: string) {
  const session = await browser.newBrowserCDPSession();
  const { sessionId } = await session.send("Target.attachToTarget", {
    targetId,
    flatten: false,
  });
  const events: HeapPort["events"] = [];
  let next = 0;
  const pending = new Map<
    number,
    {
      resolve(value: Record<string, unknown>): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  session.on("Target.receivedMessageFromTarget", (event) => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    if (message.id) {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.reject(new Error(JSON.stringify(message.error)));
      else call.resolve(message.result ?? {});
    } else if (message.method === "HeapProfiler.addHeapSnapshotChunk") {
      events.push({ method: message.method, params: message.params });
    }
  });
  return {
    events,
    async send(method: string, params = {}) {
      const id = ++next;
      const result = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Worker diagnostic timeout: ${method}`));
        }, 60000);
        pending.set(id, { resolve, reject, timer });
      });
      try {
        await session.send("Target.sendMessageToTarget", {
          sessionId,
          message: JSON.stringify({ id, method, params }),
        });
      } catch (error) {
        const call = pending.get(id)!;
        pending.delete(id);
        clearTimeout(call.timer);
        call.reject(error as Error);
      }
      return result;
    },
    async close() {
      try {
        await session.send("Target.detachFromTarget", { sessionId });
      } finally {
        for (const call of pending.values()) {
          clearTimeout(call.timer);
          call.reject(new Error("Worker diagnostic closed"));
        }
        pending.clear();
        await session.detach();
      }
    },
  };
}
