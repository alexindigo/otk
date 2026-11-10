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

Deno.test("fixture admission preserves every V1 profile and admits only neutral V2 scenes", () => {
  for (const [profile, backend] of Object.entries(profiles)) {
    for (const version of ["1.18.34", "1.19.3"]) {
      assertEquals<unknown>(start(profile, version).params, {
        profile,
        version,
      });
    }
    if (backend === "neutral") {
      assertEquals<unknown>(start(profile, "2.2.6").params, {
        profile,
        version: "2.2.6",
      });
    } else {
      assertThrows(
        () => start(profile, "2.2.6"),
        Error,
        "Scenario requires opencode V1",
      );
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
    assertThrows(
      () => start(profile, "2.2.6"),
      Error,
      "Scenario requires opencode V1",
    );
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
