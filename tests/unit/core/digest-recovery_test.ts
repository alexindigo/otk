// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DigestBridge } from "../../../core/digest/bridge.ts";
import { cfg } from "../../support/config.ts";
import { FakeLlm } from "../../support/fake-llm.ts";
import { nativeKind } from "../../support/native.ts";
import { OpencodeV2Test } from "../../support/opencode-v2.ts";
import { waitFor } from "../../support/opencode.ts";
import { resources, tempDir, withResources } from "../../support/resources.ts";

Deno.test({
  name:
    "worker failure revalidates previously published V2 keys without population catalog admission",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("worker key reconciliation", async () => {
      const native = await OpencodeV2Test.start(new FakeLlm()),
        target = await native.createSession("Retained ready key"),
        settings = cfg();
      let revision = -1, ready = false, faults = 0;
      const bridge = new DigestBridge({
        statePath: await tempDir("recovery-state-"),
        provider: native.kind,
        native: {
          serviceFile: native.serviceFile,
          db: native.db,
          requestms: settings.harness.requestms,
          attachments: settings.attachments,
        },
        policy: { ...settings.digest, cpu: 1, idlems: 1, retryms: 10 },
        publish: (value) => {
          if (value.sessionID === target.id) {
            revision = value.revision;
            ready = value.delta.summary.state === "ready";
          }
        },
        diagnostic() {},
        unready: (ids) => {
          assertEquals(ids, [target.id]);
          faults++;
          ready = false;
          bridge.release("fault");
        },
      });
      resources().defer("recovery bridge", () => bridge.stop());
      bridge.scope("viewer", { sessions: [target.id] });
      await bridge.start();
      assertEquals(
        (await bridge.catalog(1, new AbortController().signal)).entries,
        [],
      );
      await bridge.hydrate([target.id], new AbortController().signal);
      await waitFor(() => ready, Boolean);
      const before = revision;
      Reflect.apply(bridge.scope, bridge, ["fault", { sessions: undefined }]);
      await waitFor(() => faults, (value) => value === 1);
      await waitFor(() => ({ ready, revision }), (value) =>
        value.ready && value.revision > before);
      assertEquals(faults, 1);
    }),
});
