// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { MessagePolicy } from "@otk/protocol";
import { Transcript } from "../transcript.ts";
import { V2RequestRetention } from "../request-retention.ts";
import type { V2Event } from "../stream.ts";
import { opencodeV2SessionID as ids } from "../ids.ts";

const native = "ses_positions", sid = ids.encode(native);
const policy: MessagePolicy = {
  prefetchms: 10000,
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
function fixture(latest: () => number | undefined) {
  const requests = new V2RequestRetention(),
    probes: (string | undefined)[] = [];
  const cutoffs = new Map<string, number>();
  const transcript = new Transcript({
    requests,
    client: () => {
      throw new Error("No native body read expected for an unviewed session");
    },
    policy,
    sequence: ({ messageID }) => {
      probes.push(messageID);
      return Promise.resolve(messageID ? cutoffs.get(messageID) : latest());
    },
    content() {},
    diagnostic() {},
    invalidated() {},
  });
  const durable = (seq: number, type = "session.step.started"): V2Event => ({
    type,
    created: 1000 + seq,
    durable: { seq, aggregateID: native },
    data: { sessionID: native },
  });
  const settle = async (id: string, created = 1) => {
    await transcript.event({
      type: "form.created",
      data: { form: { sessionID: native, id, title: id, fields: [] } },
    });
    await transcript.event({
      type: "form.cancelled",
      created,
      data: { sessionID: native, id },
    });
  };
  const position = async (id: string) =>
    (await requests.get(sid, id))?.position;
  return { transcript, requests, probes, cutoffs, durable, settle, position };
}

Deno.test("V2 unviewed settlement over existing history is anchored by a keyed probe, then proven by the next durable event", async () => {
  // Twenty native messages exist before OTK connects; no event was delivered.
  let latest = 20;
  const f = fixture(() => latest);
  try {
    await f.settle("frm_a", 5);
    assertEquals(await f.position("frm_a"), {
      after: 20,
      rank: 1,
      basis: "lookup",
    });
    assertEquals(f.probes, [undefined]);
    latest = 21;
    await f.transcript.event(f.durable(21));
    assertEquals(await f.position("frm_a"), {
      after: 20,
      rank: 1,
      basis: "stream",
    });
    // The newest sequence page has the settlement after native 20.
    assertEquals(
      (await f.requests.page(
        sid,
        { created: 0, id: "", order: 21 },
        10,
        "sequence",
      ))
        .map((m) => [m.id, m.sourceOrder]),
      [["request:frm_a", 20.5]],
    );
  } finally {
    await f.transcript.stop();
  }
});

Deno.test("V2 settlements with no native message between them keep delivery order inside one sequence gap", async () => {
  const f = fixture(() => {
    throw new Error("Delivered watermark makes a probe unnecessary");
  });
  try {
    await f.transcript.event(f.durable(30));
    for (const id of ["frm_1", "frm_2", "frm_3"]) {
      // Copied or equal clocks never decide the order.
      await f.settle(id, 7);
    }
    assertEquals(
      (await f.requests.page(sid, undefined, 10, "sequence")).map((m) => [
        m.id,
        m.sourceOrder,
      ]),
      [
        ["request:frm_3", 30 + 3 / 4],
        ["request:frm_2", 30 + 2 / 3],
        ["request:frm_1", 30.5],
      ],
    );
    assertEquals(f.probes, []);
  } finally {
    await f.transcript.stop();
  }
});

Deno.test("V2 native append racing a settlement is corrected by delivery order, not by the probe", async () => {
  // Native committed 41 and 42 before the probe read, but delivers them after
  // the settlement. The probe is only an upper bound.
  const f = fixture(() => 42);
  try {
    await f.settle("frm_x");
    await f.settle("frm_y");
    assertEquals((await f.position("frm_x"))?.after, 42);
    await f.transcript.event(f.durable(41));
    await f.transcript.event(f.durable(42));
    assertEquals(await f.position("frm_x"), {
      after: 40,
      rank: 1,
      basis: "stream",
    });
    assertEquals(await f.position("frm_y"), {
      after: 40,
      rank: 2,
      basis: "stream",
    });
    assertEquals(
      (await f.requests.page(sid, undefined, 10, "sequence")).map((m) => m.id),
      ["request:frm_y", "request:frm_x"],
    );
  } finally {
    await f.transcript.stop();
  }
});

Deno.test("V2 reconnect forgets the delivery watermark and keeps unresolved positions", async () => {
  let latest: number | undefined = 50;
  const f = fixture(() => latest);
  try {
    await f.transcript.event(f.durable(50));
    f.transcript.disconnect();
    await f.settle("frm_r");
    assertEquals((await f.position("frm_r"))?.basis, "lookup");
    f.transcript.disconnect();
    // A durable event on a new connection does not rewrite an earlier probe.
    await f.transcript.event(f.durable(57));
    assertEquals(await f.position("frm_r"), {
      after: 50,
      rank: 1,
      basis: "lookup",
    });
    // No sequence evidence at all: the record remains, placed by clock.
    f.transcript.disconnect();
    latest = undefined;
    await f.settle("frm_c", 99);
    assertEquals(await f.position("frm_c"), {
      after: null,
      rank: 0,
      basis: "clock",
    });
    assertEquals(
      (await f.requests.page(sid, undefined, 10, "unanchored")).map((m) =>
        m.id
      ),
      ["request:frm_c"],
    );
  } finally {
    await f.transcript.stop();
  }
});

Deno.test("V2 committed revert retires observations after its native boundary only", async () => {
  const f = fixture(() => undefined);
  f.cutoffs.set("msg_cut", 60);
  try {
    await f.transcript.event(f.durable(59));
    await f.settle("frm_before");
    await f.transcript.event(f.durable(60));
    await f.settle("frm_after");
    await f.transcript.event({
      ...f.durable(61, "session.revert.staged"),
      data: { sessionID: native, revert: { messageID: "msg_cut" } },
    });
    assertEquals(f.probes, ["msg_cut"]);
    assertEquals(
      (await f.requests.page(
        sid,
        { created: 0, id: "", order: 60 },
        10,
        "sequence",
      ))
        .map((m) => m.id),
      ["request:frm_before"],
    );
    await f.transcript.event(f.durable(62, "session.revert.committed"));
    assertEquals(await f.requests.get(sid, "frm_after"), undefined);
    assertEquals((await f.position("frm_before"))?.after, 59);
  } finally {
    await f.transcript.stop();
  }
});
