// SPDX-License-Identifier: LGPL-3.0-only
import { readRpcMessages } from "../support/message-pages.ts";
import { v1NativeTests } from "../support/native-contract.ts";
const test = v1NativeTests(
  "V1 command configuration and expanded user parts wire shape",
  [
    "tests/integration/v2-session-actions_test.ts#OC2A4",
    "tests/integration/v2-session-actions_test.ts#OC2A5",
  ],
);
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { nativeFixture } from "../support/native-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { ascendingID, type CommandOption } from "@otk/protocol";
import { waitFor } from "../support/opencode.ts";
test("custom command RPC returns normalized catalog and records expanded multiline content", async () => {
  const f = await nativeFixture(undefined, {
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
    const session = await f.oc.session<{ id: string }>("/session", {
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
    const messageID = ascendingID("msg");
    const receipt = await client.rpc("session.command", {
      sessionID: session.id,
      messageID,
      command: "probe",
      arguments: "first\nsecond",
    });
    assertEquals(receipt, { messageID, state: "accepted" });
    const messages = await waitFor(
      () => readRpcMessages(client!, session.id),
      (rows) => JSON.stringify(rows).includes("RPC-COMMAND first"),
    );
    assertEquals(JSON.stringify(messages).includes("RPC-COMMAND first"), true);
    assertEquals(JSON.stringify(messages).includes("second"), true);
    assertEquals(messages.some((m) => m.id === messageID), true);
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

test("skill RPC retains its caller-captured native identity", async () => {
  const f = await nativeFixture(undefined, {
    async prepare(oc) {
      const path = join(oc.directory, ".opencode/skills/receipt-skill");
      await Deno.mkdir(path, { recursive: true });
      await Deno.writeTextFile(
        join(path, "SKILL.md"),
        "---\nname: receipt-skill\ndescription: Receipt skill\n---\nRECEIPT-SKILL context",
      );
    },
  });
  let client: WsClient | undefined;
  try {
    const session = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Skill identity" },
    });
    const server = await f.sidecar();
    client = new WsClient(server.url);
    await client.connect();
    const messageID = ascendingID("msg");
    const receipt = await client.rpc("session.command", {
      sessionID: session.id,
      messageID,
      command: "receipt-skill",
      skill: { name: "receipt-skill" },
      arguments: "",
    });
    assertEquals(receipt, { messageID, state: "accepted" });
    const messages = await waitFor(
      () => readRpcMessages(client!, session.id),
      (rows) => rows.some((row) => row.id === messageID),
    );
    assertEquals(messages.filter((row) => row.id === messageID).length, 1);
  } finally {
    await client?.close();
    await f.stop();
  }
});
