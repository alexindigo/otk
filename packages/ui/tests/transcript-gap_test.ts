// SPDX-License-Identifier: LGPL-3.0-only
import { assertMatch } from "@std/assert";

Deno.test("gap block extent uses the shared control token independently of state", async () => {
  const css = await Deno.readTextFile(
    new URL("../components/TranscriptGap.css", import.meta.url),
  );
  assertMatch(
    css,
    /\.otk-transcript-gap\s*\{[^}]*block-size:\s*var\(--control-size\)\s*;/,
  );
});
