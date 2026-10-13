// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { browserFixture } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import type { HistoryEntry } from "@otk/protocol";
import { waitFor } from "../support/opencode.ts";
Deno.test("history RPC includes prompts across sessions and user shell entries directly from the live WAL database", async () => {
  const f = await browserFixture();
  let client: WsClient | undefined;
  try {
    const a = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "History A" },
      }),
      b = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "History B" },
      });
    await f.oc.request(`/session/${a.id}/message`, {
      method: "POST",
      body: {
        noReply: true,
        parts: [{ type: "text", text: "from another session" }],
      },
    });
    const server = await f.sidecar();
    client = new WsClient(server.url);
    await client.connect();
    await client.rpc("session.shell", {
      sessionID: b.id,
      command: "echo history-shell",
    });
    const entries = await waitFor(
      () => client!.rpc<HistoryEntry[]>("history.list", {}),
      (rows) =>
        rows.some((row) =>
          row.input === "echo history-shell" && row.mode === "shell"
        ),
    );
    assertEquals(entries.map((entry) => [entry.input, entry.mode]), [[
      "echo history-shell",
      "shell",
    ], ["from another session", "normal"]]);
    assertEquals(
      (await client.rpc<HistoryEntry[]>("history.list", {}))[0].input,
      "echo history-shell",
    );
  } finally {
    await client?.close();
    await f.stop();
  }
});
