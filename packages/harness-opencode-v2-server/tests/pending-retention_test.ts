// SPDX-License-Identifier: LGPL-3.0-only
import { assert } from "@std/assert";
import type { MessagePolicy } from "@otk/protocol";
import type { V2Client } from "../client.ts";
import { sourceRef } from "../native-source.ts";
import { V2Pending } from "../pending.ts";
import { V2RequestRetention } from "../request-retention.ts";
import { Transcript } from "../transcript.ts";

const policy: MessagePolicy = {
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
      // A late inventory or ask cannot replace the settled outcome.
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
}
