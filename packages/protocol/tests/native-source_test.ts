// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { type Message, referenceSources, sourceAt } from "../mod.ts";

const source = (kind: string, payload?: string) => ({
  kind,
  preview: `{"kind":"${kind}"}`,
  bytes: 20,
  truncated: false,
  ...(payload === undefined ? {} : { payload }),
});
Deno.test("loaded items keep plugin references; declared content keeps its copy text", () => {
  const derive = (): Message => ({
    id: "m",
    sessionID: "s",
    role: "assistant",
    time: { created: 1 },
    agent: "build",
    model: { provider: "p", model: "m" },
    tokens: {
      input: null,
      output: null,
      reasoning: null,
      cache: { read: null, write: null },
    },
    cost: null,
    interrupted: false,
    source: source("message", "joined text"),
    parts: [
      {
        kind: "text",
        id: "t",
        synthetic: false,
        blocks: [],
        source: source("text", "hi"),
      },
      {
        kind: "external",
        id: "r",
        name: "record",
        content: true,
        source: source("record", "exact sent text"),
      },
      {
        kind: "external",
        id: "b",
        name: "bookkeeping",
        source: source("step", "{}"),
      },
      {
        kind: "tool",
        id: "tool",
        call: {
          tool: "unknown",
          callID: "c",
          name: "x",
          input: {},
          status: "completed",
          time: {},
          source: source("tool", "output"),
          children: [{
            tool: "unknown",
            callID: "child",
            name: "y",
            input: {},
            status: "completed",
            time: {},
            source: source("nested", "nested output"),
          }],
        } as never,
      },
    ],
  });
  const loaded = referenceSources(derive(), (path) => `ref:${path}`);
  const refs: [string, unknown][] = [];
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "source") {
        refs.push([String((child as { ref: string }).ref), child]);
      } else walk(child);
    }
  };
  walk(loaded);
  assertEquals(refs, [
    ["ref:", { kind: "message", ref: "ref:" }],
    ["ref:p:t", { kind: "text", ref: "ref:p:t" }],
    ["ref:p:r", {
      kind: "record",
      ref: "ref:p:r",
      payload: "exact sent text",
    }],
    ["ref:p:b", { kind: "step", ref: "ref:p:b" }],
    ["ref:p:tool/c", { kind: "tool", ref: "ref:p:tool/c" }],
    ["ref:p:tool/c/child", { kind: "nested", ref: "ref:p:tool/c/child" }],
  ]);
  // Every reference reaches its exact derived source; nothing is dropped.
  for (const [ref] of refs) {
    const view = sourceAt(derive(), ref.slice(4));
    assertEquals(view?.preview.includes('"kind"'), true, ref);
  }
  assertEquals(sourceAt(derive(), "p:missing"), undefined);
  // Referencing is idempotent and never re-reads an already loaded value.
  assertEquals(referenceSources(loaded, () => "other"), loaded);
});
