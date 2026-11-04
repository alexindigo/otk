// SPDX-License-Identifier: LGPL-3.0-only
/** Consume the package-owned Deno producer without private cross-package imports. */
export async function themeManifest(): Promise<unknown> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", "packages/ui/tests/theme-manifest.ts"],
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!output.success) {
    throw new Error("Registered theme manifest producer failed");
  }
  return JSON.parse(new TextDecoder().decode(output.stdout));
}
