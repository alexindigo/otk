// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { FakeLlm } from "./fake-llm.ts";
import { OpencodeTest } from "./opencode.ts";
import { SidecarTest } from "./sidecar.ts";
import { acquire, resources } from "./resources.ts";

/** Native services have one owner, independently of the browser transport. */
export async function nativeFixture(
  permission?: Record<string, "ask" | "allow" | "deny">,
  options?: Parameters<typeof OpencodeTest.start>[2],
) {
  return await acquire("native stack", async () => {
    const scope = resources();
    const fake = new FakeLlm();
    const oc = await OpencodeTest.start(fake, permission, options);
    const logs = Deno.env.get("OTK_TEST_LOG_ROOT") ?? oc.root;
    fake.recordRequests(join(logs, "provider-requests.json"));
    const servers: SidecarTest[] = [];
    let stopping: Promise<void> | undefined;
    scope.evidence("provider evidence", () =>
      Deno.writeTextFile(
        join(oc.root, "provider-requests.json"),
        JSON.stringify(fake.requests, null, 2),
      ));
    for (const [id, provider] of Object.entries(options?.providers ?? {})) {
      provider.fake.recordRequests(
        join(logs, `provider-${encodeURIComponent(id)}-requests.json`),
      );
      scope.evidence(`provider ${id} evidence`, () =>
        Deno.writeTextFile(
          join(oc.root, `provider-${encodeURIComponent(id)}-requests.json`),
          JSON.stringify(provider.fake.requests, null, 2),
        ));
    }
    return {
      fake,
      oc,
      servers,
      async sidecar(overrides: Parameters<typeof SidecarTest.start>[1] = {}) {
        const sidecar = await SidecarTest.start(oc, overrides);
        servers.push(sidecar);
        return sidecar;
      },
      stop(): Promise<void> {
        return stopping ??= (async () => {
          await scope.capture();
          // Admission has ended. Give every independent service its TERM grace
          // together, and join them all before retiring providers or directories.
          await Promise.all([
            ...servers.toReversed().map((server) =>
              scope.observe("sidecar stop", () => server.stop())
            ),
            scope.observe("native stop", () => oc.stop()),
          ]);
          await scope.observe("provider stop", () => fake.stop());
          for (const provider of Object.values(options?.providers ?? {})) {
            await scope.observe(
              "extra provider stop",
              () => provider.fake.stop(),
            );
          }
        })();
      },
    };
  });
}
