// SPDX-License-Identifier: LGPL-3.0-only
/** One native fixture selection, shared by processes, readiness and package caches. */
export const nativeBinary = Deno.env.get("OTK_TEST_OPENCODE") ??
  "/usr/local/bin/opencode";
const result = await new Deno.Command(nativeBinary, {
  args: ["--version"],
  signal: AbortSignal.timeout(15_000),
}).output();
export const nativeVersion = new TextDecoder().decode(result.stdout).trim();
if (!result.success || !/^1\.\d+\.\d+$/.test(nativeVersion)) {
  throw new Error(
    `Invalid native fixture version from ${nativeBinary}: ${nativeVersion}\n${
      new TextDecoder().decode(result.stderr)
    }`,
  );
}
