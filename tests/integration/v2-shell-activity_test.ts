// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { OpencodeV2ServerAdapter } from "@otk/harness-opencode-v2-server";
import { OperationFailure, type SessionMetadata } from "@otk/protocol";
import { cfg } from "../support/config.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeV2Test } from "../support/opencode-v2.ts";
import { nativeKind } from "../support/native.ts";
import { resources, withResources } from "../support/resources.ts";
import { waitFor } from "../support/opencode.ts";

Deno.test({
  name:
    "OC2S1 unsubscribed native shells remain busy across reconnect and interrupt stops only the asking session",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 independent shell activity", async () => {
      const native = await OpencodeV2Test.start(new FakeLlm());
      const target = await native.createSession("Shell owner"),
        other = await native.createSession("Unrelated shell");
      const settings = cfg(), entries = new Map<string, SessionMetadata>();
      let boots = 0;
      const adapter = new OpencodeV2ServerAdapter({
        serviceFile: native.serviceFile,
        harness: settings.harness,
        messages: settings.messages,
      });
      resources().defer("shell activity adapter", () => adapter.core.stop());
      await adapter.core.start({
        connection() {},
        indexReset() {},
        indexRemove() {},
        content() {},
        invalidate() {},
        bootstrapComplete() {
          boots++;
        },
        indexUpsert(entry) {
          entries.set(entry.id, entry);
        },
      });
      const running = adapter.capabilities.shell!.shell({
        sessionID: target.id,
        command:
          "printf 'started'; sleep 120; printf 'survived' > interrupted-shell-survived.txt",
      });
      const unrelated = native.nativeApi.session.shell({
        sessionID: other.nativeID,
        command: "sleep 120",
      });
      void running.catch(() => {});
      void unrelated.catch(() => {});
      try {
        await waitFor(() => entries.get(target.id)?.status, (status) =>
          status === "busy");
        await waitFor(() =>
          entries.get(other.id)?.status, (status) =>
          status === "busy");
        assertEquals(
          (await native.api.session.active())[target.nativeID],
          undefined,
        );
        const before = boots;
        native.proxy.disconnect();
        await waitFor(() =>
          boots, (count) =>
          count > before);
        assertEquals(entries.get(target.id)?.status, "busy");
        await adapter.capabilities.prompt!.abort(target.id);
        // Deliberately dropping the proxy also loses the submitting HTTP reply.
        // Its uncertainty must not hide or prevent interruption of native work.
        const outcome = await running.then(() => undefined, (error) => error);
        assert(outcome instanceof OperationFailure);
        assertEquals(outcome.outcome, "unknown");
        await waitFor(() =>
          entries.get(target.id)?.status, (status) =>
          status === "idle");
        const remaining = (await native.api.shell.list({
          location: { directory: native.directory },
        })).data;
        assertEquals(
          remaining.map((shell) =>
            shell.metadata.sessionID
          ),
          [other.nativeID],
        );
        assertEquals(entries.get(other.id)?.status, "busy");
        assert(
          !(await native.api.message.list({ sessionID: target.nativeID })).data
            .some((message) => message.type === "assistant"),
        );
        let survived = true;
        try {
          await Deno.stat(native.directory + "/interrupted-shell-survived.txt");
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) survived = false;
          else throw error;
        }
        assertEquals(survived, false);
      } finally {
        for (
          const shell of (await native.api.shell.list({
            location: { directory: native.directory },
          })).data
        ) {
          await native.api.shell.remove({
            id: shell.id,
            location: { directory: native.directory },
          });
        }
        await Promise.allSettled([running, unrelated]);
      }
    }),
});
