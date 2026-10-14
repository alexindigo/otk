// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStringIncludes } from "@std/assert";

Deno.test("native initialization releases interrupted delivery and errors without poisoning reacquisition", async () => {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-net",
      "--allow-env",
      new URL(
        "../../support/highlight-initialization-probe.ts",
        import.meta.url,
      )
        .href,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const output = new TextDecoder().decode(result.stdout),
    errors = new TextDecoder().decode(result.stderr);
  assertEquals(result.code, 0, output + errors);
  for (
    const mode of [
      "interrupted",
      "delivery-error",
      "http-error",
      "compile-error",
      "instantiate-error",
    ]
  ) {
    assertStringIncludes(output, `INITIALIZATION ${mode} observed`);
    assertStringIncludes(output, `INITIALIZATION ${mode} terminated`);
  }
  assertEquals(output.match(/INITIALIZATION ready observed/g)?.length, 5);
  assertStringIncludes(output, "INITIALIZATION_ALL_OBSERVED");
  console.log(output.trim());
});
