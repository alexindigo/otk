// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
  assertNotStrictEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import {
  releaseTerminalBoxes,
  RequestFailure,
  type SidecarConnection,
  TerminalBox,
  terminalBoxFor,
} from "../mod.ts";

Deno.test("runs open a closed box, retain expanded mode, and drain FIFO", async () => {
  const box = new TerminalBox();
  const calls: string[] = [];
  box.runs.attach({
    terminalID: "terminal",
    bracketedPaste: () => true,
    paste: (text) => calls.push(text),
    submit: () => calls.push("Enter"),
    erase: () => {},
  });
  const first = box.run("one");
  assertEquals(box.mode, "docked");
  box.expand();
  const second = box.run("two");
  assertEquals(box.mode, "expanded");
  assertEquals(box.runs.waiting, true);
  box.runs.deliver("terminal");
  assertEquals(calls, ["one", "Enter", "two", "Enter"]);
  assertEquals(box.runs.waiting, false);
  await Promise.all([first, second]);
});

Deno.test("runs reject on close, release or known unavailability", async () => {
  const connection = {} as SidecarConnection;
  const box = terminalBoxFor(connection, "one");
  const closed = box.run("queued");
  box.toggle();
  const reason = "The terminal was closed before the command ran.";
  const failure = await assertRejects(() => closed, RequestFailure, reason);
  assertEquals(failure.failure.facts, {
    actionLabel: "Run in terminal",
    reason,
  });
  box.markUnavailable("No host");
  await assertRejects(() => box.run("refused"), RequestFailure, "No host");
  assertEquals(box.mode, "closed");
  box.markUnavailable(undefined);
  const released = box.run("pending");
  releaseTerminalBoxes(connection);
  await assertRejects(() => released, RequestFailure, reason);
});

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
