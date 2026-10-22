// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeTest } from "../support/opencode.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { observeReply } from "./client-consumer.ts";

test("standalone client consumes real core RPC and reduces live ops in plain Deno", async () => {
  const fake = new FakeLlm();
  const oc = await OpencodeTest.start(fake);
  let core: SidecarTest | undefined;
  try {
    core = await SidecarTest.start(oc);
    fake.queue({ chunks: ["Framework-free ", "client outcome."], delay: 50 });
    const result = await observeReply(
      core.url,
      oc.directory,
      "Exercise the client",
      "client outcome.",
    );
    assert(
      result.ops > 2,
      "consumer observed live content ops, not only startup or a snapshot",
    );
    assertEquals(result.indexed, true);
    assert(result.content.messages.some((message) => message.role === "user"));
    const reply = result.content.messages.find((message) =>
      message.role === "assistant"
    );
    assert(reply?.role === "assistant");
    assert(reply.time.completed !== undefined);
    assert(reply.time.lastOutput !== undefined);
    assert(
      JSON.stringify(reply.parts).includes("Framework-free client outcome."),
    );
  } finally {
    await core?.stop();
    await oc.stop();
    await fake.stop();
  }
});
