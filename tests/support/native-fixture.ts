// SPDX-License-Identifier: LGPL-3.0-only
import { FakeLlm } from "./fake-llm.ts";
import { join } from "@std/path";
import { SidecarTest } from "./sidecar.ts";
import { acquire, resources } from "./resources.ts";
import { nativeKind } from "./native.ts";
import { OpencodeTest } from "./opencode.ts";
import { OpencodeV2Test } from "./opencode-v2.ts";

/** Semantic native fixture seam. Native shapes stay in version-specific tests. */
export interface NativeFixture {
  readonly kind: "opencode-v1" | "opencode-v2-server";
  readonly version: string;
  readonly root: string;
  readonly directory: string;
  readonly url: string;
  readonly db: string;
  readonly discoveryEnv: Record<string, string>;
  createSession(title?: string): Promise<{ id: string; nativeID: string }>;
  listSessions(limit?: number): Promise<{ id: string; nativeID: string }[]>;
  readSession(id: string): Promise<unknown>;
  readMessages(id: string, limit?: number): Promise<unknown>;
  prompt(id: string, text: string): Promise<unknown>;
  interrupt(id: string): Promise<unknown>;
  listPermissions(id: string): Promise<{ id: string; sessionID: string }[]>;
  replyPermission(
    id: string,
    requestID: string,
    decision: "once" | "always" | "reject",
    message?: string,
  ): Promise<unknown>;
  stageRevert(id: string, messageID: string, files: boolean): Promise<unknown>;
  restore(id: string): Promise<unknown>;
  listForms?(id: string): Promise<{ id: string; sessionID: string }[]>;
  answerForm?(
    id: string,
    formID: string,
    answer: Record<string, string | number | boolean | string[]>,
  ): Promise<unknown>;
  stop(): Promise<void>;
}
export function startNative(provider: FakeLlm): Promise<NativeFixture> {
  return nativeKind === "opencode-v2-server"
    ? OpencodeV2Test.start(provider)
    : OpencodeTest.start(provider);
}

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
