// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { sha256 } from "@otk/protocol";
import {
  GhosttyTerminalCore,
  type GhosttyTheme,
} from "../terminal/ghostty/core.ts";
import { loadGhosttyRuntime } from "../terminal/ghostty/runtime.ts";
import { terminalInput, terminalSink } from "../terminal/adapter.ts";
import { ghosttyKeyboardCodes } from "../terminal/ghostty/key-names.ts";
import {
  ghosttyKeyForCode,
  ghosttyKeyForEvent,
} from "../terminal/ghostty/keyCodes.ts";

Deno.test("terminal key ABI preserves all 176 pinned T3 names and mappings", async () => {
  assertEquals(
    await sha256(JSON.stringify(ghosttyKeyboardCodes)),
    "20d38020bbed929e31b828d6d17ecfa823d3295f749c2ec4281d08ae705b7b39",
  );
  assert(Object.isFrozen(ghosttyKeyboardCodes));
  assertEquals(ghosttyKeyboardCodes.length, 176);
  assertEquals(ghosttyKeyForCode("ContextMenu"), 55);
  assertEquals(ghosttyKeyForCode("F10"), 130);
  assertEquals(ghosttyKeyForCode("Paste"), 175);
  for (const [index, code] of ghosttyKeyboardCodes.entries()) {
    assertEquals(ghosttyKeyForEvent({ code, key: code }), index);
  }
});

const theme: GhosttyTheme = {
  background: { r: 20, g: 20, b: 20 },
  foreground: { r: 230, g: 230, b: 230 },
  cursor: { r: 255, g: 77, b: 0 },
};

Deno.test("terminal renderer suppresses actual WASM ESC[6n replies through live and replay paths", async () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = input instanceof Request
      ? new URL(input.url)
      : new URL(String(input));
    return new Response(await Deno.readFile(url), { status: 200 });
  };
  try {
    const runtime = await loadGhosttyRuntime();
    const attach = runtime.attachPtyWriter;
    const generated: string[] = [];
    runtime.attachPtyWriter = function (terminal, writer) {
      return attach.call(this, terminal, (text) => {
        generated.push(text);
        writer(text);
      });
    };
    const input: Uint8Array[] = [];
    const userInput = terminalInput((bytes) => input.push(bytes));
    const core = await GhosttyTerminalCore.create(80, 24, 8, 16, theme);
    runtime.attachPtyWriter = attach;
    try {
      const sink = terminalSink({
        setSharedGrid: (grid) => {
          if (grid) core.resize(grid.cols, grid.rows, 8, 16);
        },
        resetAndWrite: (bytes) => core.resetAndWrite(bytes),
        write: (bytes) => core.write(bytes),
      }, () => {});
      sink.write(new TextEncoder().encode("\x1b[6n"));
      assert(
        generated.includes("\x1b[1;1R"),
        "WASM really generated a cursor reply",
      );
      sink.reset(80, 24, new TextEncoder().encode("\x1b[6n"));
      assertEquals(input, []);
      userInput("echo user\r");
      assertEquals(input.map((bytes) => new TextDecoder().decode(bytes)), [
        "echo user\r",
      ]);
    } finally {
      core.dispose();
    }
  } finally {
    globalThis.fetch = fetch;
  }
});

Deno.test("terminal selection is exact text, survives byte-split UTF-8 and resets before replay", async () => {
  const core = await GhosttyTerminalCore.create(80, 24, 8, 16, theme);
  try {
    const bytes = new TextEncoder().encode("selected caf\u00e9");
    core.write(bytes.subarray(0, bytes.length - 1));
    core.write(bytes.subarray(bytes.length - 1));
    core.setSelection({ x: 0, y: 0 }, { x: 12, y: 0 });
    assertEquals(core.selectionText(), "selected caf\u00e9");
    core.resetAndWrite(new TextEncoder().encode("replacement"));
    core.setSelection({ x: 0, y: 0 }, { x: 10, y: 0 });
    assertEquals(core.selectionText(), "replacement");
    assertEquals(core.snapshot().rowData[0].text, "replacement");
  } finally {
    core.dispose();
  }
});

Deno.test("terminal sink live resize preserves primary and alternate screen state", async () => {
  const core = await GhosttyTerminalCore.create(80, 24, 8, 16, theme);
  const encode = (text: string) => new TextEncoder().encode(text);
  const sink = terminalSink({
    setSharedGrid: (grid) => {
      if (grid) core.resize(grid.cols, grid.rows, 8, 16);
    },
    resetAndWrite: (bytes) => core.resetAndWrite(bytes),
    write: (bytes) => core.write(bytes),
  }, () => {});
  try {
    sink.reset(80, 24, encode("retained-primary\r\n"));
    sink.write(encode("\x1b[?1049hretained-alternate"));
    sink.resize(120, 40);
    assert(
      core.snapshot().rowData.some((row) =>
        row.text.includes("retained-alternate")
      ),
    );
    sink.write(encode("\x1b[?1049l"));
    assert(
      core.snapshot().rowData.some((row) =>
        row.text.includes("retained-primary")
      ),
    );
    sink.resize(80, 24);
    assert(
      core.snapshot().rowData.some((row) =>
        row.text.includes("retained-primary")
      ),
    );
  } finally {
    core.dispose();
  }
});
