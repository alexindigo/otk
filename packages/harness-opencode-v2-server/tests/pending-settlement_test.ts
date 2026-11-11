// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { ContentOp } from "@otk/protocol";
import type { V2Client } from "../client.ts";
import { V2Pending } from "../pending.ts";

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
