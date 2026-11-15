// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { createTranscriptProjection } from "@otk/client";
import { OpencodeV2ServerAdapter } from "@otk/harness-opencode-v2-server";
import type { PluginStorage } from "@otk/harness";
import { OtkDb, pluginStorageMigrations, PluginStore } from "@otk/store";
import type { Message, MessagePage } from "@otk/protocol";
import { cfg } from "../support/config.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeV2Test } from "../support/opencode-v2.ts";
import { nativeKind } from "../support/native.ts";
import { waitFor } from "../support/opencode.ts";
import { resources, withResources } from "../support/resources.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { WsClient } from "../support/ws-client.ts";

Deno.test({
  name: "FX25 one native selection failure follows its queued causal prompt",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("FX25 causal failure", async () => {
      const native = await OpencodeV2Test.start(new FakeLlm());
      const target = await native.createSession();
      const observed = await application(native, target.id);
      await native.api.session.switchAgent({
        sessionID: target.nativeID,
        agent: "missing-fx25-agent",
      });
      await native.api.session.prompt({
        sessionID: target.nativeID,
        text: "Fail at native selection",
      });
      const snapshot = await waitFor(() => observed.page(), (page) =>
        page.items.some((m) =>
          m.parts.some((p) =>
            p.kind === "external" && p.failure
          )
        ));
      const failure = snapshot.items.filter((m) =>
        m.parts.some((p) => p.kind === "external" && p.failure)
      );
      assertEquals(failure.length, 1);
      const prompt = snapshot.items.find((m) => m.role === "user")!;
      assert(prompt);
      assertEquals(
        failure[0].role === "context" && failure[0].replyTo,
        prompt.id,
      );
      const projection = createTranscriptProjection();
      projection.replace(snapshot.items);
      assert(
        projection.state.replyIDs.indexOf(prompt.id) <
          projection.state.replyIDs.indexOf(`reply:${prompt.id}`),
      );
    }),
});

/** Exact record equality: identity, role, time and every part field. Helper
 * progress is independently refreshed derived metadata (its own revision and
 * readiness), so it is the only field outside this oracle. */
function presentation(message: Message) {
  return JSON.parse(
    JSON.stringify({
      id: message.id,
      role: message.role,
      time: message.time,
      parts: message.parts,
    }),
    (key, value) =>
      key === "progress" && value && typeof value === "object" &&
        "revision" in value
        ? undefined
        : value,
  );
}
/** Adapter-only observer for plugin restart, where no parity is compared. */
async function observe(
  native: OpencodeV2Test,
  sid: string,
  storage?: PluginStorage,
) {
  const config = cfg(),
    projection = createTranscriptProjection(),
    connections: string[] = [],
    errors: unknown[] = [];
  const adapter = new OpencodeV2ServerAdapter(
    {
      serviceFile: native.serviceFile,
      harness: config.harness,
      messages: config.messages,
    },
    undefined,
    (error) => errors.push(error),
  );
  if (storage) adapter.storage(storage);
  resources().defer("NT3 adapter", () => adapter.core.stop());
  await adapter.core.start({
    connection: (s) => connections.push(s),
    indexReset() {},
    indexUpsert() {},
    indexRemove() {},
    bootstrapComplete() {},
    invalidate() {},
    content: (_id, op) => projection.apply(op),
  });
  adapter.core.subscriptions(sid, 1);
  projection.replace((await adapter.core.listMessages(sid, {})).items);
  return { adapter, projection, connections, errors };
}
/** The application route: pages come from the app/worker SQL sequence
 * authority and live records arrive as the browser receives them. */
async function application(native: OpencodeV2Test, sid: string) {
  const app = await SidecarTest.start(native, {
      digest: { cpu: 1, retryms: 10 },
    }),
    ws = new WsClient(app.url);
  resources().defer("NT3 socket", () => ws.close());
  ws.lease({
    directory: native.directory,
    selected: sid,
    crumbs: [],
    rows: [],
  });
  await ws.connect();
  ws.send({ t: "subscribe", sessionID: sid });
  // The whole transcript, newest page first, then every older page.
  const page = async () => {
    let next = await ws.rpc<MessagePage>("session.messages", {
      sessionID: sid,
    });
    const items = [...next.items];
    while (next.older) {
      next = await ws.rpc<MessagePage>("session.messages", {
        sessionID: sid,
        before: next.older,
      });
      items.unshift(...next.items);
    }
    return { items };
  };
  const first = await page(), from = ws.frames.length;
  const projection = () => {
    const live = createTranscriptProjection();
    live.replace(first.items);
    for (const frame of ws.frames.slice(from)) {
      if (frame.t === "content" && frame.sessionID === sid) {
        live.apply(frame.event);
      }
    }
    return live.messages();
  };
  // Reconnects the oracle forces itself; any other one is a failure.
  return { ws, page, projection, forced: 0 };
}
function part(message: Message) {
  return message.parts.find((p) => p.kind === "external" && p.activity);
}
async function parity(
  native: OpencodeV2Test,
  observed: Awaited<ReturnType<typeof application>>,
) {
  const snapshot = await observed.page();
  const records = (rows: readonly Message[]) =>
    rows.filter((m) => m.role === "context").map(presentation);
  // Live delivery reaches the same lifecycle records, in the same order.
  try {
    await waitFor(
      () => Promise.resolve(observed.projection()),
      (rows) =>
        JSON.stringify(records(rows)) ===
          JSON.stringify(records(snapshot.items)),
    );
  } catch {
    // The exact comparison below reports the difference.
  }
  assertEquals(records(observed.projection()), records(snapshot.items));
  // Lifecycle delivery itself never forces the application to reconnect.
  assertEquals(
    observed.ws.frames.filter((frame) =>
      frame.t === "harness" && frame.state === "reconnecting"
    ).length,
    observed.forced,
  );
  const harness = observed.ws.frames.length;
  native.proxy.disconnect();
  // The application's native connection is replaced, then restored.
  await waitFor(
    () =>
      Promise.resolve(
        observed.ws.frames.slice(harness).flatMap((frame) =>
          frame.t === "harness" ? [frame.state] : []
        ),
      ),
    (states) =>
      states.includes("reconnecting") && states.at(-1) === "connected",
  );
  observed.forced++;
  const after = await observed.page();
  assertEquals(after.items.map(presentation), snapshot.items.map(presentation));
  assertEquals(new Set(after.items.map((m) => m.id)).size, after.items.length);
  return after.items;
}
Deno.test({
  name:
    "NT3-1 native model, variant-only, default, agent and move boundaries match live, snapshot and reconnect",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("NT3 switches", async () => {
      const fake = new FakeLlm(),
        native = await OpencodeV2Test.start(fake),
        target = await native.createSession(),
        observed = await application(native, target.id);
      await native.api.session.switchAgent({
        sessionID: target.nativeID,
        agent: "plan",
      });
      await native.api.session.switchModel({
        sessionID: target.nativeID,
        model: { providerID: "fake", id: "scripted" },
      });
      await native.api.session.switchModel({
        sessionID: target.nativeID,
        model: { providerID: "fake", id: "scripted", variant: "high" },
      });
      await native.api.session.switchModel({
        sessionID: target.nativeID,
        model: { providerID: "fake", id: "scripted" },
      });
      await Deno.mkdir(native.directory + "/destination");
      await native.api.session.move({
        sessionID: target.nativeID,
        directory: native.directory + "/destination",
      });
      await waitFor(async () => {
        const session = await native.api.session.get({
          sessionID: target.nativeID,
        });
        const active = await native.api.session.active();
        const inbox = await native.api.session.inbox.list({
          sessionID: target.nativeID,
        });
        return session.location.directory ===
            native.directory + "/destination" &&
          !active[target.nativeID] && !inbox.length;
      }, Boolean);
      await parity(native, observed);
      const titles = observed.projection().map((m) => part(m)).flatMap(
        (p) => p?.kind === "external" ? [p.activity?.title] : [],
      );
      assert(titles.includes("Switched variant to high"));
      assert(titles.includes("Switched variant to Default"));
      assert(titles.includes(`Moved to ${native.directory}/destination`));
    }),
});
Deno.test({
  name:
    "NT3-2 native compaction running, completed and cancelled retain one lifecycle owner and declared summary",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("NT3 compaction", async () => {
      const fake = new FakeLlm(),
        native = await OpencodeV2Test.start(fake),
        target = await native.createSession(),
        observed = await application(native, target.id);
      fake.queue({ chunks: ["Context before compaction"] });
      await native.prompt(target.id, "Provide context");
      await waitFor(() => native.api.session.active(), (a) =>
        !a[target.nativeID]);
      const summary = "## Objective\n\nKeep all native lifecycle records.";
      const held = fake.queueHeld({ chunks: [summary] });
      await native.api.session.compact({ sessionID: target.nativeID });
      const rows = await waitFor(() =>
        observed.projection(), (rows) =>
        rows.some((m) => {
          const p = part(m);
          return p?.kind === "external" &&
            p.activity?.state?.facts.active === true;
        }));
      const running = rows.find((m) => {
        const p = part(m);
        return p?.kind === "external" && p.name === "opencode-v2/compaction";
      })!;
      held.release();
      await waitFor(() =>
        native.api.session.active(), (a) =>
        !a[target.nativeID]);
      await waitFor(() =>
        observed.projection(), (rows) =>
        rows.some((m) => {
          const p = part(m);
          return m.id === running.id && p?.kind === "external" &&
            p.activity?.state?.key === "completed";
        }));
      await parity(native, observed);
      fake.queue({ chunks: ["More context"] });
      await native.prompt(target.id, "Continue");
      await waitFor(() =>
        native.api.session.active(), (a) =>
        !a[target.nativeID]);
      const cancel = fake.queueHeld({ chunks: [summary] });
      try {
        await native.api.session.compact({ sessionID: target.nativeID });
        await waitFor(() =>
          observed.projection(), (rows) =>
          rows.some((m) => {
            const p = part(m);
            return p?.kind === "external" &&
              p.name === "opencode-v2/compaction" &&
              p.activity?.state?.facts.active === true;
          }));
        await native.api.session.interrupt({ sessionID: target.nativeID });
        await waitFor(() =>
          observed.projection(), (rows) =>
          rows.some((m) => {
            const p = part(m);
            return p?.kind === "external" &&
              p.activity?.state?.key === "cancelled";
          }));
        await parity(native, observed);
      } finally {
        cancel.release();
      }
    }),
});
Deno.test({
  name:
    "NT3-3 stock failed child and parent keep separate provider-limit outcomes without parent prose",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("NT3 idle error", async () => {
      const fake = new FakeLlm();
      fake.queue({
        tool: {
          name: "subagent",
          input: {
            description: "Usage limit child",
            prompt: "Report limit",
            agent: "explore",
            background: true,
          },
        },
      });
      fake.failRemaining("The usage limit has been reached");
      const native = await OpencodeV2Test.start(fake),
        target = await native.createSession(),
        observed = await application(native, target.id);
      await native.prompt(target.id, "Report provider failure");
      // FX25: the retained failure is the parent's one execution-outcome
      // presentation; a second native failed-idle activity is no longer valid.
      const failed = (rows: readonly Message[]) =>
        rows.filter((m) =>
          m.parts.some((p) =>
            p.kind === "external" &&
            p.failure?.code === "native.execution" &&
            p.failure.facts?.reason === "The usage limit has been reached"
          )
        );
      const parent = await waitFor(() => observed.projection(), (rows) =>
        failed(rows).length > 0);
      assertEquals(failed(parent).length, 1);
      assertEquals(
        parent.some((m) =>
          m.parts.some((p) =>
            p.kind === "external" && p.name === "opencode-v2/idle" &&
            p.activity?.state?.key === "failed"
          )
        ),
        false,
      );
      await waitFor(() =>
        observed.projection(), (rows) =>
        rows.some((m) => {
          const p = part(m);
          return p?.kind === "external" &&
            p.activity?.title === "Explore failed" &&
            JSON.stringify(p.activity.body).includes(
              "The usage limit has been reached",
            );
        }));
      await waitFor(() =>
        native.api.session.active(), (active) =>
        !Object.keys(active).length);
      await parity(native, observed);
    }),
});
Deno.test({
  name:
    "NT3-4 stock retry history survives plugin restart after active retry clears",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("NT3 retry history", async () => {
      const fake = new FakeLlm(),
        native = await OpencodeV2Test.start(fake),
        target = await native.createSession();
      const db = new OtkDb(
        native.root + "/retained",
        [pluginStorageMigrations],
        { busyms: 1000 },
      );
      resources().defer("NT3 storage", () => db.close());
      const storage = new PluginStore(db).scope("opencode-v2-server"),
        observed = await observe(native, target.id, storage);
      fake.queue({
        failure: { status: 503, message: "Provider temporarily unavailable" },
      });
      const held = fake.queueHeld({ chunks: ["Retried successfully"] });
      try {
        await native.prompt(target.id, "Retry this request");
        const rows = await waitFor(
          () => observed.projection.messages(),
          (rows) =>
            rows.some((m) => {
              const p = part(m);
              return p?.kind === "external" && p.name === "opencode-v2/retry";
            }),
        );
        const history = rows.find((m) => {
          const p = part(m);
          return p?.kind === "external" && p.name === "opencode-v2/retry";
        })!;
        assert(
          JSON.stringify(history).includes("Provider temporarily unavailable"),
        );
        assert(rows.some((m) =>
          m.parts.some((p) =>
            p.kind === "external" && p.name === "opencode-v2/active-retry"
          )
        ));
        held.release();
        await waitFor(() =>
          native.api.session.active(), (a) =>
          !a[target.nativeID]);
        const page = await observed.adapter.core.listMessages(target.id, {});
        assert(
          !page.items.some((m) =>
            m.parts.some((p) =>
              p.kind === "external" && p.name === "opencode-v2/active-retry"
            )
          ),
        );
        await observed.adapter.core.stop();
        const restored = await observe(native, target.id, storage);
        const after = await restored.adapter.core.listMessages(target.id, {});
        assertEquals(
          after.items.filter((m) =>
            m.id === history.id
          ).length,
          1,
        );
        assert(
          JSON.stringify(after.items.find((m) => m.id === history.id)).includes(
            "Provider temporarily unavailable",
          ),
        );
      } finally {
        held.release();
      }
    }),
});
