// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { browserFixture } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import type { CommandOption } from "../../protocol/rpc.ts";
import type { Message } from "../../protocol/content.ts";
import { waitFor } from "../support/opencode.ts";
Deno.test("custom command RPC returns normalized catalog and records expanded multiline content", async () => {
  const f = await browserFixture(undefined, {
    async prepare(oc) {
      await Deno.mkdir(join(oc.directory, ".opencode/command"), {
        recursive: true,
      });
      await Deno.writeTextFile(
        join(oc.directory, ".opencode/command/probe.md"),
        "---\ndescription: RPC fixture command\n---\nRPC-COMMAND $ARGUMENTS",
      );
    },
  });
  let client: WsClient | undefined;
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Command RPC" },
      }),
      server = await f.sidecar();
    client = new WsClient(server.url);
    await client.connect();
    const command = (await client.rpc<CommandOption[]>("commands.list", {
      sessionID: session.id,
    })).find((command) => command.name === "probe")!;
    assertEquals(command.source, "server");
    assertEquals("template" in command, false);
    await client.rpc("session.command", {
      sessionID: session.id,
      command: "probe",
      arguments: "first\nsecond",
    });
    const messages = await waitFor(
      () =>
        client!.rpc<Message[]>("session.messages", {
          sessionID: session.id,
          limit: 100,
        }),
      (rows) => JSON.stringify(rows).includes("RPC-COMMAND first"),
    );
    assertEquals(JSON.stringify(messages).includes("RPC-COMMAND first"), true);
    assertEquals(JSON.stringify(messages).includes("second"), true);
    const raw = await f.oc.request<
      { parts: { type: string; text?: string }[] }[]
    >(`/session/${session.id}/message`);
    assertEquals(
      raw.some((message) =>
        message.parts.some((part) =>
          part.type === "text" &&
          part.text?.includes("RPC-COMMAND first\nsecond")
        )
      ),
      true,
    );
  } finally {
    await client?.close();
    await f.stop();
  }
});
