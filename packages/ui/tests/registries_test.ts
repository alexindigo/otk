// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import {
  DockRegistry,
  PartRegistry,
  ToolRegistry,
} from "../registries/renderers.ts";
import { PromptRegistry } from "../registries/prompt.ts";
import type { PromptContext } from "../registries/prompt.ts";
import type { GenericCall } from "@otk/protocol";

Deno.test("tool resolution honors external names, typed tools, fallback and consumer isolation", () => {
  const tools = new ToolRegistry(), other = new ToolRegistry();
  const fallback = () => "fallback",
    external = () => "external",
    typed = () => "typed";
  tools.fallback(fallback);
  tools.register("external", external);
  tools.register("bash", typed, (call) => call.tool === "bash");
  const call: GenericCall = {
    tool: "generic",
    name: "external",
    summary: "probe",
    callID: "call",
    status: "completed",
    time: {},
    awaitingPermission: false,
  };
  assertStrictEquals(tools.resolve(call), external);
  assertStrictEquals(tools.resolve({ ...call, name: "uninstalled" }), fallback);
  assertStrictEquals(
    tools.resolve({ ...call, name: "bash" }),
    fallback,
    "Generic names must not enter a renderer expecting a different wire shape",
  );
  assertStrictEquals(
    tools.resolve({
      tool: "bash",
      command: "pwd",
      output: "",
      callID: "bash",
      status: "completed",
      time: {},
      awaitingPermission: false,
    }),
    typed,
  );
  assertEquals(other.resolve(call), undefined);
  assertThrows(
    () => tools.register("external", external),
    Error,
    "Duplicate tool",
  );
  assertThrows(
    () => tools.fallback(fallback),
    Error,
    "Duplicate tool fallback",
  );
});
Deno.test("part fallback and separate collections preserve registered ownership", () => {
  const parts = new PartRegistry(), other = new PartRegistry();
  const fallback = () => "unsupported", custom = () => "registered";
  parts.fallback(fallback);
  parts.register("text", custom);
  assertStrictEquals(parts.resolve("text"), custom);
  assertStrictEquals(parts.resolve("future"), fallback);
  assertEquals(other.resolve("text"), undefined);
  assertThrows(() => parts.register("text", custom), Error, "Duplicate part");
  assertThrows(
    () => parts.fallback(fallback),
    Error,
    "Duplicate part fallback",
  );
});
Deno.test("dock selection gates capabilities in registration order and renders injected inputs", () => {
  const docks = new DockRegistry();
  docks.register({ id: "always", render: (inputs) => inputs.always });
  docks.register({
    id: "optional",
    capability: "custom",
    render: (inputs) => inputs.optional,
  });
  assertEquals(docks.available([]).map((dock) => dock.id), ["always"]);
  const available = docks.available(["custom"]);
  assertEquals(available.map((dock) => dock.id), ["always", "optional"]);
  assertEquals(
    available.map((dock) => dock.render({ always: "A", optional: "B" })),
    ["A", "B"],
  );
  assertThrows(
    () => docks.register({ id: "optional", render: () => "duplicate" }),
    Error,
    "Duplicate dock",
  );
});
Deno.test("prompt factories create independent feature lifetimes with caller-injected context", () => {
  const prompt = new PromptRegistry();
  const contexts: PromptContext[] = [];
  prompt.register({
    id: "custom",
    create(ctx) {
      contexts.push(ctx);
      let count = 0;
      return {
        beforeSubmit() {
          return ++count === 2;
        },
      };
    },
  });
  const one = {} as PromptContext, two = {} as PromptContext;
  const first = prompt.create(one)[0], second = prompt.create(two)[0];
  const draft = { input: "", chips: [], mode: "normal" as const };
  assertEquals(first.beforeSubmit?.(draft), false);
  assertEquals(first.beforeSubmit?.(draft), true);
  assertEquals(second.beforeSubmit?.(draft), false);
  assertEquals(contexts, [one, two]);
  assertThrows(
    () => prompt.register({ id: "custom", create: () => ({}) }),
    Error,
    "Duplicate prompt feature",
  );
});
