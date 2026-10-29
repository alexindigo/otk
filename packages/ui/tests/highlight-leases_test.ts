// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createHighlightLease, highlightBlock } from "../highlight/client.ts";

Deno.test("cooling releases source cache while another resource keeps the worker alive", async () => {
  const Native = globalThis.Worker;
  let captures = 0, terminations = 0;
  const names: string[] = [];
  globalThis.Worker = class extends Native {
    constructor(...args: ConstructorParameters<typeof Worker>) {
      super(...args);
      names.push(args[1]?.name ?? "");
    }
    override postMessage(value: unknown) {
      for (const request of Array.isArray(value) ? value : [value]) {
        if (request.type === "capture") captures++;
      }
      super.postMessage(value);
    }
    override terminate() {
      terminations++;
      super.terminate();
    }
  };
  const a = createHighlightLease(),
    b = createHighlightLease(),
    c = createHighlightLease();
  const source = "const resourceSecret = 42;";
  const first = highlightBlock("ts", source, a);
  const other = highlightBlock("ts", "const other = 1;", b);
  try {
    assertEquals(
      names.some((name) => name.includes("resourceSecret")),
      false,
      "the shared worker name cannot retain a cooled resource's source",
    );
    await first.capture({
      generation: 1,
      lang: "ts",
      text: source,
      streaming: false,
    }, () => {});
    first.dispose();
    const warm = highlightBlock("ts", source, a);
    await warm.capture({
      generation: 1,
      lang: "ts",
      text: source,
      streaming: false,
    }, () => {});
    warm.dispose();
    assertEquals(captures, 1, "warm reentry borrows the resource cache");
    a.dispose();
    assertEquals(terminations, 0, "another session retains the shared worker");
    const fresh = highlightBlock("ts", source, c);
    await fresh.capture({
      generation: 1,
      lang: "ts",
      text: source,
      streaming: false,
    }, () => {});
    assertEquals(
      captures,
      2,
      "a cold source cannot survive in the shared cache",
    );
    fresh.dispose();
  } finally {
    first.dispose();
    other.dispose();
    a.dispose();
    b.dispose();
    c.dispose();
    globalThis.Worker = Native;
  }
});
