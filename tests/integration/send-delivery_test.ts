// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { MessagePage } from "@otk/protocol";
import { nativeFixture } from "../support/native-fixture.ts";
import { waitFor } from "../support/opencode.ts";
import { test } from "../support/resources.ts";
import { WsClient } from "../support/ws-client.ts";

test("@messages @composer accepted busy-session send correlates one prompt through auto-approved tool work and final prose", async () => {
  const f = await nativeFixture({ bash: "ask" });
  let ws: WsClient | undefined;
  try {
    const session = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Delivery contract" },
    });
    const app = await f.sidecar();
    ws = new WsClient(app.url);
    ws.lease({
      directory: f.oc.directory,
      selected: session.id,
      crumbs: [],
      rows: [],
    });
    await ws.connect();
    ws.send({ t: "subscribe", sessionID: session.id });
    await ws.rpc("session.messages", { sessionID: session.id });
    await ws.rpc("permission.auto", { sessionID: session.id, enabled: true });
    const held = f.fake.queueHeld({ chunks: ["First response stays active."] });
    await ws.rpc("session.prompt", {
      sessionID: session.id,
      mode: "normal",
      parts: [{ kind: "text", text: "First prompt" }],
    });
    await waitFor(() => f.fake.active, (n) => n > 0);
    f.fake.queue({
      tool: {
        name: "bash",
        input: {
          command: "printf 'delivery-permission'",
          description: "Delivery permission",
        },
      },
    }, { chunks: ["Final delivery prose."] });
    const receipt = await ws.rpc<{ messageID: string; state: string } | null>(
      "session.prompt",
      {
        sessionID: session.id,
        mode: "normal",
        parts: [{ kind: "text", text: "Queued correlated prompt" }],
      },
    );
    assert(
      receipt?.messageID,
      "Native acceptance must return its message identity",
    );
    assert(["accepted", "queued"].includes(receipt.state));
    held.release();
    const page = await waitFor(
      () => ws!.rpc<MessagePage>("session.messages", { sessionID: session.id }),
      (page) => JSON.stringify(page.items).includes("Final delivery prose."),
      60_000,
    );
    assertEquals(
      page.items.filter((m) => m.id === receipt.messageID).length,
      1,
    );
    const answers = page.items.filter((m) =>
      m.role === "assistant" && m.replyTo === receipt.messageID
    );
    assert(answers.length > 0, "The reply retains its causal prompt");
    assert(JSON.stringify(answers).includes("Final delivery prose."));
    await waitFor(
      () =>
        ws!.rpc<{ entries: { source: string; outcome: string }[] }>(
          "permission.activity",
          { sessionID: session.id },
        ),
      (activity) =>
        activity.entries.some((item) =>
          item.source === "auto" && item.outcome === "confirmed"
        ),
    );
  } finally {
    await ws?.close();
    await f.stop();
  }
});
