// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { OpencodeV2ServerAdapter } from "@otk/harness-opencode-v2-server";
import { cfg } from "../support/config.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { serve } from "../support/http.ts";
import { nativeKind } from "../support/native.ts";
import { OpencodeV2Test } from "../support/opencode-v2.ts";
import { waitFor } from "../support/opencode.ts";
import { resources, withResources } from "../support/resources.ts";

Deno.test({
  name: "known V2 deletion confirms without another finite metadata read",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 deletion read independence", async () => {
      const native = await OpencodeV2Test.start(new FakeLlm());
      const target = await native.createSession(
        "Delete without a redundant GET",
      );
      const held = Promise.withResolvers<void>();
      let holding = false, pointReads = 0;
      const proxy = serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        async (request) => {
          const url = new URL(request.url);
          if (
            holding && request.method === "GET" &&
            url.pathname === `/api/session/${target.nativeID}`
          ) {
            pointReads++;
            await held.promise;
          }
          return await fetch(
            new Request(native.url + url.pathname + url.search, request),
          );
        },
      );
      const serviceFile = join(native.root, "delete-service.json");
      const record = JSON.parse(await Deno.readTextFile(native.serviceFile));
      await Deno.writeTextFile(
        serviceFile,
        JSON.stringify({
          ...record,
          url: `http://127.0.0.1:${proxy.addr.port}`,
        }),
        { mode: 0o600 },
      );
      const config = cfg();
      const adapter = new OpencodeV2ServerAdapter({
        serviceFile,
        harness: config.harness,
        messages: config.messages,
        attachments: config.attachments,
      });
      resources().defer("deletion adapter", () => adapter.core.stop());
      await adapter.core.start({
        connection() {},
        indexReset() {},
        indexUpsert() {},
        indexRemove() {},
        content() {},
        bootstrapComplete() {},
        invalidate() {},
      });
      await adapter.core.hydrate!([target.id]);
      holding = true;
      let confirmed = false;
      const removal = adapter.capabilities.sessionActions!.remove(target.id)
        .then(() => {
          confirmed = true;
        });
      try {
        await waitFor(() => confirmed, Boolean, 2000);
        assertEquals(pointReads, 0);
        assertEquals(
          (await native.api.session.list({
            directory: native.directory,
            limit: 200,
          })).data.some((row) => row.id === target.nativeID),
          false,
        );
      } finally {
        held.resolve();
        await removal;
      }
    }),
});
