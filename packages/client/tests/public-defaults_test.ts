// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { publicDefaultsFrom } from "../public-defaults.ts";

Deno.test("public defaults reader keeps the allowlisted port without a fallback table", () => {
  assertEquals(publicDefaultsFrom({ defaultPort: 43210, private: "secret" }), {
    defaultPort: 43210,
  });
  for (
    const value of [
      undefined,
      null,
      {},
      { defaultPort: "43210" },
      { defaultPort: 0 },
      { defaultPort: -1 },
      { defaultPort: 1.5 },
      { defaultPort: NaN },
    ]
  ) {
    assertEquals(publicDefaultsFrom(value), undefined);
  }
});
