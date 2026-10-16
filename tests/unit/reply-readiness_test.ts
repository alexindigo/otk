// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { FakeLlm } from "../support/fake-llm.ts";

Deno.test("held provider replies deliver content but cannot finish before release", async () => {
  const fake = new FakeLlm();
  try {
    const reply = fake.queueHeld({ chunks: ["Held content."] });
    const response = await fetch(
      `http://127.0.0.1:${fake.port}/v1/chat/completions`,
      {
        method: "POST",
        body: JSON.stringify({ stream: true, messages: [] }),
      },
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("Held content.")) {
      const next = await reader.read();
      assert(!next.done);
      text += decoder.decode(next.value);
    }
    assert(!text.includes("[DONE]"));
    let finished = false;
    const pending = reader.read().then((next) => {
      finished = true;
      return next;
    });
    await Promise.resolve();
    assertEquals(finished, false);
    reply.release();
    reply.release();
    let next = await pending;
    while (!next.done) {
      text += decoder.decode(next.value);
      next = await reader.read();
    }
    assert(text.includes('"finish_reason":"stop"'));
    assert(text.includes("[DONE]"));
  } finally {
    await fake.stop();
  }
});

Deno.test("provider teardown releases outstanding held replies", async () => {
  const fake = new FakeLlm();
  fake.queueHeld({ chunks: ["Teardown content."] });
  const response = await fetch(
    `http://127.0.0.1:${fake.port}/v1/chat/completions`,
    {
      method: "POST",
      body: JSON.stringify({ stream: true, messages: [] }),
    },
  );
  const body = response.text();
  await fake.stop();
  assert((await body).includes("[DONE]"));
});
