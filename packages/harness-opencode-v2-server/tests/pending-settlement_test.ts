// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import type { ContentOp } from "@otk/protocol";
import { OperationFailure } from "@otk/protocol";
import type { V2Client } from "../client.ts";
import { V2Pending } from "../pending.ts";
import { emptyContent, reduce } from "@otk/client";

for (const kind of ["permission", "form", "question"] as const) {
  Deno.test(`a retired ${kind} route does not confirm settlement while a reply is in flight`, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let dispatches = 0;
    const client = {
      effect: async () => {
        dispatches++;
        entered.resolve();
        await release.promise;
      },
    } as unknown as V2Client;
    const owner = new V2Pending(() => client, () => undefined, () => {});
    const location = { directory: "/repo" };
    const permission = {
      id: "req",
      sessionID: "ses_one",
      action: "read",
      resources: ["README.md"],
    };
    const form = {
      id: "req",
      sessionID: "ses_one",
      metadata: { kind: "question" },
      fields: [{ key: "q0", type: "string" }],
    };
    const accept = () =>
      kind === "permission"
        ? owner.acceptPermission(location, permission)
        : owner.acceptForm(location, form);
    const reply = () =>
      kind === "permission"
        ? owner.permissions.replyPermission({
          sessionID: "opcv2-ses_one",
          requestID: "req",
          reply: "once",
        })
        : kind === "form"
        ? owner.forms.reply("req", { q0: "yes" })
        : owner.questions.answerQuestion("req", [["yes"]]);
    assertEquals(accept(), true);
    const inFlight = reply();
    try {
      await entered.promise;
      owner.retainLocations(new Set());
      const error = await assertRejects(reply, OperationFailure);
      assertEquals(error.outcome, "unavailable");
      assertEquals(accept(), true, "Native can rediscover the same request");
    } finally {
      release.resolve();
      await inFlight;
    }
    assertEquals(
      owner.settled(kind === "permission" ? kind : "form", "req"),
      true,
    );
    assertEquals(
      accept(),
      false,
      "Stale replay cannot undo confirmed settlement",
    );
    await reply();
    assertEquals(dispatches, 1);
  });
}

Deno.test("a permission retirement cannot expire behind newer request settlements", async () => {
  const owner = new V2Pending(() => undefined!, () => undefined, () => {});
  owner.settle("permission", "per_old", "ses_one");
  for (let n = 0; n < 4097; n++) {
    owner.settle("permission", `per_${n}`, "ses_one");
  }
  owner.acceptPermission({ directory: "/repo" }, {
    id: "per_old",
    sessionID: "ses_one",
    action: "read",
    resources: ["README.md"],
  });
  assertEquals(owner.settled("permission", "per_old"), true);
  assertEquals(await owner.permissions.listPermissions("opcv2-ses_one"), []);
});

Deno.test("request projection replacement cannot orphan a question", () => {
  let content = emptyContent();
  const owner = new V2Pending(() => undefined!, () => undefined, (_id, op) => {
    content = reduce(content, op);
  });
  const location = { directory: "/repo" };
  owner.acceptForm(location, {
    id: "q",
    sessionID: "child",
    metadata: { kind: "question" },
    fields: [{ key: "q0", type: "string" }],
  });
  assertEquals(content.questions.length, 1);
  owner.acceptForm(location, {
    id: "q",
    sessionID: "child",
    fields: [{ key: "ok", type: "boolean" }],
  });
  assertEquals(content.questions, []);
  owner.settle("form", "q", "child");
  assertEquals(content.forms, []);
});

for (const local of [false, true]) {
  Deno.test(`V2 settled permissions cannot return through stale inventories or events: local=${local}`, async () => {
    const events: ContentOp[] = [];
    const client = {
      effect: (run: (api: unknown) => Promise<void>) =>
        run({
          permission: { reply: () => Promise.resolve() },
        }),
    } as unknown as V2Client;
    const owner = new V2Pending(
      () => client,
      () => undefined,
      (_id, op) => events.push(op),
    );
    const location = { directory: "/repo" };
    const request = {
      id: "permission",
      sessionID: "ses_one",
      action: "read",
      resources: ["README.md"],
    };
    owner.acceptPermission(location, request);
    if (local) {
      await owner.permissions.replyPermission({
        sessionID: "opcv2-ses_one",
        requestID: request.id,
        reply: "once",
      });
    } else owner.settle("permission", request.id, request.sessionID);
    const settled = events.length;
    owner.replacePermissions(
      location,
      [request] as Parameters<V2Pending["replacePermissions"]>[1],
    );
    owner.acceptPermission(location, request);
    assertEquals(await owner.permissions.listPermissions("opcv2-ses_one"), []);
    assertEquals(
      events.length,
      settled,
      "No stale request may republish content after settlement",
    );
  });
  for (const sessionID of ["ses_one", "global"]) {
    Deno.test(`V2 settled forms cannot return through stale inventories or events: local=${local}, owner=${sessionID}`, async () => {
      const events: ContentOp[] = [];
      const client = {
        effect: (run: (api: unknown) => Promise<void>) =>
          run({
            session: { form: { reply: () => Promise.resolve() } },
          }),
      } as unknown as V2Client;
      const owner = new V2Pending(
        () => client,
        () => undefined,
        (_id, op) => events.push(op),
      );
      const location = { directory: "/repo" };
      const form: Parameters<V2Pending["replaceForms"]>[1][number] = {
        id: "form",
        sessionID,
        title: "Confirm",
        fields: [{ key: "ok", type: "boolean" }],
      };
      owner.acceptForm(location, form);
      if (local) await owner.forms.reply(form.id, { ok: true });
      else owner.settle("form", form.id, sessionID);
      const settled = events.length;
      owner.replaceForms(
        location,
        [form] as Parameters<V2Pending["replaceForms"]>[1],
      );
      owner.acceptForm(location, form);
      assertEquals(await owner.forms.list(), []);
      assertEquals(
        events.length,
        settled,
        "No stale form may republish content after settlement",
      );
    });
  }
}
