// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  OpencodeV2ServerAdapter,
  opencodeV2SessionID as ids,
} from "@otk/harness-opencode-v2-server";
import type { ContentSession, OperationContext } from "@otk/protocol";
import { cfg } from "../support/config.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { nativeKind } from "../support/native.ts";
import { OpencodeV2Test } from "../support/opencode-v2.ts";
import { resources, withResources } from "../support/resources.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { WsClient } from "../support/ws-client.ts";

Deno.test({
  name:
    "OC2N1 session creation preserves location, title, child identity and pre-dispatch validation through adapter and OTK RPC",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 session creation", async () => {
      const fake = new FakeLlm(),
        native = await OpencodeV2Test.start(fake),
        settings = cfg();
      const observed: string[] = [];
      const adapter = new OpencodeV2ServerAdapter({
        serviceFile: native.serviceFile,
        harness: settings.harness,
        messages: settings.messages,
      });
      resources().defer("creation adapter", () => adapter.core.stop());
      await adapter.core.start({
        connection() {},
        indexReset() {},
        indexUpsert(row) {
          observed.push(row.id);
        },
        indexRemove() {},
        content() {},
        bootstrapComplete() {},
        invalidate() {},
      });
      let effects = 0;
      const operation: OperationContext = {
        signal: new AbortController().signal,
        key: {
          key: crypto.randomUUID(),
          clientID: crypto.randomUUID(),
          window: crypto.randomUUID(),
        },
        progress() {},
        beforeEffect: () => {
          effects++;
          return Promise.resolve();
        },
        checkpoint: () => Promise.resolve(),
        wait: (pending) => pending,
      };
      const parent = await adapter.core.createSession({
        directory: native.directory,
        title: "Created in OTK",
      }, operation);
      assertEquals(effects, 1);
      assertEquals(parent.title, "Created in OTK");
      assertEquals(parent.directory, native.directory);
      assertEquals(parent.parentID, undefined);
      assert(observed.includes(parent.id));
      const rawParent = await native.api.session.get({
        sessionID: ids.decode(parent.id),
      });
      assertEquals(rawParent.title, parent.title);
      assertEquals(rawParent.location.directory, native.directory);
      const child = await adapter.core.createSession({
        directory: native.directory,
        title: "Created child",
        parentID: parent.id,
      }, operation);
      assertEquals(effects, 2);
      assertEquals(child.parentID, parent.id);
      assertEquals(child.directory, native.directory);
      assertEquals(
        (await native.api.session.get({ sessionID: ids.decode(child.id) }))
          .parentID,
        rawParent.id,
      );
      const before = (await native.listSessions()).map((row) => row.id).sort();
      await assertRejects(
        () =>
          adapter.core.createSession({
            directory: native.root,
            parentID: parent.id,
          }, operation),
        Error,
        "must match its parent",
      );
      assertEquals(
        effects,
        2,
        "directory mismatch must reject before native effect dispatch",
      );
      const controller = new AbortController();
      controller.abort();
      await assertRejects(() =>
        adapter.core.createSession({
          directory: native.directory,
          title: "Cancelled",
        }, { ...operation, signal: controller.signal })
      );
      assertEquals(effects, 2);
      assertEquals(
        (await native.listSessions()).map((row) => row.id).sort(),
        before,
      );
      const app = await SidecarTest.start(native),
        client = new WsClient(app.url);
      await client.connect(native.directory);
      const fromRpc = await client.rpc<ContentSession>("session.create", {
        directory: native.directory,
        title: "RPC creation",
      });
      assertEquals(fromRpc.directory, native.directory);
      assertEquals(
        (await native.api.session.get({ sessionID: ids.decode(fromRpc.id) }))
          .title,
        "RPC creation",
      );
      assertEquals(
        fake.requests,
        [],
        "session creation must not manufacture a model prompt",
      );
      await client.close();
    }),
});
