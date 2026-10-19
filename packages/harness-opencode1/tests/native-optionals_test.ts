// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { agentColors, agents } from "../agents.ts";
import { Client } from "../client.ts";
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
};

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
    const options = await capability.listAgents("session", primary);
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
  for (const value of [undefined, null, "exact/ID", ""]) {
    const session = JSON.parse(JSON.stringify({
      id: "session",
      parentID: value,
      projectID: "project",
      directory: "/project",
      title: "Session",
      time: { created: 1, updated: 2 },
    }));
    assertEquals(mapSession(session).parentID, value ?? undefined);
    assertEquals(mapIndex(session).parentID, value ?? undefined);
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
