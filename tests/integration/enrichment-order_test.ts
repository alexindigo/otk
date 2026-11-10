// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { opencodeV1ReadCodecs } from "@otk/harness-opencode-v1";
import { DigestBridge } from "../../core/digest/bridge.ts";
import { cfg } from "../support/config.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeTest } from "../support/opencode.ts";
import { resources } from "../support/resources.ts";
import { v1NativeTests } from "../support/native-contract.ts";
const test = v1NativeTests(
  "V1 completion-clock reader and native message response",
  ["tests/integration/v2-transcripts_test.ts#OC2T3"],
);

test("worker-native completion clocks cross only the transient scalar read channel", async () => {
  const fake = new FakeLlm(), oc = await OpencodeTest.start(fake);
  const settings = cfg();
  const bridge = new DigestBridge({
    statePath: join(oc.root, "clock-digest"),
    provider: "opencode-v1",
    native: {
      ...settings,
      harness: { ...settings.harness, url: oc.url, db: oc.db },
    },
    policy: { ...settings.digest, cpu: 1 },
    reads: opencodeV1ReadCodecs,
    publish() {},
  });
  try {
    bridge.scope("viewer", { sessions: [] });
    const session = await oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Scalar clock" },
    });
    fake.queue({ chunks: ["Exact clock source"] });
    const response = await oc.request<
      {
        info: { id: string };
        parts: {
          type: string;
          time?: { end?: number };
          state?: { time?: { end?: number } };
        }[];
      }
    >(`/session/${session.id}/message`, {
      method: "POST",
      body: {
        parts: [{ type: "text", text: "Clock request" }],
        model: { providerID: "fake", modelID: "scripted" },
      },
    });
    const ends = response.parts.flatMap((part) =>
      part.type === "text" || part.type === "reasoning"
        ? [part.time?.end ?? 0]
        : part.type === "tool"
        ? [part.state?.time?.end ?? 0]
        : []
    ).filter((n) => n > 0);
    assert(ends.length > 0);
    await bridge.start();
    await bridge.catalog(1, new AbortController().signal);
    const result = await bridge.read("message.clock", {
      sessionID: session.id,
      messageID: response.info.id,
    }, { owner: "clock-test", priority: "visible" });
    assertEquals(result, { lastOutput: Math.max(...ends) });
    assertEquals(Object.keys(result), ["lastOutput"]);
    const empty = await bridge.read("message.clock", {
      sessionID: session.id,
      messageID: "missing",
    }, { owner: "clock-empty", priority: "visible" });
    assertEquals(empty, { lastOutput: null });
    resources().evidence(
      "scalar clock result",
      () =>
        Deno.writeTextFile(
          join(oc.root, "clock-result.json"),
          JSON.stringify({ result, ends, empty }),
        ),
    );
  } finally {
    await bridge.stop();
    await oc.stop();
    await fake.stop();
  }
});
