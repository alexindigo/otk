// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { nativeListeningURL } from "../support/native-announcement.ts";

Deno.test("listener announcements are exact and selected by native protocol", () => {
  for (const kind of ["opencode-v1", "opencode-v2-server"] as const) {
    const own = kind === "opencode-v1" ? "opencode server" : "server";
    const other = kind === "opencode-v1" ? "server" : "opencode server";
    assertEquals(
      nativeListeningURL(`${own} listening on http://127.0.0.1:1234\r\n`, kind),
      "http://127.0.0.1:1234",
    );
    for (
      const line of [
        `${other} listening on http://127.0.0.1:1234`,
        `${own} listening on http://127.0.0.1:1234 extra`,
        `log: ${own} listening on http://127.0.0.1:1234`,
        `${own} listening on http://127.0.0.1:not-a-port`,
      ]
    ) {
      assertEquals(nativeListeningURL(line, kind), undefined);
    }
  }
});
