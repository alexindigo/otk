// SPDX-License-Identifier: LGPL-3.0-only
// Equivalent kosmozoo t_keys.mjs coverage, plus the OTK dispatcher contract.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  bindingMatches,
  comboFromEvent,
  type KeyBinding,
  makeKeymap,
} from "../keyboard/keys.ts";
import { createKeyboard } from "../keyboard/dispatcher.ts";
import { CommandHub } from "@otk/client";
const ev = (
  key: string,
  mods: { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean } = {},
) => ({
  key,
  shiftKey: !!mods.shift,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  metaKey: !!mods.meta,
});
const make = () => makeKeymap({ describe: (id) => id, request: () => true });
Deno.test("keys port: bare letters ignore Shift and require no Ctrl/Alt/Meta", () => {
  assert(bindingMatches("h", ev("h")));
  assert(bindingMatches("h", ev("H", { shift: true })));
  assert(!bindingMatches("h", ev("h", { ctrl: true })));
  assert(!bindingMatches("h", ev("x")));
});
Deno.test("keys port: shifted glyph question mark matches", () => {
  assert(bindingMatches("?", ev("?", { shift: true })));
});
Deno.test("keys port: exact combo modifier matching", () => {
  assert(bindingMatches("Shift+ArrowRight", ev("ArrowRight", { shift: true })));
  assert(!bindingMatches("Shift+ArrowRight", ev("ArrowRight")));
  assert(!bindingMatches("ArrowRight", ev("ArrowRight", { shift: true })));
  assert(bindingMatches("Alt+ArrowLeft", ev("ArrowLeft", { alt: true })));
  assert(
    bindingMatches(
      "Alt+Shift+ArrowLeft",
      ev("ArrowLeft", { alt: true, shift: true }),
    ),
  );
  assert(
    !bindingMatches("Alt+Shift+ArrowLeft", ev("ArrowLeft", { alt: true })),
  );
});
Deno.test("keys port: overrides, same-context conflict, dispatch and reset", () => {
  let fired = 0;
  const km = makeKeymap({
    describe: (id) => id,
    request: () => {
      fired++;
      return true;
    },
  });
  km.bind({ id: "a", command: "test.a", key: "a", ctx: "t" });
  km.bind({ id: "b", command: "test.b", key: "b", ctx: "t" });
  km.setKeymap({ a: "Shift+F1" });
  assertEquals(km.list()[0].key, "Shift+F1");
  assert(km.list()[0].overridden);
  assertEquals(km.rebind("b", "Shift+F1"), { conflict: "a" });
  km.bind({ id: "other", command: "test.other", key: "x", ctx: "other" });
  assertEquals(km.rebind("other", "Shift+F1"), { ok: true });
  assertEquals(km.rebind("a", "F2"), { ok: true });
  assertEquals(fired, 0);
  assert(km.dispatch(ev("F2")));
  assertEquals(fired, 1);
  km.resetAll();
  assertEquals(km.list()[0].key, "a");
  assert(!km.list()[0].overridden);
});
Deno.test("keys port: canonical modifier order", () => {
  assertEquals(
    comboFromEvent(ev("F5", { ctrl: true, alt: true, shift: true })),
    "Ctrl+Alt+Shift+F5",
  );
  assertEquals(comboFromEvent(ev("c")), "c");
});
Deno.test("keys port: bare letter conflicts are case-insensitive", () => {
  const km = make();
  km.bind({ id: "a", command: "a", key: "h", ctx: "c" });
  km.bind({ id: "b", command: "b", key: "j", ctx: "c" });
  assertEquals(km.findConflict("b", "H"), "a");
  assertEquals(km.findConflict("b", "F9"), null);
});
Deno.test("keys port: accessors, symbols, hidden callbacks, cycles and sparse arrays reject without activation", () => {
  let reads = 0, described = 0;
  const km = makeKeymap({
    request: () => false,
    describe: () => {
      described++;
      return "mode";
    },
  });
  const base = { id: "test", key: "x", command: "workbench.mode" },
    cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (
    const binding of [
      {
        ...base,
        get args() {
          reads++;
          return { mode: "split" };
        },
      },
      {
        ...base,
        args: {
          get mode() {
            reads++;
            return "split";
          },
        },
      },
      { ...base, [Symbol("callback")]() {} },
      Object.defineProperty({ ...base }, "callback", {
        value() {},
        enumerable: false,
      }),
      { ...base, args: cycle },
      { ...base, args: { ids: Array(1) } },
    ]
  ) {
    assertThrows(() => km.bind(binding as KeyBinding), TypeError);
  }
  assertEquals(reads, 0);
  assertEquals(described, 0);
  assertEquals(km.list(), []);
});
Deno.test("keys port: invalid metadata cannot become a row", () => {
  const km = makeKeymap({
    request: () => false,
    describe: () => (() => "executor") as unknown as string,
  });
  assertThrows(
    () => km.bind({ id: "bad", command: "known", key: "x" }),
    TypeError,
  );
  assertEquals(km.list(), []);
  const valid = make();
  for (
    const descriptor of [{ id: 1, key: "x", command: "known" }, {
      id: "bad",
      key: "x",
      command: "known",
      desc: [],
    }, { id: "bad", key: "x", command: "known", args: [] }]
  ) {
    assertThrows(
      () => valid.bind(descriptor as unknown as KeyBinding),
      TypeError,
    );
  }
  valid.bind({
    id: "valid",
    key: "x",
    command: "known",
    args: { mode: "split" },
  });
  assertEquals(valid.list()[0].desc, "known");
  assert(valid.dispatch(ev("x")));
});
Deno.test("keys: Mod alias and global overlap conflicts match the actual dispatch domain", () => {
  assert(bindingMatches("Mod+k", ev("K", { ctrl: true })));
  assert(bindingMatches("Mod+k", ev("k", { meta: true }), true));
  assert(!bindingMatches("Mod+k", ev("k", { ctrl: true }), true));
  const km = make();
  km.bind({ id: "a", key: "Mod+k", command: "a" });
  km.bind({ id: "b", key: "Tab", command: "b", ctx: "prompt" });
  assertEquals(km.findConflict("b", "Ctrl+k"), "a");
  assertEquals(km.rebind("missing", "x").error, "Unknown binding: missing");
});
Deno.test("keys: opt-in typing, predicate, unregister, composition and repeat lifetimes", () => {
  let calls = 0, enabled = true;
  const km = makeKeymap({
    describe: (id) => id,
    request: () => {
      calls++;
      return true;
    },
  });
  const release = km.bind({ id: "a", command: "a", key: "Tab" }, () => enabled);
  const target = { closest: () => ({}) } as unknown as EventTarget;
  assert(!km.dispatch({ ...ev("Tab"), target }));
  assert(km.dispatch(ev("Tab")));
  enabled = false;
  assert(!km.dispatch(ev("Tab")));
  release();
  release();
  assertEquals(km.list(), []);
  km.bind({ id: "b", command: "b", key: "Tab", inPrompt: true });
  assert(km.dispatch({ ...ev("Tab"), target }));
  assert(!km.dispatch({ ...ev("Tab"), isComposing: true }));
  assert(!km.dispatch({ ...ev("Tab"), repeat: true }));
  assertEquals(calls, 2);
});
Deno.test("keys: ordered layer closure invokes registered IDs and disposes independently", async () => {
  const hub = new CommandHub(), calls: string[] = [];
  for (const id of ["editor", "dock", "dialog"]) {
    hub.register({
      id,
      title: id,
      category: "Layers",
      run: () => {
        calls.push(id);
      },
    });
  }
  const keyboard = createKeyboard(hub, (error) => {
    throw error;
  });
  const editor = keyboard.layer("editor", () => true, 10),
    dock = keyboard.layer("dock", () => true, 20),
    dialog = keyboard.layer("dialog", () => true, 30);
  let prevented = 0;
  const event = { ...ev("Escape"), preventDefault: () => prevented++ };
  assert(keyboard.close(event));
  await Promise.resolve();
  dialog();
  assert(keyboard.close(event));
  dock();
  assert(keyboard.close(event));
  editor();
  assert(!keyboard.close(event));
  assertEquals(calls, ["dialog", "dock", "editor"]);
  assertEquals(prevented, 3);
});
Deno.test("keys: reset does not silently introduce a conflict", () => {
  const km = make();
  km.bind({ id: "a", command: "a", key: "a" });
  km.bind({ id: "b", command: "b", key: "b" });
  km.rebind("a", "x");
  km.rebind("b", "a");
  assertEquals(km.resetKey("a"), { conflict: "b" });
  assertEquals(km.list()[0].key, "x");
});
Deno.test("hidden commands retain owner titles in key rows while staying out of discovery", () => {
  const hub = new CommandHub();
  let calls = 0;
  hub.register({
    id: "external.hidden",
    title: "Insert newline",
    category: "Prompt",
    hidden: true,
    enabled: () => false,
    run: () => {
      calls++;
    },
  });
  const keyboard = createKeyboard(hub, (error) => {
    throw error;
  });
  keyboard.keymap.bind({
    id: "external.hidden",
    command: "external.hidden",
    key: "Enter",
    inPrompt: true,
  });
  assertEquals(hub.list(), []);
  assertEquals(keyboard.keymap.list()[0].desc, "Insert newline");
  assertEquals(calls, 0);
  assertEquals(keyboard.keymap.dispatch(ev("Enter")), false);
  assertEquals(calls, 0);
});
Deno.test("keyboard availability and invocation both receive the binding's data arguments", async () => {
  const hub = new CommandHub();
  let observed = "";
  hub.register({
    id: "external.args",
    title: "Arguments",
    category: "External",
    enabled: (_ctx, args?: { value: string }) => args?.value === "bound",
    run: (_ctx, args: { value: string }) => {
      observed = args.value;
    },
  });
  const keyboard = createKeyboard(hub, (error) => {
    throw error;
  });
  const release = keyboard.keymap.bind({
    id: "external.args",
    command: "external.args",
    key: "x",
    args: { value: "bound" },
  });
  assert(keyboard.keymap.dispatch(ev("x")));
  await Promise.resolve();
  assertEquals(observed, "bound");
  release();
});
