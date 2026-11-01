// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { FakeLlm } from "../support/fake-llm.ts";
import { tempDir, test } from "../support/resources.ts";
import { SessionScale } from "../support/session-scale.ts";
import { servingProbe } from "../support/serving-probe.ts";

test("scale generation refuses escaped or existing destinations before native admission", async () => {
  const root = await tempDir("scale-boundary-"), fake = new FakeLlm();
  const existing = join(root, "existing");
  await Deno.mkdir(existing);
  await Deno.writeTextFile(join(existing, "keep.txt"), "untouched");
  await assertRejects(
    () => SessionScale.create(join(root, "..", "escaped-scale"), root, fake),
    Error,
    "inside the supplied",
  );
  await assertRejects(
    () => SessionScale.create(existing, root, fake),
    Deno.errors.AlreadyExists,
  );
  const outside = await tempDir("scale-outside-");
  await Deno.symlink(outside, join(root, "link"));
  await assertRejects(
    () => SessionScale.create(join(root, "link", "escaped"), root, fake),
    Error,
    "inside the supplied",
  );
  assertEquals([...Deno.readDirSync(outside)], []);
  assertEquals(
    await Deno.readTextFile(join(existing, "keep.txt")),
    "untouched",
  );
  assertEquals([...Deno.readDirSync(existing)].map((entry) => entry.name), [
    "keep.txt",
  ]);
});

test("serving-isolate timing control detects a real synchronous block", async () => {
  const probe = servingProbe();
  await new Promise((r) => setTimeout(r, 10));
  const until = performance.now() + 65;
  while (performance.now() < until) { /* deliberate negative control */ }
  await new Promise((r) => setTimeout(r, 10));
  probe.stop();
  assert(
    probe.samples.some((sample) => sample.ms >= 50),
    "The control must observe its deliberate block",
  );
  probe.assert();
});
