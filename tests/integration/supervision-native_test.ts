// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { InboxBaseline } from "@otk/protocol";
import { FakeLlm } from "../support/fake-llm.ts";
import { nativeKind } from "../support/native.ts";
import { OpencodeV2Test } from "../support/opencode-v2.ts";
import { OpencodeTest, waitFor } from "../support/opencode.ts";
import { resources, withResources } from "../support/resources.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { WsClient } from "../support/ws-client.ts";

Deno.test("supervision imports pre-OTK native finishes without body demand or native-view acknowledgement", () =>
  withResources("supervision cold native history", async () => {
    const fake = new FakeLlm();
    const native = nativeKind === "opencode-v2-server"
      ? await OpencodeV2Test.start(fake)
      : await OpencodeTest.start(fake);
    const target = await native.createSession("Finished before OTK exists");
    fake.queue({ chunks: ["Completed before OTK"] });
    await native.prompt(target.id, "Finish before the first OTK run");
    if (native instanceof OpencodeV2Test) {
      const raw = await waitFor(
        () => native.api.session.get({ sessionID: target.nativeID }),
        (row) => !!row.time.idle,
      );
      await native.api.session.view({
        sessionID: target.nativeID,
        idle: raw.time.idle!,
      });
    } else {
      await waitFor(
        () => native.request<Record<string, unknown>>("/session/status"),
        (rows) => !rows[target.nativeID],
      );
    }
    const shell = await native.createSession(
      "Shell finished before OTK exists",
    );
    if (native instanceof OpencodeV2Test) {
      await native.nativeApi.session.shell({
        sessionID: shell.nativeID,
        command: "printf historical-shell",
      });
      assertEquals(
        (await native.api.session.get({ sessionID: shell.nativeID })).time.idle,
        undefined,
      );
    } else {
      await native.request(`/session/${shell.id}/shell`, {
        method: "POST",
        body: { agent: "build", command: "printf historical-shell" },
      });
    }
    const app = await SidecarTest.start(native, { digest: { idlems: 60000 } });
    const client = new WsClient(app.url);
    await client.connect();
    const inbox = async () =>
      (await client.rpc<InboxBaseline>("inbox.get", {})).inbox;
    await waitFor(
      inbox,
      (value) => value.summaries?.[native.directory]?.status === "finished",
    );
    client.lease({ directory: native.directory, crumbs: [], rows: [] });
    const finished = await waitFor(
      inbox,
      (value) =>
        value.supervision?.[target.id]?.state === "finishedUnseen" &&
        value.supervision?.[shell.id]?.state === "finishedUnseen",
    );
    const terminal = finished.supervision![target.id].terminal;
    assert(terminal > 0);
    assertEquals(finished.summaries?.[native.directory]?.status, "finished");
    if (native instanceof OpencodeV2Test) {
      const raw = await native.api.session.get({ sessionID: target.nativeID });
      await native.api.session.view({
        sessionID: target.nativeID,
        idle: raw.time.idle!,
      });
      assert(
        (await native.api.session.get({ sessionID: target.nativeID })).time
          .viewed,
      );
      // Round-trip through OTK after the native mutation. Native viewed is not an
      // OTK acknowledgement, before or after this server's first startup.
      const after = await inbox();
      assertEquals(after.supervision?.[target.id], {
        state: "finishedUnseen",
        terminal,
      });
    }
  }));

Deno.test("supervision failed subagents and parent executions are terminal native history, never working", () =>
  withResources("supervision provider usage limit", async () => {
    const fake = new FakeLlm();
    const v2 = nativeKind === "opencode-v2-server";
    fake.queue({
      tool: {
        name: v2 ? "subagent" : "task",
        input: {
          description: "Usage limit child",
          prompt: "Report the provider limit",
          ...(v2
            ? { agent: "explore", background: true }
            : { subagent_type: "general" }),
        },
      },
    });
    fake.failRemaining("The usage limit has been reached");
    const native = v2
      ? await OpencodeV2Test.start(fake)
      : await OpencodeTest.start(fake);
    const parent = await native.createSession("Parent provider limit");
    const app = await SidecarTest.start(native, { digest: { idlems: 60000 } });
    const client = new WsClient(app.url);
    resources().defer("provider limit socket", () => client.close());
    await client.connect(native.directory);
    await native.prompt(parent.id, "Delegate, then report the result");
    const children = await waitFor(async () => {
      const sessions = await native.listSessions(20);
      return sessions.filter((session) => session.id !== parent.id);
    }, (rows) => rows.length > 0);
    const child = children[0];
    const value = await waitFor(
      async () => (await client.rpc<InboxBaseline>("inbox.get", {})).inbox,
      (inbox) =>
        [parent.id, child.id].every((id) =>
          inbox.supervision?.[id]?.state === "finishedUnseen"
        ),
    );
    for (const id of [parent.id, child.id]) {
      assert(value.supervision![id].terminal > 0);
      assertEquals(value.supervision![id].state, "finishedUnseen");
    }
    assertEquals(value.summaries?.[native.directory]?.status, "finished");
  }));

Deno.test({
  name:
    "supervision V2 seeds executions shells and pending inputs, and disconnect retires their freshness",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("supervision V2 independent inventories", async () => {
      const fake = new FakeLlm();
      const held = fake.queueHeld({ chunks: ["Fresh owned execution"] });
      const native = await OpencodeV2Test.start(fake);
      const execution = await native.createSession("Execution inventory");
      const shellOwner = await native.createSession("Shell inventory");
      const input = await native.createSession("Pending input inventory");
      await native.prompt(execution.id, "Remain active before OTK starts");
      const shellRun = native.nativeApi.session.shell({
        sessionID: shellOwner.nativeID,
        command: "sleep 120",
      });
      void shellRun.catch(() => {});
      resources().defer("independent shell cleanup", async () => {
        for (
          const shell of (await native.nativeApi.shell.list({
            location: { directory: native.directory },
          })).data
        ) {
          await native.nativeApi.shell.remove({
            id: shell.id,
            location: { directory: native.directory },
          });
        }
        await shellRun.catch(() => {});
        held.release();
      });
      await waitFor(
        () =>
          native.nativeApi.shell.list({
            location: { directory: native.directory },
          }),
        (rows) => rows.data.length === 1,
      );
      await native.nativeApi.session.form.create({
        sessionID: input.nativeID,
        title: "Pending before OTK",
        fields: [{ key: "ok", type: "boolean", title: "OK" }],
      });
      const app = await SidecarTest.start(native, {
        digest: { idlems: 60000 },
      });
      const client = new WsClient(app.url);
      client.lease({
        directory: native.directory,
        crumbs: [],
        rows: [execution.id, shellOwner.id, input.id],
      });
      await client.connect();
      const states = async () =>
        (await client.rpc<InboxBaseline>("inbox.get", {})).inbox.supervision ??
          {};
      await waitFor(
        states,
        (rows) =>
          rows[execution.id]?.state === "working" &&
          rows[shellOwner.id]?.state === "working" &&
          rows[input.id]?.state === "needsYou",
      );
      native.proxy.freeze();
      native.proxy.disconnect();
      await waitFor(
        states,
        (rows) =>
          [execution.id, shellOwner.id, input.id].every((id) =>
            rows[id]?.state === "none"
          ),
      );
      native.proxy.thaw();
      await waitFor(
        states,
        (rows) =>
          rows[execution.id]?.state === "working" &&
          rows[shellOwner.id]?.state === "working" &&
          rows[input.id]?.state === "needsYou",
      );
    }),
});
