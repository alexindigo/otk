// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assertEquals } from "@std/assert";
import { FakeLlm } from "../support/fake-llm.ts";
import {
  nativeHarness,
  selectedNative,
  startHarness,
} from "../support/native-testing.ts";
import { listSessions } from "./harness-consumer.ts";

test("standalone harness consumer lists stock-server sessions without a sidecar", async () => {
  const fake = new FakeLlm();
  const oc = await selectedNative(fake);
  const seed = nativeHarness(oc);
  try {
    await startHarness(seed);
    const parent = await seed.core.createSession({
      directory: oc.directory,
      title: "Standalone parent",
    });
    const child = await seed.core.createSession({
      directory: oc.directory,
      title: "Standalone child",
      parentID: parent.id,
    });
    assertEquals(
      (await seed.core.listChildren(parent.id)).map((session) => session.id),
      [child.id],
    );
    const entries = await listSessions(nativeHarness(oc), oc.directory);
    assertEquals(
      entries.map((entry) => entry.id).sort(),
      [parent.id, child.id].sort(),
    );
    assertEquals(
      entries.find((entry) => entry.id === parent.id)?.title,
      "Standalone parent",
    );
    assertEquals(
      entries.find((entry) => entry.id === child.id)?.parentID,
      parent.id,
    );
    assertEquals(
      entries.every((entry) => entry.directory === oc.directory),
      true,
    );
  } finally {
    await seed.core.stop();
    await oc.stop();
    await fake.stop();
  }
});
