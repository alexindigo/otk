// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import {
  DockRegistry,
  PartRegistry,
  ToolRegistry,
} from "../registries/renderers.ts";
import { PromptRegistry } from "../registries/prompt.ts";
import type { PromptContext } from "../registries/prompt.ts";
import type { ExternalCall, Part, ToolBase, ToolCall } from "@otk/protocol";

declare module "@otk/protocol" {
  interface ToolKinds {
    "feature.probe": ToolBase & { tool: "feature.probe"; result: number };
  }
  interface PartKinds {
    "feature.probe": { kind: "feature.probe"; id: string; result: number };
  }
}

Deno.test("tool resolution honors external names, typed tools, fallback and consumer isolation", () => {
  const tools = new ToolRegistry(), other = new ToolRegistry();
  const fallback = () => "fallback",
    external = () => "external",
    typed = () => "typed";
  tools.fallback(fallback);
  tools.register("external", external);
  tools.registerTyped("bash", typed);
  const call: ExternalCall = {
    tool: "external",
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
  tools.register("bash", external);
  assertStrictEquals(tools.resolve({ ...call, name: "bash" }), external);
  assertThrows(
    () => tools.registerTyped("bash", typed),
    Error,
    "Duplicate tool",
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
  parts.registerTyped("text", custom);
  const text: Part = { kind: "text", id: "t", blocks: [], synthetic: false };
  assertStrictEquals(parts.resolve(text), custom);
  assertStrictEquals(
    parts.resolve({ kind: "external", id: "f", name: "future" }),
    fallback,
  );
  assertStrictEquals(
    parts.resolve({ kind: "external", id: "t", name: "text" }),
    fallback,
  );
  parts.register("text", () => "external");
  assertStrictEquals(parts.resolve(text), custom);
  assertEquals(other.resolve(text), undefined);
  assertThrows(
    () => parts.registerTyped("text", custom),
    Error,
    "Duplicate part",
  );
  assertThrows(() => parts.register("text", custom), Error, "Duplicate part");
  assertThrows(
    () => parts.fallback(fallback),
    Error,
    "Duplicate part fallback",
  );
});
Deno.test("feature-owned tool and part contracts extend protocol and renderer dispatch", () => {
  const tools = new ToolRegistry(), parts = new PartRegistry();
  const tool = (props: { call: { result: number } }) =>
    String(props.call.result);
  const part = (props: { part: { result: number } }) =>
    String(props.part.result);
  tools.registerTyped("feature.probe", tool);
  parts.registerTyped("feature.probe", part);
  const call: ToolCall = {
    tool: "feature.probe",
    result: 42,
    callID: "c",
    status: "completed",
    time: {},
    awaitingPermission: false,
  };
  const value: Part = { kind: "feature.probe", id: "p", result: 43 };
  assertStrictEquals(tools.resolve(call), tool);
  assertStrictEquals(parts.resolve(value), part);
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
