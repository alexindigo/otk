// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assertEquals } from "@std/assert";
import { Opencode1Adapter, type Opencode1Config } from "@otk/harness-opencode1";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeTest } from "../support/opencode.ts";
import { listSessions } from "./harness-consumer.ts";

test("standalone harness consumer lists stock-server sessions without a sidecar", async () => {
  const fake = new FakeLlm();
  const oc = await OpencodeTest.start(fake);
  const config: Opencode1Config = {
    harness: {
      url: oc.url,
      username: "opencode",
      password: "",
      db: oc.db,
      heartbeattimeout: 25,
      reconnectmax: 30,
    },
    index: { days: 30 },
  };
  const seed = new Opencode1Adapter(config);
  try {
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
    const entries = await listSessions(config);
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
