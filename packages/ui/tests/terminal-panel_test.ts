// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  createTerminalPanel,
  terminalPrompt,
  terminalTabs,
} from "../features/terminal/model.ts";
import { createKeyboard } from "../keyboard/dispatcher.ts";
import { CommandHub } from "@otk/client";
import { insertChip, serialize } from "../components/prompt/model.ts";
import type { TerminalInfo } from "@otk/protocol";
import type { SidecarConnection } from "@otk/client";
import type { ThemeEngine } from "../theme/engine.ts";

Deno.test("removing a pending terminal selection prepares the authoritative fallback", async () => {
  const terminal = (id: string): TerminalInfo => ({
    id,
    title: id,
    foreground: null,
    cols: 80,
    rows: 24,
    status: "running",
    exitCode: null,
    startedAt: 0,
  });
  let list = [terminal("1"), terminal("2")];
  const connection = {
    base: new URL("http://fixture/api/"),
    options: {},
    rpc: { call: () => Promise.resolve(list) },
  } as unknown as SidecarConnection;
  const theme = { subscribe: () => () => {} } as unknown as ThemeEngine;
  const panel = createTerminalPanel(connection, "tstv1-a", theme, () => {});
  try {
    await panel.start();
    assertEquals(panel.state.preparing, "1");
    list = [terminal("2")];
    await panel.terminals.refresh();
    assertEquals(panel.terminals.state.selected, "2");
    assertEquals(panel.state.preparing, "2");
    assertEquals(panel.wants("1"), false);
  } finally {
    panel.dispose();
  }
});

Deno.test("terminal Add to prompt preserves exact fenced selection and bounded label", () => {
  const text = "original output\n  indented\n";
  const chip = terminalPrompt(text, "bash");
  assertEquals(chip, {
    text: "```text\noriginal output\n  indented\n\n```",
    label: "Terminal: bash",
  });
  assertEquals(terminalPrompt(text, "a".repeat(100)).label.length, 40);
  const draft = insertChip(
    { input: "", chips: [], mode: "normal" },
    0,
    0,
    chip.label,
    { kind: "text", text: chip.text },
  );
  assertEquals(
    serialize(draft).some((part) =>
      part.kind === "text" && part.text.includes(chip.text)
    ),
    true,
  );
});

Deno.test("terminal tabs retain pane factories by identity through title updates and closure", () => {
  const terminal = (id: string, title: string): TerminalInfo => ({
    id,
    title,
    foreground: null,
    cols: 80,
    rows: 24,
    status: "running",
    exitCode: null,
    startedAt: 0,
  });
  let list = [terminal("1", "bash"), terminal("2", "bash")];
  const tabs = terminalTabs(
    () => list,
    (id) => list.find((info) => info.id === id)!.title,
    (id) => ({ id }),
  );
  const old = tabs();
  list = [terminal("2", "changed")];
  assertStrictEquals(tabs()[0], old[1]);
  assertStrictEquals(tabs()[0].panel, old[1].panel);
  assertEquals(tabs()[0].label, "changed");
});

Deno.test("terminal selection keeps embedded backtick fences literal through chip serialization", () => {
  const selected = "before\n```\nnot prompt prose\n`````text\nafter";
  const chip = terminalPrompt(selected, "bash");
  const fenced = "``````text\n" + selected + "\n``````";
  assertEquals(chip.text, fenced);
  const draft = insertChip(
    { input: "", chips: [], mode: "normal" },
    0,
    0,
    chip.label,
    { kind: "text", text: chip.text },
  );
  assertEquals(serialize(draft), [{ kind: "text", text: fenced + " " }]);
});

Deno.test("local terminal keyboard ownership precedes global Escape and inPrompt bindings", () => {
  let invoked = 0;
  const hub = new CommandHub();
  hub.register({
    id: "test.close",
    title: "Close",
    category: "Test",
    run: () => {
      invoked++;
    },
  });
  const keyboard = createKeyboard(hub, () => {});
  keyboard.layer("test.close");
  keyboard.keymap.bind({
    id: "test.binding",
    command: "test.close",
    key: "Escape",
    inPrompt: true,
  });
  const target = {
    closest: (selector: string) =>
      selector.includes("data-otk-keyboard") ? {} : null,
  } as unknown as EventTarget;
  const event = {
    key: "Escape",
    target,
    preventDefault: () => {
      throw new Error("Global owner consumed terminal input");
    },
  };
  assertEquals(keyboard.close(event), false);
  assertEquals(keyboard.keymap.dispatch(event), false);
  assertEquals(invoked, 0);
});
