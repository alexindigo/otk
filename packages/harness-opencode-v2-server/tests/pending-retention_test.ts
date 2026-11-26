// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { MessagePolicy } from "@otk/protocol";
import type { V2Client } from "../client.ts";
import { sourceRef } from "../native-source.ts";
import { V2Pending } from "../pending.ts";
import { V2RequestRetention } from "../request-retention.ts";
import { Transcript } from "../transcript.ts";

const policy: MessagePolicy = {
  bridgepages: 4,
  prefetchms: 1000,
  prefetchbytes: 100000,
  coolms: 1000,
  preloadms: 1000,
  concurrency: 2,
  replayops: 128,
  replaybytes: 1048576,
  recoveryconcurrency: 2,
  recoverypending: 32,
  retryms: 100,
};
const sid = "opcv2-ses_fixture", location = { directory: "/repo" };

for (const kind of ["question", "permission"] as const) {
  Deno.test(`V2 ${kind} first observed in an inventory keeps its facts through settlement`, async () => {
    const requests = new V2RequestRetention();
    const transcript = new Transcript({
      requests,
      client: () => {
        throw new Error("No native read expected");
      },
      policy,
      content() {},
      diagnostic() {},
      invalidated() {},
    });
    // The pending owner reports every admission, as the adapter wires it.
    const pending = new V2Pending(
      () => ({}) as V2Client,
      () => undefined,
      () => {},
      (sessionID, id, request) =>
        void requests.observe({ id, sessionID, request }),
    );
    const text = kind === "question"
      ? "Keep this question from the inventory"
      : "Keep this permission from the inventory";
    try {
      await transcript.event({
        type: "session.step.started",
        durable: { seq: 20, aggregateID: "ses_fixture" },
        data: { sessionID: "ses_fixture" },
      });
      // No live ask: the inventory is the only observation before settlement.
      if (kind === "question") {
        pending.replaceForms(
          location,
          [{
            id: "frm_1",
            sessionID: "ses_fixture",
            title: "Startup",
            metadata: { kind: "question" },
            fields: [{
              key: "q0",
              type: "string",
              title: "Startup",
              description: text,
            }],
          }] as unknown as Parameters<V2Pending["replaceForms"]>[1],
        );
        await transcript.event({
          type: "form.cancelled",
          created: 2,
          data: { sessionID: "ses_fixture", id: "frm_1" },
        });
      } else {
        pending.replacePermissions(
          location,
          [{
            id: "per_1",
            sessionID: "ses_fixture",
            action: "read",
            resources: ["README.md"],
            message: text,
          }] as unknown as Parameters<V2Pending["replacePermissions"]>[1],
        );
        await transcript.event({
          type: "permission.replied",
          created: 2,
          data: {
            sessionID: "ses_fixture",
            requestID: "per_1",
            reply: "reject",
          },
        });
      }
      const view = await transcript.source(
        sid,
        sourceRef({
          origin: "request",
          id: kind === "question" ? "frm_1" : "per_1",
          path: "",
        }),
        new AbortController().signal,
      );
      assert(view.preview.includes(text), view.preview);
      const requestID = kind === "question" ? "frm_1" : "per_1";
      const settled = structuredClone(await requests.get(sid, requestID));
      assert(settled?.outcome);
      assertEquals(settled.position, { after: 20, rank: 1, basis: "stream" });
      const positioned = await requests.page(sid, undefined, 10, "sequence");
      assertEquals(positioned.map((row) => [row.id, row.sourceOrder]), [
        [`request:${requestID}`, 20.5],
      ]);
      // Exercise the real event dispatcher, not just the retention leaf.
      for (const duplicate of [1, 2]) {
        const request = {
          ...settled.request,
          id: requestID,
          sessionID: "ses_fixture",
          late: duplicate,
        };
        await transcript.event(
          kind === "question"
            ? { type: "form.created", created: 50, data: { form: request } }
            : { type: "permission.asked", created: 50, data: request },
        );
        assertEquals(
          await requests.get(sid, requestID),
          settled,
          "Late native facts cannot replace settled outcome, facts or position",
        );
        assertEquals(
          await requests.page(sid, undefined, 10, "sequence"),
          positioned,
        );
        assertEquals(
          await transcript.source(
            sid,
            sourceRef({
              origin: "request",
              id: requestID,
              path: "",
            }),
            new AbortController().signal,
          ),
          view,
        );
      }
      // The inventory admission leaf shares that same settled barrier.
      await requests.observe({
        id: kind === "question" ? "frm_1" : "per_1",
        sessionID: sid,
        request: { late: true },
      });
      const after = await requests.get(
        sid,
        kind === "question" ? "frm_1" : "per_1",
      );
      assert(after?.outcome);
      assert(!JSON.stringify(after.request).includes("late"));
    } finally {
      await transcript.stop();
    }
  });

  Deno.test(`V2 ${kind} native facts refresh before settlement and admit a distinct identity`, async () => {
    const requests = new V2RequestRetention();
    const transcript = new Transcript({
      requests,
      client: () => {
        throw new Error("No native body read expected");
      },
      policy,
      content() {},
      diagnostic() {},
      invalidated() {},
    });
    try {
      const requestID = kind === "question" ? "frm_pending" : "per_pending";
      for (const revision of [1, 2]) {
        const request = { id: requestID, sessionID: "ses_fixture", revision };
        await transcript.event(
          kind === "question"
            ? { type: "form.created", data: { form: request } }
            : { type: "permission.asked", data: request },
        );
        const stored = await requests.get(sid, requestID);
        assertEquals(stored?.request, request);
        assertEquals(stored?.outcome, undefined);
      }
      const request = { id: requestID + "_new", sessionID: "ses_fixture" };
      await transcript.event(
        kind === "question"
          ? { type: "form.created", data: { form: request } }
          : { type: "permission.asked", data: request },
      );
      assertEquals((await requests.get(sid, request.id))?.request, request);
      assertEquals((await requests.get(sid, requestID))?.request?.revision, 2);
    } finally {
      await transcript.stop();
    }
  });
}
