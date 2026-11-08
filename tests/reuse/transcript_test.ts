// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeTest, waitFor } from "../support/opencode.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { resources, test } from "../support/resources.ts";
import { transcriptConsumer } from "./transcript-consumer.ts";

test("public transcript consumer pages native source, resnapshots a lost baseline and cools without losing metadata or choices", async () => {
  const native = await OpencodeTest.start(new FakeLlm());
  const session = await native.session<{ id: string }>("/session", {
    method: "POST",
    body: { title: "Reusable transcript" },
  });
  let earliest = "";
  for (let i = 0; i < 25; i++) {
    const row = await native.request<{ info: { id: string } }>(
      `/session/${session.id}/message`,
      {
        method: "POST",
        body: {
          noReply: true,
          parts: [{ type: "text", text: `Reusable source ${i}` }],
        },
      },
    );
    if (!i) earliest = row.info.id;
  }
  const app = await SidecarTest.start(native);
  let now = 0, serial = 0;
  const timers = new Map<number, { at: number; run(): void }>();
  const consumer = await transcriptConsumer(app.url, {
    now: () => now,
    set(run, delay) {
      const id = ++serial;
      timers.set(id, { at: now + delay, run });
      return id;
    },
    clear(id) {
      timers.delete(id as number);
    },
  });
  resources().defer("public transcript consumer", () => consumer.stop());
  await waitFor(() => consumer.connection.messages, Boolean);
  const target = { sidecarId: "consumer", sessionID: session.id };
  const demand = {
    scope: { sidecarId: "consumer", directory: native.directory },
    sessions: [target],
    selected: target,
  };
  // Demand-loading acquires session metadata only after an explicit scoped request.
  consumer.owner.setDemand(demand);
  await waitFor(() => consumer.index.get("consumer", session.id), Boolean);
  const transcript = consumer.owner.get(target)!;
  await waitFor(() => transcript.state.messageIDs.length, (n) => n >= 20);
  await transcript.ensure(earliest);
  assertEquals(transcript.state.messageIDs.length, 25);
  assert(
    JSON.stringify(transcript.state.messagesByID[earliest]).includes(
      "Reusable source 0",
    ),
  );
  const choice = transcript.interaction.disclosure("work", "generation-1");
  choice.set(true);
  const clock = transcript.state.clock!;
  consumer.owner.receive("consumer", {
    t: "content",
    sessionID: session.id,
    clock: { ...clock, seq: clock.seq + 2 },
    event: { op: "message.remove", messageID: earliest },
  }, true);
  assertEquals(transcript.state.continuity, "missing");
  await waitFor(
    () => transcript.state.continuity,
    (state) => state === "ready",
  );
  await transcript.ensure(earliest);
  assertEquals(transcript.state.messageIDs.length, 25);
  assert(
    JSON.stringify(transcript.state.messagesByID[earliest]).includes(
      "Reusable source 0",
    ),
  );
  consumer.owner.setDemand({ sessions: [] });
  now += consumer.connection.messages!.coolms + 1;
  for (const [id, timer] of timers) {
    if (timer.at <= now) {
      timers.delete(id);
      timer.run();
    }
  }
  assertEquals(transcript.state.temperature, "cold");
  assertEquals(transcript.state.messageIDs, []);
  assertEquals(Object.keys(transcript.state.messagesByID), []);
  assertEquals(Object.keys(transcript.state.repliesByID), []);
  assertEquals(choice.value(), true);
  assertEquals(
    consumer.index.get("consumer", session.id)?.title,
    "Reusable transcript",
  );
  consumer.owner.setDemand(demand);
  await waitFor(() => transcript.state.messageIDs.length, (n) => n >= 20);
  assertEquals(transcript.state.continuity, "ready");
});
