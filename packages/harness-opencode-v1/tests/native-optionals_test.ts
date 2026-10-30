// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { agentColors, agents } from "../agents.ts";
import { Client } from "../client.ts";
import { usageHeader, UsageLedger } from "@otk/protocol";
import { sessionDirectory } from "../directory.ts";
import {
  mapIndex,
  mapMessage,
  mapPart,
  mapPermission,
  mapSession,
} from "../map.ts";

const settings = {
  url: "http://native.invalid",
  username: "opencode",
  password: "",
  db: "",
  heartbeattimeout: 25,
  reconnectmax: 30,
  requestms: 60000,
};

Deno.test("live reported usage keeps missing and invalid categories unknown before actual zero and nonzero replacements", () => {
  const ledger = new UsageLedger("opcv1-session");
  for (const value of [undefined, null, -1, 0, 7]) {
    const message = mapMessage(
      JSON.parse(
        JSON.stringify({
          id: "call",
          sessionID: "session",
          role: "assistant",
          parentID: "turn",
          agent: "build",
          providerID: "test",
          modelID: "test",
          time: { created: 1, completed: 2 },
          cost: value,
          tokens: {
            input: value,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        }),
      ),
    );
    assert(message.role === "assistant");
    const expected = typeof value === "number" && value >= 0 ? value : null;
    assertEquals(message.cost, expected);
    assertEquals(message.tokens.input, expected);
    ledger.upsert(usageHeader(message));
    assertEquals(ledger.summary("turn")?.cost, expected);
    assertEquals(ledger.summary("turn")?.tokens.input, expected);
  }
});

Deno.test("native null agent metadata becomes absent for primary and mention consumers", async () => {
  const raw = [
    {
      name: "unset",
      mode: "all",
      description: null,
      color: null,
      model: null,
      variant: null,
    },
    { name: "missing", mode: "all" },
    {
      name: "chosen",
      mode: "all",
      description: "Keep spelling",
      color: "#abcDEF",
      model: { providerID: "Provider/ID", modelID: "Model/ID" },
      variant: "mixed_CASE",
    },
    { name: "empty", mode: "all", description: "", variant: "" },
  ];
  const client = new Client(
    settings,
    () => Promise.resolve(Response.json(raw)),
  );
  const directory = sessionDirectory(() => "/project", () => {
    throw new Error("Cached directory should be used");
  });
  const capability = agents(client, directory);
  for (const primary of [true, false]) {
    const options = await capability.listAgents("opcv1-session", primary);
    for (const item of options.slice(0, 2)) {
      assertEquals([item.description, item.color, item.model, item.variant], [
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      assertEquals(Object.keys(JSON.parse(JSON.stringify(item))), ["name"]);
    }
    assertEquals(options[2], {
      name: "chosen",
      description: "Keep spelling",
      color: "#abcDEF",
      model: { provider: "Provider/ID", model: "Model/ID" },
      variant: "mixed_CASE",
    });
    assertEquals(options[3].description, "");
    assertEquals(options[3].variant, "");
  }
  assertEquals([...await agentColors(client, "/project")], [[
    "chosen",
    "#abcDEF",
  ]]);
});

Deno.test("native null restored user selections become absent without rewriting valid identities", () => {
  for (const empty of [undefined, null]) {
    const message = mapMessage(JSON.parse(JSON.stringify({
      id: "message",
      sessionID: "session",
      role: "user",
      time: { created: 1 },
      agent: empty,
      model: empty,
    })));
    assert(message.role === "user");
    assertEquals([message.agent, message.model, message.variant], [
      undefined,
      undefined,
      undefined,
    ]);
    const wire = JSON.parse(JSON.stringify(message));
    for (const key of ["agent", "model", "variant"]) {
      assert(!Object.hasOwn(wire, key));
    }
  }
  for (const variant of [undefined, null, "mixed_CASE", ""]) {
    const message = mapMessage(JSON.parse(JSON.stringify({
      id: "message",
      sessionID: "session",
      role: "user",
      time: { created: 1 },
      agent: "custom_AGENT",
      model: { providerID: "Provider/ID", modelID: "Model/ID", variant },
    })));
    assert(message.role === "user");
    assertEquals(message.agent, "custom_AGENT");
    assertEquals(message.model, { provider: "Provider/ID", model: "Model/ID" });
    assertEquals(message.variant, variant ?? undefined);
    assertEquals(
      Object.hasOwn(JSON.parse(JSON.stringify(message)), "variant"),
      variant != null,
    );
  }
});

Deno.test("native optional session, reply and attachment references never publish null", () => {
  for (const value of [undefined, null, "ses_parent", "exact/ID", ""]) {
    const session = JSON.parse(JSON.stringify({
      id: "session",
      parentID: value,
      projectID: "project",
      directory: "/project",
      title: "Session",
      time: { created: 1, updated: 2 },
    }));
    if (value === "exact/ID" || value === "") {
      assertThrows(
        () => mapSession(session),
        Error,
        "native opencode-v1 session ID",
      );
      assertThrows(
        () => mapIndex(session),
        Error,
        "native opencode-v1 session ID",
      );
    } else {
      const parentID = value == null ? undefined : "opcv1-ses_parent";
      assertEquals(mapSession(session).parentID, parentID);
      assertEquals(mapIndex(session).parentID, parentID);
    }
    const message = mapMessage(JSON.parse(JSON.stringify({
      id: "reply",
      sessionID: "session",
      role: "assistant",
      agent: "build",
      parentID: value,
      providerID: "Provider/ID",
      modelID: "Model/ID",
      time: { created: 2 },
    })));
    assert(message.role === "assistant");
    assertEquals(message.replyTo, value ?? undefined);
    const file = mapPart(JSON.parse(JSON.stringify({
      id: "part",
      sessionID: "session",
      messageID: "message",
      type: "file",
      mime: "text/plain",
      source: { path: value },
    })));
    assert(file.kind === "file");
    assertEquals(file.path, value ?? undefined);
  }
  const permission = mapPermission(JSON.parse(JSON.stringify({
    id: "permission",
    sessionID: "session",
    permission: "bash",
    patterns: ["echo test"],
    always: [],
    metadata: {},
    tool: null,
  })));
  assertEquals(permission.toolCall, undefined);
});
