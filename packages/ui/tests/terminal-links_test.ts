// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
} from "../terminal/ghostty/terminal-links.ts";
import { ghosttyUnshiftedCodepoint } from "../terminal/ghostty/keyCodes.ts";

Deno.test("terminal links trim mixed closing delimiters while retaining balanced URL delimiters", () => {
  assertEquals(
    extractTerminalLinks("[(https://example.test/docs)]").map((link) =>
      link.text
    ),
    ["https://example.test/docs"],
  );
  assertEquals(
    extractTerminalLinks("https://example.test/a(b)").map((link) => link.text),
    ["https://example.test/a(b)"],
  );
  assertEquals(
    extractTerminalLinks("https://example.test/a" + ")]}".repeat(10000)).map((
      link,
    ) => link.text),
    ["https://example.test/a"],
  );
});

Deno.test("offscreen wrapped continuation retains visible separators after a URL", () => {
  const line = collectWrappedTerminalLinkLine(1, (index) =>
    index === 0
      ? {
        isWrapped: false,
        wrapsToNext: true,
        translateToString: (trim = false) =>
          trim ? "https://example.test/" : "https://example.test/   ",
      }
      : undefined);
  assertEquals(line?.text, "https://example.test/   ");
});

Deno.test("US punctuation fallback requires an agreeing physical code", () => {
  assertEquals(
    ghosttyUnshiftedCodepoint({ key: '"', code: "Quote", shiftKey: true }),
    39,
  );
  assertEquals(
    ghosttyUnshiftedCodepoint({ key: '"', code: "Digit2", shiftKey: true }),
    0,
  );
  assertEquals(
    ghosttyUnshiftedCodepoint({ key: '"', code: "Digit2", shiftKey: true }, {
      get: () => "2",
    }),
    50,
  );
});
