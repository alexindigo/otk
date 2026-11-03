// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import type { SessionScale } from "./session-scale.ts";
import { resources } from "./resources.ts";

/** Preserve native stdout before disposable scale roots are retired. */
export function scaleNativeEvidence(native: SessionScale) {
  const root = Deno.env.get("OTK_TEST_LOG_ROOT");
  if (!root) {
    throw new Error("Scale qualification requires a controller evidence owner");
  }
  resources().evidence(
    "scale native output",
    () => Deno.writeTextFile(join(root, "native.log"), native.log),
  );
}
