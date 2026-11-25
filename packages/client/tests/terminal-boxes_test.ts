// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import {
  releaseTerminalBoxes,
  type SidecarConnection,
  TerminalBox,
  terminalBoxFor,
} from "../mod.ts";

Deno.test("terminal box transitions retain per-session presentation without view ownership", () => {
  const box = new TerminalBox(), seen: string[] = [];
  const stop = box.subscribe((mode) => seen.push(mode));
  box.expand();
  box.collapse();
  assertEquals(box.mode, "closed");
  box.toggle();
  box.expand();
  box.expand();
  assertEquals(box.mode, "expanded");
  box.collapse();
  assertEquals(box.mode, "docked");
  box.close();
  box.close();
  box.toggle();
  box.toggle();
  assertEquals(seen, [
    "docked",
    "expanded",
    "docked",
    "closed",
    "docked",
    "closed",
  ]);
  stop();
  box.toggle();
  assertEquals(seen.length, 6);
});

Deno.test("terminal boxes are keyed by connection and session and released by connection owner", () => {
  const first = {} as SidecarConnection, second = {} as SidecarConnection;
  const box = terminalBoxFor(first, "one");
  box.toggle();
  box.expand();
  assertStrictEquals(terminalBoxFor(first, "one"), box);
  assertEquals(terminalBoxFor(first, "one").mode, "expanded");
  assertEquals(terminalBoxFor(first, "two").mode, "closed");
  assertEquals(terminalBoxFor(second, "one").mode, "closed");
  releaseTerminalBoxes(first);
  assertNotStrictEquals(terminalBoxFor(first, "one"), box);
  assertEquals(terminalBoxFor(first, "one").mode, "closed");
  releaseTerminalBoxes(first);
  releaseTerminalBoxes(second);
});
