// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { ContentReplay } from "@otk/harness";

Deno.test("archive witnesses track only body identities within one replay epoch", () => {
  const replay = new ContentReplay({
    replayops: 10,
    replaybytes: 10000,
    nonce: () => crypto.randomUUID(),
    emit() {},
  });
  const before = replay.clock("s");
  assertEquals(replay.revisions("s", ["captured"]), { captured: 0 });
  replay.publish("s", { op: "message.remove", messageID: "other" });
  replay.publish("s", { op: "session.error", error: "unrelated" });
  assertEquals(replay.revisions("s", ["captured"]), { captured: 0 });
  replay.publish("s", {
    op: "part.remove",
    messageID: "captured",
    partID: "p",
  });
  assertEquals(replay.revisions("s", ["captured"]), { captured: 3 });
  assertEquals(replay.clock("s").epoch, before.epoch);
  replay.reset("s");
  assertEquals(replay.clock("s").epoch === before.epoch, false);
  assertEquals(replay.revisions("s", ["captured"]), { captured: 0 });
});
