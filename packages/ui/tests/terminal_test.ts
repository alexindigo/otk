// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
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

for (
  const [name, prefix] of [["CSI", "\x1b["], [
    "UTF-8",
    new Uint8Array([0xe2, 0x82]),
  ]] as const
) {
  Deno.test(`checkpoint replacement discards partial ${name} parser state`, async () => {
    const core = await GhosttyTerminalCore.create(80, 24, 7, 14, theme);
    try {
      core.write(prefix);
      core.resetAndWrite("AHello");
      const snapshot = core.snapshot();
      assertEquals(snapshot.rowData[0].text, "AHello");
      assertEquals(snapshot.cursorX, 6);
      assertEquals(snapshot.cursorY, 0);
      core.resetAndWrite("BHello");
      assertEquals(core.snapshot().rowData[0].text, "BHello");
    } finally {
      core.dispose();
    }
  });
}

Deno.test("pinned X10 coordinates survive the user-input adapter as raw bytes", async () => {
  const core = await GhosttyTerminalCore.create(120, 30, 7, 14, theme);
  try {
    core.write("\x1b[?1000h");
    const report = core.encodeMouse({
      action: "press",
      button: 1,
      mods: 0,
      x: 95 * 7,
      y: 0,
      screenWidth: 120 * 7,
      screenHeight: 30 * 14,
      cellWidth: 7,
      cellHeight: 14,
      paddingLeft: 0,
      paddingRight: 0,
      paddingTop: 0,
      paddingBottom: 0,
      anyButtonPressed: true,
    });
    let sent: Uint8Array = new Uint8Array();
    const input = terminalInput((bytes) => sent = bytes);
    input(report, "user");
    assertEquals([...sent], [27, 91, 77, 32, 128, 33]);
  } finally {
    core.dispose();
  }
});

const theme: GhosttyTheme = {
  background: { r: 20, g: 20, b: 20 },
  foreground: { r: 230, g: 230, b: 230 },
  cursor: { r: 255, g: 77, b: 0 },
};

Deno.test("Kitty disambiguation retains supplementary Unicode text", async () => {
  const core = await GhosttyTerminalCore.create(80, 24, 7, 14, theme);
  try {
    core.write("\x1b[>1u");
    const key = String.fromCodePoint(0x1f600);
    const event = {
      key,
      code: "",
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      isComposing: false,
      getModifierState: () => false,
    };
    assertEquals(Reflect.apply(core.encodeKey, core, [event]), key);
  } finally {
    core.dispose();
  }
});

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
    let core: GhosttyTerminalCore | undefined;
    try {
      const terminal = core = await GhosttyTerminalCore.create(
        80,
        24,
        8,
        16,
        theme,
      );
      const sink = terminalSink({
        setSharedGrid: (grid) => {
          if (grid) terminal.resize(grid.cols, grid.rows, 8, 16);
        },
        resetAndWrite: (bytes) => terminal.resetAndWrite(bytes),
        write: (bytes) => terminal.write(bytes),
      }, () => {});
      sink.write(new TextEncoder().encode("\x1b[6n"));
      assert(
        generated.includes("\x1b[1;1R"),
        "WASM really generated a cursor reply",
      );
      generated.length = 0;
      sink.reset(80, 24, new TextEncoder().encode("\x1b[6n"));
      assert(
        generated.includes("\x1b[1;1R"),
        "checkpoint replay generated a fresh reply",
      );
      assertEquals(input, []);
      userInput("echo user\r", "user");
      assertEquals(input.map((bytes) => new TextDecoder().decode(bytes)), [
        "echo user\r",
      ]);
    } finally {
      runtime.attachPtyWriter = attach;
      core?.dispose();
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
    assertEquals(core.selectionText(), "");
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
    assertEquals([core.snapshot().cols, core.snapshot().rows], [120, 40]);
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
    assertEquals([core.snapshot().cols, core.snapshot().rows], [80, 24]);
    assert(
      core.snapshot().rowData.some((row) =>
        row.text.includes("retained-primary")
      ),
    );
  } finally {
    core.dispose();
  }
});

Deno.test("published terminal frames retain their rows and cursor across subsequent snapshots", async () => {
  const core = await GhosttyTerminalCore.create(80, 24, 7, 14, theme);
  try {
    core.write("A");
    const first = core.snapshot();
    core.write("B");
    const next = core.snapshot();
    assertEquals(next.rowData[0].text, "AB");
    assertEquals(first.rowData[0].text, "A");
    assertEquals([first.cursorX, next.cursorX], [1, 2]);
  } finally {
    core.dispose();
  }
});

for (
  const operation of [
    "paste",
    "key",
    "mouse",
    "hyperlink",
    "selection",
    "viewport-to-screen",
    "screen-to-viewport",
  ] as const
) {
  Deno.test(`temporary WASM ${operation} allocations retire when a later allocation throws`, async () => {
    const core = await GhosttyTerminalCore.create(120, 30, 7, 14, theme);
    const runtime = await loadGhosttyRuntime(), call = runtime.call;
    try {
      core.write(
        "\x1b[?1000h\x1b]8;;https://example.test/\x1b\\link\x1b]8;;\x1b\\",
      );
      core.setSelection({ x: 0, y: 0 }, { x: 3, y: 0 });
      for (
        const failAt of operation === "mouse" || operation === "hyperlink"
          ? [1, 2, 3, 4]
          : [1, 2, 3]
      ) {
        let allocations = 0;
        const active = new Map<number, { free: string; size?: number }>();
        runtime.call = function (name, ...args) {
          const free = name === "ghostty_wasm_alloc_u8_array"
            ? "ghostty_wasm_free_u8_array"
            : name === "ghostty_wasm_alloc_usize"
            ? "ghostty_wasm_free_usize"
            : undefined;
          if (free && ++allocations === failAt) {
            throw new Error("injected allocation failure");
          }
          const result = call.call(this, name, ...args);
          if (free && result) {
            active.set(result, {
              free,
              size: name.endsWith("u8_array") ? Number(args[0]) : undefined,
            });
          }
          if (
            name === "ghostty_wasm_free_u8_array" ||
            name === "ghostty_wasm_free_usize"
          ) active.delete(Number(args[0]));
          return result;
        };
        try {
          assertThrows(
            () => {
              if (operation === "paste") core.encodePaste("paste-input");
              else if (operation === "key") {
                Reflect.apply(core.encodeKey, core, [{
                  key: "a",
                  code: "KeyA",
                  getModifierState: () => false,
                }]);
              } else if (operation === "mouse") {
                core.encodeMouse({
                  action: "press",
                  button: 1,
                  mods: 0,
                  x: 7,
                  y: 0,
                  screenWidth: 840,
                  screenHeight: 420,
                  cellWidth: 7,
                  cellHeight: 14,
                  paddingLeft: 0,
                  paddingRight: 0,
                  paddingTop: 0,
                  paddingBottom: 0,
                  anyButtonPressed: true,
                });
              } else if (operation === "hyperlink") core.hyperlinkAt(0, 0);
              else if (operation === "viewport-to-screen") {
                core.viewportPointToScreen(0, 0);
              } else if (operation === "screen-to-viewport") {
                core.screenPointToViewport(0, 0);
              } else core.selectionText();
            },
            Error,
            "injected allocation failure",
          );
          assertEquals(
            active.size,
            0,
            `allocation ${failAt} leaked earlier ${operation} buffers`,
          );
        } finally {
          runtime.call = call;
          // Red proofs must not contaminate the shared real WASM heap.
          for (const [pointer, item] of active) {
            if (item.size === undefined) call.call(runtime, item.free, pointer);
            else call.call(runtime, item.free, pointer, item.size);
          }
        }
      }
    } finally {
      runtime.call = call;
      core.dispose();
    }
  });
}

Deno.test("surface input inventory has one lifecycle admission owner", async () => {
  const source = await Deno.readTextFile(
    new URL("../terminal/ghostty/surface.ts", import.meta.url),
  );
  const calls = [...source.matchAll(/this\.options\.onData\s*\(/g)];
  assertEquals(calls.length, 1, "every input path must use sendInput");
  const owner = source.match(/private sendInput\([\s\S]*?\n {2}}/);
  assert(owner);
  assert(owner[0].includes("this.options.onData("));
  assert(owner[0].includes("this.inputAdmission"));
});
