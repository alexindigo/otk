// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import { profiles, request } from "../support/fixture-control.ts";

function start(profile: unknown, version: unknown) {
  return request({
    v: 1,
    id: "admission",
    command: "start",
    params: { profile, version },
  });
}

Deno.test("fixture admission preserves every behavior profile on both native lanes", () => {
  for (const profile of Object.keys(profiles)) {
    for (const version of ["1.18.34", "1.19.3", "2.2.6"]) {
      assertEquals<unknown>(start(profile, version).params, {
        profile,
        version,
      });
    }
  }
});

Deno.test("fixture admission retains native dependencies even within contract families", () => {
  for (
    const profile of [
      "ordinary",
      "contract-composer-native-null",
      "contract-messages-metadata",
      "contract-messages-recorded-files",
      "contract-messages-recorded-tools",
      "contract-attention-native",
      "contract-attention-auto",
      "contract-attention-remote",
      "contract-themes",
      "contract-load-small",
      "contract-load-large",
      "contract-scale-request",
      "contract-scale-heap",
      "contract-scale-runtime",
      "contract-scale-scroll",
      "contract-scale-paint",
      "contract-scale-sessions",
      "contract-scale-files",
    ]
  ) {
    assertEquals(profiles[profile as keyof typeof profiles], "v1");
    assertEquals<unknown>(start(profile, "2.2.6").params, {
      profile,
      version: "2.2.6",
    });
  }
});

Deno.test("fixture admission rejects unknown profiles and malformed or unsupported versions", () => {
  for (
    const profile of ["contract-unregistered", "__proto__", "toString", null, 1]
  ) {
    assertThrows(
      () => start(profile, "2.2.6"),
      Error,
      "Unknown scenario profile",
    );
  }
  for (
    const version of [
      "0.1.0",
      "3.0.0",
      "2.2",
      "2.2.6-dev",
      "v2.2.6",
      2,
      null,
      "2.2.6\n",
    ]
  ) {
    assertThrows(
      () => start("contract-core", version),
      Error,
      "Invalid version",
    );
  }
});
