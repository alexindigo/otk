// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createDrafts } from "../drafts.ts";
import { createReload } from "../reload.ts";
import { RequestTracker } from "../requests.ts";
import { RequestLifetimes } from "../request-lifetime.ts";
import { createTranscriptProjection } from "../transcript-projection.ts";
import { pendingMessage } from "../pending-send.ts";
import { fixtureRequests } from "../../../tests/support/request-wire.ts";
import { RequestFailure } from "../failures.ts";

Deno.test("reload restores a definitive rejection as the same settled receipt", async () => {
  const requests = new RequestTracker({ clientID: "tab", send() {} });
  requests.connect(fixtureRequests().window, 10);
  const operation = requests.start("session.prompt", {
    mode: "normal",
    sessionID: "opcv2-root",
    parts: [{ kind: "text", text: "retained rejected input" }],
  });
  requests.receive({
    t: "request.rejected",
    ref: operation.state.ref,
    error: {
      code: "native.rejected",
      diagnosticID: "rejected",
      retry: "new-intent",
      facts: { reason: "Native refused" },
    },
  });
  const restored = new RequestTracker({
    send() {
      throw new Error("Rejection must not submit input");
    },
  });
  restored.restore(requests.snapshot());
  assertEquals(restored.operations()[0].state.phase, "failed");
  await assertRejects(() => restored.operations()[0].result, RequestFailure);
  requests.stop();
  restored.stop();
});

Deno.test("unreadable checkpoint leaves startup usable and blocks overwriting retained work", () => {
  let writes = 0;
  const reload = createReload({
    storage: {
      getItem: () => "invalid saved bytes",
      setItem() {
        writes++;
      },
    },
    navigate() {
      throw new Error("Must not reload");
    },
  });
  assertThrows(() => reload.run());
  assertEquals(writes, 0);
});

Deno.test("Reload retains pending-send payload and its original custody identity, without a new send", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
  const frames: unknown[] = [];
  const requests = new RequestTracker({
    clientID: "tab",
    send: (frame) => frames.push(frame),
  });
  requests.connect(fixtureRequests().window, 10);
  const input: import("@otk/protocol").PromptInput = {
    mode: "normal",
    sessionID: "tstv1-session",
    parts: [{ kind: "text", text: "do not lose or send twice" }],
    model: { provider: "p", model: "m" },
  };
  const operation = requests.start("session.prompt", input);
  const intent = { clientID: "tab", key: operation.state.ref.key };
  const projection = createTranscriptProjection();
  projection.send({
    intent,
    message: pendingMessage("msg-pending", input.sessionID, [{
      kind: "text",
      text: "do not lose or send twice",
    }]),
    phase: "pending",
  });
  const attention = new RequestLifetimes();
  attention.receive({
    op: "question.upsert",
    request: { id: "question", sessionID: input.sessionID, questions: [] },
  });
  attention.draft("question", "question", "unsaved answer");
  const reload = createReload({
    storage,
    navigate() {},
    owners: {
      requests,
      attention,
      sends: { snapshot: () => projection.pendingSends(), restore() {} },
    },
  });
  reload.run();
  requests.stop();
  const resumed: unknown[] = [];
  const next = new RequestTracker({
    send: (frame) => resumed.push(frame),
  });
  const restoredAttention = new RequestLifetimes();
  const restoredProjection = createTranscriptProjection();
  createReload({
    storage,
    navigate() {},
    owners: {
      requests: next,
      attention: restoredAttention,
      sends: {
        snapshot() {},
        restore(value) {
          for (
            const send of value as ReturnType<typeof projection.pendingSends>
          ) restoredProjection.send(send);
        },
      },
    },
  });
  assertEquals(next.snapshot(), requests.snapshot());
  assertEquals(
    restoredProjection.pendingSends()[0].message,
    projection.pendingSends()[0].message,
  );
  assertEquals(
    restoredAttention.draft("question", "question"),
    "unsaved answer",
  );
  next.connect({ ...fixtureRequests().window, id: "new-server-window" }, 10);
  assertEquals(resumed.length, 1);
  assertEquals((resumed[0] as { t: string }).t, "request.resume");
  assertEquals(
    (next.snapshot() as { operations: { state: { ref: { key: string } } }[] })
      .operations[0].state.ref.key,
    intent.key,
  );
  next.stop();
});

Deno.test("Reload checkpoints all drafts, editor bytes and explicit Default before navigation", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
  const drafts = createDrafts();
  drafts.writer("local/session")({
    input: "unsent",
    chips: [],
    mode: "normal",
    variant: undefined,
    editor: { text: "not saved yet" },
  });
  let navigations = 0;
  const reload = createReload({
    storage,
    navigate: () => {
      navigations++;
    },
    owners: { drafts },
  });
  reload.run();
  assertEquals(navigations, 1);
  const restored = createDrafts();
  createReload({ storage, navigate() {}, owners: { drafts: restored } });
  assertEquals(
    restored.current("local/session"),
    drafts.current("local/session"),
  );
  assertEquals(
    Object.hasOwn(restored.current("local/session"), "variant"),
    true,
  );
});

Deno.test("storage refusal prevents Reload and retains input", () => {
  const drafts = createDrafts();
  drafts.writer("session")({ input: "keep me", chips: [], mode: "normal" });
  let navigations = 0;
  const reload = createReload({
    storage: {
      getItem: () => null,
      setItem() {
        throw new Error("quota");
      },
    },
    navigate: () => {
      navigations++;
    },
    owners: { drafts },
  });
  assertThrows(() => reload.run());
  assertEquals(navigations, 0);
  assertEquals(drafts.current("session").input, "keep me");
});
