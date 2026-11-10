// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { type OperationContext, OperationFailure } from "@otk/protocol";
import { V2Client } from "../client.ts";
import { V2Pending } from "../pending.ts";
import { interrupt } from "../interrupt.ts";
const root = "opcv2-ses_root", helper = "opcv2-ses_helper";
function fixture() {
  const calls: { path: string; body: unknown; headers: Headers }[] = [];
  let response = () => Promise.resolve(new Response(null, { status: 204 }));
  let fences = 0;
  const operation = {
    signal: new AbortController().signal,
    beforeEffect: () => {
      fences++;
      return Promise.resolve();
    },
    progress() {},
    checkpoint: () => Promise.resolve(),
    key: { principal: "p", clientID: "c", key: "k" },
  } as unknown as OperationContext;
  const client = new V2Client(
    { endpoint: { url: "http://localhost:4000" }, pid: 1, version: "2.2.6" },
    1000,
    new AbortController().signal,
    (input, init) => {
      calls.push({
        path: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: new Headers(init?.headers),
      });
      return response();
    },
  );
  const pending = new V2Pending(
    () => client,
    (id) =>
      id === helper
        ? { id, parentID: root, directory: "/repo" }
        : { id, directory: "/repo" },
    () => {},
  );
  return {
    calls,
    operation,
    client,
    pending,
    fences: () => fences,
    response: (run: typeof response) => {
      response = run;
    },
  };
}
Deno.test("V2 permissions reply decision once to asking helper, decline carries feedback, settlement converges", async () => {
  const f = fixture();
  f.pending.replace({ directory: "/repo" }, [{
    id: "per_1",
    sessionID: "ses_helper",
    action: "shell",
    resources: ["echo safe"],
    save: ["echo *"],
    source: { type: "tool", messageID: "msg_1", id: "call_1" },
  }], []);
  const requests = await f.pending.permissions.listPermissions(root);
  assertEquals(requests[0].sessionID, helper);
  assertEquals(requests[0].toolCall, "call_1");
  await f.pending.permissions.replyPermission({
    sessionID: root,
    requestID: "per_1",
    reply: "once",
  }, f.operation);
  assertEquals(
    f.calls[0].path,
    "http://localhost:4000/api/session/ses_helper/permission/per_1/reply",
  );
  assertEquals(f.calls[0].body, { decision: "once" });
  f.response(() =>
    Promise.resolve(
      Response.json({ _tag: "PermissionNotFoundError", message: "settled" }, {
        status: 404,
      }),
    )
  );
  await f.pending.permissions.replyPermission({
    sessionID: helper,
    requestID: "per_1",
    reply: "reject",
  }, f.operation);
  assertEquals(f.calls[1].body, {
    decision: "reject",
    message: "The user declined this request.",
  });
  assertEquals(f.fences(), 2);
});
Deno.test("V2 global-owner forms retain location and typed answers, failures retain pending drafts", async () => {
  const f = fixture();
  f.pending.replace({ directory: "/repo" }, [], [{
    id: "frm_all",
    sessionID: "global",
    title: "All fields",
    fields: [{ type: "boolean", key: "ready", required: true }],
  }]);
  assertEquals((await f.pending.forms.list())[0].owner, {
    kind: "location",
    directory: "/repo",
  });
  f.response(() =>
    Promise.resolve(
      Response.json({ _tag: "FormInvalidAnswerError", message: "invalid" }, {
        status: 400,
      }),
    )
  );
  await assertRejects(
    () => f.pending.forms.reply("frm_all", { ready: false }, f.operation),
    OperationFailure,
  );
  assertEquals((await f.pending.forms.list()).length, 1);
  f.response(() => Promise.resolve(new Response(null, { status: 204 })));
  await f.pending.forms.reply("frm_all", { ready: false }, f.operation);
  const request = new URL(f.calls[1].path);
  assertEquals(request.pathname, "/api/session/global/form/frm_all/reply");
  assertEquals(
    f.calls[1].headers.get("x-opencode-directory"),
    encodeURIComponent("/repo"),
  );
  assertEquals(f.calls[1].body, { answer: { ready: false } });
  assertEquals((await f.pending.forms.list()).length, 0);
});
Deno.test("independent complete pending inventories preserve the other kind's authority", async () => {
  const f = fixture(), location = { directory: "/repo" };
  f.pending.replace(location, [{
    id: "per_independent",
    sessionID: "ses_root",
    action: "shell",
    resources: ["echo"],
  }], [{
    id: "frm_independent",
    sessionID: "ses_root",
    title: "Keep form",
    fields: [{ type: "string", key: "answer" }],
  }]);
  f.pending.replacePermissions(location, []);
  assertEquals(await f.pending.permissions.listPermissions(root), []);
  assertEquals((await f.pending.forms.list()).map((f) => f.id), [
    "frm_independent",
  ]);
  f.pending.replaceForms(location, []);
  assertEquals(await f.pending.forms.list(), []);
});
Deno.test("V2 idle interrupt omits resume, fences the effect and accepts interrupted false", async () => {
  const f = fixture();
  f.response(() => Promise.resolve(Response.json({ interrupted: false })));
  await interrupt(f.client, root, f.operation);
  assertEquals(
    f.calls[0].path,
    "http://localhost:4000/api/session/ses_root/interrupt",
  );
  assertEquals(f.calls[0].body, undefined); // The native optional payload is omitted, including resume.
  assertEquals(f.fences(), 1);
});
Deno.test("V2 post-dispatch transport loss is unknown and never retried", async () => {
  const f = fixture();
  f.response(() => Promise.reject(new TypeError("connection lost")));
  const failure = await assertRejects(
    () => interrupt(f.client, root, f.operation),
    OperationFailure,
  );
  assertEquals(failure.outcome, "unknown");
  assertEquals(f.calls.length, 1);
});

Deno.test("V2 effect certainty survives the SDK's causal wrapping before dispatch and on authentication rejection", async () => {
  const f = fixture();
  const fenceFailure = new OperationFailure(
    "rejected",
    "fixture.fence",
    new Error("fence rejected"),
  );
  const stopped = await assertRejects(
    () =>
      interrupt(f.client, root, {
        ...f.operation,
        beforeEffect: () => Promise.reject(fenceFailure),
      }),
    OperationFailure,
  );
  assertEquals(stopped.code, "fixture.fence");
  assertEquals(f.calls.length, 0);
  f.response(() => Promise.resolve(new Response(null, { status: 401 })));
  const rejected = await assertRejects(
    () => interrupt(f.client, root, f.operation),
    OperationFailure,
  );
  assertEquals(rejected.outcome, "rejected");
});

Deno.test("V2 settled form errors converge only after successful complete location inventory", async () => {
  const f = fixture();
  f.pending.replace({ directory: "/repo" }, [], [{
    id: "frm_settled",
    sessionID: "global",
    title: "Already answered",
    fields: [{ type: "string", key: "name" }],
  }]);
  let count = 0;
  f.response(() =>
    Promise.resolve(
      ++count === 1
        ? Response.json({ _tag: "FormAlreadySettledError" }, { status: 409 })
        : Response.json({ data: [] }),
    )
  );
  await f.pending.forms.reply("frm_settled", { name: "value" }, f.operation);
  assertEquals(f.calls.length, 2);
  assertEquals((await f.pending.forms.list()).length, 0);
});

Deno.test("V2 generation retirement joins actual SDK effect settlement before closing", async () => {
  const controller = new AbortController(),
    entered = Promise.withResolvers<void>(),
    response = Promise.withResolvers<Response>();
  const client = new V2Client(
    { endpoint: { url: "http://localhost:4000" }, pid: 1, version: "2.2.6" },
    1000,
    controller.signal,
    () => {
      entered.resolve();
      return response.promise;
    },
  );
  const work = client.effect((api) =>
    api.session.interrupt({ sessionID: "ses_root" })
  );
  await entered.promise;
  controller.abort();
  let retired = false;
  const retirement = client.idle().then(() => {
    retired = true;
  });
  await Promise.resolve();
  assertEquals(retired, false);
  response.resolve(Response.json({ interrupted: false }));
  const interrupted = await assertRejects(() => work, OperationFailure);
  assertEquals(interrupted.outcome, "unknown");
  await retirement;
  assertEquals(retired, true);
});

Deno.test("V2 question compatibility projects only question-tagged string/choice forms and maps labels back to exact values", async () => {
  const f = fixture();
  f.pending.replace({ directory: "/repo" }, [], [
    {
      id: "frm_question",
      sessionID: "ses_root",
      title: "Questions",
      metadata: { kind: "question" },
      fields: [{
        key: "q0",
        type: "string",
        options: [{ label: "Visible label", value: "native-value" }],
      }, { key: "q1", type: "multiselect", options: [], custom: true }],
    },
    {
      id: "frm_number",
      sessionID: "ses_root",
      title: "Typed only",
      metadata: { kind: "question" },
      fields: [{ key: "q0", type: "number" }],
    },
  ]);
  assertEquals(
    (await f.pending.questions.listQuestions(root)).map((q) => q.id),
    ["frm_question"],
  );
  assertEquals((await f.pending.forms.list()).length, 2);
  await f.pending.questions.answerQuestion("frm_question", [["Visible label"], [
    "custom",
    "second",
  ]], f.operation);
  assertEquals(f.calls[0].body, {
    answer: { q0: "native-value", q1: ["custom", "second"] },
  });
  assertEquals((await f.pending.questions.listQuestions(root)).length, 0);
  f.pending.retireSession("ses_root");
  assertEquals((await f.pending.forms.list()).length, 0);
});
