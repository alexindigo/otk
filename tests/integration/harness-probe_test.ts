// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { selectHarness } from "../../harness-selection.ts";
import { cfg } from "../support/config.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { startNative } from "../support/native-fixture.ts";
import { nativeKind, nativeVersion } from "../support/native.ts";
import { withResources } from "../support/resources.ts";

Deno.test("automatic adapter selection observes the exact stock native version", () =>
  withResources("native selection", async () => {
    const fixture = await startNative(new FakeLlm());
    const config = { ...cfg().harness, type: "auto", url: fixture.url };
    const selected = await selectHarness(config, {
      HOME: fixture.root,
      ...fixture.discoveryEnv,
    });
    assertEquals(selected.kind, nativeKind);
    assertEquals(
      selected.kind === "opencode-v1"
        ? selected.version
        : selected.service.version,
      nativeVersion,
    );
    const created = await fixture.createSession("Semantic fixture probe");
    assertEquals(
      (await fixture.listSessions()).some((row) => row.id === created.id),
      true,
    );
    assertEquals(
      JSON.stringify(await fixture.readSession(created.id)).includes(
        created.nativeID,
      ),
      true,
    );
    assertEquals(await fixture.listPermissions(created.id), []);
  }));
