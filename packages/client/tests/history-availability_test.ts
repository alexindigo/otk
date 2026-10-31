// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { loadHistory } from "../history.ts";
import type { SidecarConnection } from "../connection.ts";
import type { HistoryEntry } from "@otk/protocol";

const connection = (read: () => Promise<HistoryEntry[]>) =>
  ({ rpc: { call: read } }) as unknown as SidecarConnection;

Deno.test("recall preserves partial source ownership but reports an entirely unavailable provider set", async () => {
  const unavailable = new Error("Provider history unavailable");
  const failed = {
    id: "missing",
    connection: connection(() => Promise.reject(unavailable)),
  };
  await assertRejects(() => loadHistory([failed]), Error, unavailable.message);
  assertEquals(await loadHistory([]), []);
  assertEquals(
    await loadHistory([failed, {
      id: "empty",
      connection: connection(() => Promise.resolve([])),
    }]),
    [],
  );
  const part = {
    kind: "file",
    source: "history",
    name: "image.png",
    mime: "image/png",
    size: 3,
    messageID: "m",
    partID: "p",
  } as const;
  const entry: HistoryEntry = {
    input: "source prompt",
    mode: "normal",
    time: 1,
    parts: [part],
  };
  const rows = await loadHistory([failed, {
    id: "origin",
    connection: connection(() => Promise.resolve([entry])),
  }]);
  assertEquals(rows[0].parts[0], { ...part, sidecarID: "origin" });
  assertEquals(entry.parts[0], part);
});
