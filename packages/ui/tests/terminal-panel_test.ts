// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import {
  createTerminalPanel,
  terminalPrompt,
  terminalTabs,
} from "../features/terminal/model.ts";
import { createKeyboard } from "../keyboard/dispatcher.ts";
import {
  CommandHub,
  FeedbackFailure,
  RequestFailure,
  TerminalBox,
  terminalRunFailureOwned,
} from "@otk/client";
import { insertChip, serialize } from "../components/prompt/model.ts";
import type { TerminalInfo } from "@otk/protocol";
import type { SidecarConnection } from "@otk/client";
import type { ThemeEngine } from "../theme/engine.ts";

for (const mode of ["docked", "expanded"] as const) {
  Deno.test(`closing every shell leaves the terminal box ${mode}`, async () => {
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
      rpc: {
        call(method: string, args: { terminalID: string }) {
          if (method === "terminal.list") return Promise.resolve(list);
          if (method === "terminal.close") {
            list = list.filter(({ id }) => id !== args.terminalID);
            return Promise.resolve(undefined);
          }
          throw new Error(`Unexpected terminal request: ${method}`);
        },
      },
    } as unknown as SidecarConnection;
    const theme = { subscribe: () => () => {} } as unknown as ThemeEngine;
    const box = new TerminalBox();
    box.toggle();
    if (mode === "expanded") box.expand();
    const panel = createTerminalPanel(
      connection,
      "tstv1-a",
      theme,
      () => {},
      undefined,
      box,
    );
    try {
      await panel.start();
      await panel.closeIndex(0);
      assertEquals(panel.terminals.state.list.map(({ id }) => id), ["2"]);
      await panel.closeIndex(0);
      assertEquals(box.mode, mode);
      assertEquals(panel.terminals.state.list, []);
      assertEquals(panel.state.creating, false);
    } finally {
      panel.dispose();
    }
  });
}

for (const code of ["terminal-unavailable", "method"]) {
  Deno.test(`terminal panel owns queued Run rejection for ${code}`, async () => {
    const box = new TerminalBox();
    const calls: string[] = [];
    const connection = {
      base: new URL("http://fixture/api/"),
      options: {},
      rpc: {
        call(method: string) {
          calls.push(method);
          return method === "terminal.list"
            ? Promise.resolve([])
            : Promise.reject(
              new RequestFailure({
                code,
                diagnosticID: "terminal-run-fixture",
                retry: "none",
                facts: { reason: "No terminal host" },
              }),
            );
        },
      },
    } as unknown as SidecarConnection;
    const theme = { subscribe: () => () => {} } as unknown as ThemeEngine;
    const panel = createTerminalPanel(
      connection,
      "tstv1-a",
      theme,
      () => {},
      undefined,
      box,
    );
    try {
      const run = box.run("echo sample");
      const rejection = assertRejects(() => run, FeedbackFailure);
      await panel.start();
      const cause = await rejection;
      assertStrictEquals(cause.feedback, panel.state.error);
      assertEquals(terminalRunFailureOwned(cause), true);
      assertEquals(calls, ["terminal.list", "terminal.create"]);
      assertEquals(
        box.unavailable,
        "Terminals are unavailable on this OTK server",
      );
      await panel.terminals.refresh();
      assertEquals(box.unavailable, undefined);
      assertEquals(panel.state.error, "");
    } finally {
      panel.dispose();
    }
  });
}

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
