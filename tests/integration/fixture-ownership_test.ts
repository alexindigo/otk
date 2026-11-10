// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { tempDir, test } from "../support/resources.ts";

test("controller records ownership even when profile admission fails before acquiring a native", async () => {
  const root = await tempDir("controller-admission-"),
    record = join(root, "owned.json");
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "tests/support/fixture-controller.ts"],
    env: { OTK_TEST_CONTROLLER_RECORD: record },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        id: "reject",
        command: "start",
        params: { profile: "not-a-profile", version: "2.2.6" },
      }) + "\n",
    ),
  );
  await writer.close();
  const result = await child.output();
  const frame = JSON.parse(new TextDecoder().decode(result.stdout));
  assertEquals(frame.ok, false);
  assertEquals(frame.error.message, "Unknown scenario profile");
  assertEquals(JSON.parse(await Deno.readTextFile(record)), {
    pids: [child.pid],
    ports: [],
  });
});
