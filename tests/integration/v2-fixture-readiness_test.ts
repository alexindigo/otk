// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { nativeKind } from "../support/native.ts";
import { bounded, withResources } from "../support/resources.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeV2Test } from "../support/opencode-v2.ts";

Deno.test({
  name:
    "OC2R1 native readiness admits only its own listener and demanded catalogs without a manufactured prompt",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 readiness", async () => {
      const fake = new FakeLlm(), original = globalThis.fetch;
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      let returned = false;
      globalThis.fetch = async (input, init) => {
        const response = await original(input, init);
        if (
          new URL(input instanceof Request ? input.url : String(input))
            .pathname === "/api/agent"
        ) {
          entered.resolve();
          await release.promise;
        }
        return response;
      };
      const starting = OpencodeV2Test.start(fake).then((fixture) => {
        returned = true;
        return fixture;
      });
      try {
        await bounded("V2 demanded catalog admission", entered.promise, 30_000);
        await Promise.resolve();
        assertEquals(
          returned,
          false,
          "HTTP listening is not catalog readiness",
        );
        release.resolve();
        const fixture = await starting;
        assert(
          fixture.log.split(/\r?\n/).some((line) =>
            /^server listening on http:\/\/127\.0\.0\.1:\d+$/.test(line)
          ),
        );
        assertEquals(
          (await fixture.api.server.info()).pid,
          fixture.process.pid,
        );
        assert(
          (await fixture.api.model.list({
            location: { directory: fixture.directory },
          })).data.some((model) => model.providerID === "fake"),
        );
        assertEquals(
          fake.requests,
          [],
          "Readiness must not manufacture an LLM prompt",
        );
        await assertRejects(
          () => Deno.stat(fixture.root + "/config/opencode/node_modules"),
          Deno.errors.NotFound,
        );
        await fixture.stop();
      } finally {
        release.resolve();
        globalThis.fetch = original;
        await starting.then((fixture) => fixture.stop());
      }
    }),
});
