// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { Message } from "@otk/protocol";
import { browserFixture } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { waitFor } from "../support/opencode.ts";
Deno.test("shell RPC honors configured primary agent and bypasses model bash permission", async () => {
  const f = await browserFixture({ bash: "deny" }, {
    config: { default_agent: "plan" },
  });
  let client: WsClient | undefined;
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Shell RPC" },
      }),
      server = await f.sidecar();
    client = new WsClient(server.url);
    await client.connect();
    await client.rpc("session.shell", {
      sessionID: session.id,
      command: "echo otk",
    });
    const messages = await waitFor(
      () =>
        client!.rpc<Message[]>("session.messages", {
          sessionID: session.id,
          limit: 100,
        }),
      (rows) =>
        rows.some((message) =>
          message.role === "assistant" &&
          message.parts.some((part) =>
            part.kind === "tool" && part.call.tool === "bash" &&
            part.call.status === "completed"
          )
        ),
    );
    const assistant = messages.find((m) => m.role === "assistant")!;
    assertEquals(assistant.agent, "plan");
    const part = assistant.parts.find((p) => p.kind === "tool");
    if (part?.kind !== "tool" || part.call.tool !== "bash") {
      throw new Error("Missing bash tool");
    }
    assertEquals(part.call.output.trim(), "otk");
    assertEquals(part.call.status, "completed");
    assertEquals(
      await client.rpc("permission.list", { sessionID: session.id }),
      [],
    );
    assertEquals(f.fake.requests.length, 0);
  } finally {
    await client?.close();
    await f.stop();
  }
});
