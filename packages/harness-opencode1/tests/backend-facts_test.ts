// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { agentColors, agents } from "../agents.ts";
import { Client } from "../client.ts";
import { sessionDirectory } from "../directory.ts";
import { mapPart } from "../map.ts";

Deno.test("agent catalog and transcript colours carry neutral roles, literal colours or absence", async () => {
  const raw = [
    { name: "action", mode: "all", color: "primary" },
    { name: "alternate", mode: "all", color: "secondary" },
    { name: "literal", mode: "all", color: "#abcDEF" },
    { name: "short", mode: "all", color: "#abc" },
    { name: "alpha", mode: "all", color: "#abcdef12" },
    { name: "missing", mode: "all" },
    { name: "invalid", mode: "all", color: "var(--private-theme)" },
  ];
  const client = new Client({
    url: "http://native.invalid",
    username: "opencode",
    password: "",
    db: "",
    heartbeattimeout: 25,
    reconnectmax: 30,
  }, () => Promise.resolve(Response.json(raw)));
  const directory = sessionDirectory(() => "/project", () => {
    throw new Error("Cached directory should be used");
  });
  const expected = [
    "accent",
    "secondary",
    "#abcDEF",
    "#abc",
    "#abcdef12",
    undefined,
    undefined,
  ];
  const colours = await agentColors(client, "/project");
  assertEquals(raw.map(({ name }) => colours.get(name)), expected);
  for (const primary of [false, true]) {
    const catalog = await agents(client, directory).listAgents(
      "session",
      primary,
    );
    assertEquals(catalog.map(({ color }) => color), expected);
    assert(!JSON.stringify(catalog).includes("var("));
  }
});

Deno.test("task agent identity is reported by native metadata, never manufactured", () => {
  for (const value of [undefined, null, "", 42, "general", "Custom/Agent"]) {
    const part = mapPart({
      id: "task",
      sessionID: "session",
      messageID: "message",
      type: "tool",
      callID: "call",
      tool: "task",
      state: {
        status: "completed",
        input: { subagent_type: value },
        output: "Done",
      },
    });
    assert(part?.kind === "tool" && part.call.tool === "task");
    assertEquals(
      part.call.agent,
      typeof value === "string" && value ? value : undefined,
    );
    const wire = JSON.parse(JSON.stringify(part));
    assertEquals("agent" in wire.call, typeof value === "string" && !!value);
  }
});
