// SPDX-License-Identifier: LGPL-3.0-only
import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import * as client from "../mod.ts";
import type { TerminalRunTarget } from "../mod.ts";

function harness() {
  const box = new client.TerminalBox();
  const { runs } = box;
  const calls: unknown[][] = [];
  let bracketed = true;
  const target = (terminalID: string): TerminalRunTarget => ({
    terminalID,
    bracketedPaste: () => bracketed,
    paste: (text) => calls.push(["paste", terminalID, text]),
    submit: () => calls.push(["submit", terminalID]),
    erase: (count) => calls.push(["erase", terminalID, count]),
  });
  const detach = runs.attach(target("a"));
  async function paste(text = "one", id = "a") {
    const result = box.paste(text);
    runs.deliver(id);
    await result;
  }
  return {
    box,
    runs,
    calls,
    target,
    detach,
    paste,
    unbracket: () => bracketed = false,
  };
}

Deno.test("terminal runs: immediate request opens dock, pastes, then submits", async () => {
  const { box, runs, calls } = harness();
  const requested = box.run("one");
  assertEquals(box.mode, "docked");
  assert(runs.waiting);
  assertEquals(calls, []);
  runs.deliver("a");
  await requested;
  assertEquals(calls, [["paste", "a", "one"], ["submit", "a"]]);
  assertEquals(runs.pending, undefined);
  assertEquals(runs.waiting, false);
});

Deno.test("terminal runs: confirmation request pastes and waits for Run", async () => {
  const { runs, calls, paste } = harness();
  await paste("  one  ");
  const pending = runs.pending;
  assert(pending?.id);
  assertEquals(pending.phase, "pending");
  assertEquals(pending.mode, "confirm");
  assertEquals(pending.text, "one");
  assertEquals(pending.terminalID, "a");
  assertEquals(calls, [["paste", "a", "one"]]);
  assert(runs.confirm());
  assertEquals(calls, [["paste", "a", "one"], ["submit", "a"]]);
  assertEquals(runs.pending, undefined);
  assertEquals(runs.confirm(), false);
});

Deno.test("terminal runs: Cancel erases only the pasted character count", async () => {
  const { runs, calls, paste } = harness();
  const text = "a\u0301b\tc\nd";
  await paste(text);
  assert(runs.cancel());
  assertEquals(runs.pending, undefined);
  assertEquals(calls, [["paste", "a", text], ["erase", "a", 6]]);
  assertEquals(client.eraseCount("a\u200d\ufe0f😀\u20dd"), 2);
});

Deno.test("terminal runs: input in another terminal is ignored; input here releases without bytes", async () => {
  const { runs, calls, paste } = harness();
  await paste();
  runs.input("b");
  assertEquals(runs.pending?.terminalID, "a");
  runs.input("a");
  assertEquals(runs.pending, undefined);
  assertEquals(runs.confirm(), false);
  assertEquals(runs.cancel(), false);
  assertEquals(calls, [["paste", "a", "one"]]);
});

for (const id of ["a", "b"]) {
  Deno.test(`terminal runs: replacement erases in the original attached terminal (${id})`, async () => {
    const { runs, calls, target, paste } = harness();
    runs.attach(target("b"));
    await paste();
    const first = runs.pending?.id;
    await paste("two", id);
    assertEquals(calls, [["paste", "a", "one"], ["erase", "a", 3], [
      "paste",
      id,
      "two",
    ]]);
    assertEquals(runs.pending?.text, "two");
    assertEquals(runs.pending?.terminalID, id);
    assert(runs.pending?.id !== first);
  });
}

Deno.test("terminal runs: immediate run erases pending text first", async () => {
  const { box, runs, calls, paste } = harness();
  await paste();
  const run = box.run("two");
  runs.deliver("a");
  await run;
  assertEquals(calls, [["paste", "a", "one"], ["erase", "a", 3], [
    "paste",
    "a",
    "two",
  ], ["submit", "a"]]);
  assertEquals(runs.pending, undefined);
});

Deno.test("terminal runs: queued confirmation is replaced; immediate runs stay FIFO", async () => {
  const { box, runs, calls } = harness();
  const older = box.paste("discard this");
  const one = box.run("one");
  const two = box.run("two");
  const newer = box.paste("keep this");
  await older;
  assert(runs.waiting);
  assertEquals(calls, []);
  runs.deliver("a");
  await Promise.all([one, two, newer]);
  assertEquals(calls, [
    ["paste", "a", "one"],
    ["submit", "a"],
    ["paste", "a", "two"],
    ["submit", "a"],
    ["paste", "a", "keep this"],
  ]);
  assertEquals(runs.pending?.text, "keep this");
});

for (const release of [false, true]) {
  Deno.test(`terminal runs: ${release ? "release" : "hide"} rejects queued input`, async () => {
    const { box, runs, calls, paste } = harness();
    await paste();
    const queued = box.run("queued");
    const pending = runs.pending;
    if (release) box.release();
    else box.close();
    await assertRejects(
      () => queued,
      client.RequestFailure,
      "The terminal was closed before the command ran.",
    );
    assertEquals(box.mode, "closed");
    assertEquals(runs.waiting, false);
    assertStrictEquals(runs.pending, release ? undefined : pending);
    assertEquals(calls, [["paste", "a", "one"]]);
    if (release) {
      await assertRejects(() => box.paste("late"), client.RequestFailure);
    }
  });
}

Deno.test("terminal runs: authoritative disappearance releases the pending line", async () => {
  const { runs, calls, paste } = harness();
  await paste();
  runs.present(["a", "b"]);
  assert(runs.pending);
  runs.present(["b"]);
  assertEquals(runs.pending, undefined);
  assertEquals(calls, [["paste", "a", "one"]]);
});

Deno.test("terminal runs: unbracketed shell refuses multiline and tab without sending bytes", async () => {
  const { box, runs, calls, paste, unbracket } = harness();
  unbracket();
  for (const text of ["one\ntwo", "one\ttwo"]) {
    const result = box.paste(text);
    runs.deliver("a");
    const failure = await assertRejects(() => result, client.RequestFailure);
    assertEquals(failure.failure.code, "terminal.unbracketed");
    assertEquals(
      failure.failure.facts?.reason,
      "This shell would run each line at once, so OTK did not paste it.",
    );
    assertEquals(runs.pending, undefined);
    assertEquals(calls, []);
  }
  await paste();
  assertEquals(calls, [["paste", "a", "one"]]);
});

Deno.test("terminal runs: detach keeps pending; Run and Cancel need a current target", async () => {
  const { runs, target, calls, detach, paste } = harness();
  await paste();
  detach();
  assert(runs.pending);
  assertEquals(runs.ready("a"), false);
  assertEquals(runs.confirm(), false);
  assertEquals(runs.cancel(), false);
  runs.attach(target("a"));
  detach();
  assert(runs.ready("a"));
  assert(runs.confirm());
  assertEquals(calls, [["paste", "a", "one"], ["submit", "a"]]);
});

Deno.test("terminal runs: a detached old target is released without bytes on replacement", async () => {
  const { runs, target, calls, detach, paste } = harness();
  await paste();
  detach();
  runs.attach(target("b"));
  await paste("two", "b");
  assertEquals(calls, [["paste", "a", "one"], ["paste", "b", "two"]]);
  assertEquals(runs.pending?.terminalID, "b");
});

Deno.test("terminal runs: a throwing target fails the run and the remaining queue with one cause", async () => {
  const { box, runs, target, calls } = harness();
  const cause = new Error("write rejected");
  runs.attach({
    ...target("a"),
    submit: () => {
      throw cause;
    },
  });
  const one = box.run("one"), two = box.paste("two");
  assertStrictEquals(assertThrows(() => runs.deliver("a")), cause);
  for (const result of [one, two]) {
    assertStrictEquals(await assertRejects(() => result), cause);
  }
  assertEquals(runs.waiting, false);
  assertEquals(runs.pending, undefined);
  assertEquals(calls, [["paste", "a", "one"]]);
});

Deno.test("terminal runs: normalized input, selection priority, and code-point labels", () => {
  assertEquals(
    client.normalizeRunText("\r\n a\t\x00b\x1b\rc\x7f  "),
    "a\tb\nc",
  );
  assertEquals(
    client.runnableText({ selection: " selection ", span: "other" }),
    "selection",
  );
  assertEquals(
    client.runnableText({ selection: " \n ", span: " code " }),
    "code",
  );
  assertEquals(client.runnableText({ selection: "\x1b" }), undefined);
  assertEquals(
    client.runLabel("printf 'otk-%s\\n' a"),
    "Run in terminal: printf 'otk-%s\\n' a",
  );
  const forty = "𐐀".repeat(40);
  assertEquals(client.runLabel(forty), `Run in terminal: ${forty}`);
  assertEquals(client.runLabel(forty + "x"), `Run in terminal: ${forty}...`);
  assertEquals(client.runLabel("one\ntwo"), "Run in terminal: one...");
});
