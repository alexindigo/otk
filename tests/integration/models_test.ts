// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { AgentOption, Message, ModelCatalog } from "@otk/protocol";
import { browserFixture } from "../support/browser-fixture.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { waitFor } from "../support/opencode.ts";
import { WsClient } from "../support/ws-client.ts";

Deno.test("V3 models and agents expose connected public metadata over WS and preserve a sent user variant", async () => {
  const fake2 = new FakeLlm();
  const f = await browserFixture(undefined, {
    providers: {
      fake2: {
        fake: fake2,
        name: "Second fixture provider",
        models: {
          scripted: {
            name: "Scripted with variants",
            release_date: "2026-10-17",
            variants: {
              low: { reasoningEffort: "low" },
              high: { reasoningEffort: "high" },
            },
          },
          plain: { name: "Plain model" },
          old: { name: "Old model", status: "deprecated" },
        },
      },
    },
    config: {
      agent: {
        reviewer: {
          mode: "primary",
          description: "Review changes",
          color: "#12abEF",
          model: "fake2/scripted",
          variant: "high",
          prompt: "Private instructions",
        },
      },
    },
  });
  let client: WsClient | undefined;
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Model catalog and metadata" },
    });
    const sidecar = await f.sidecar();
    client = new WsClient(sidecar.url);
    await client.connect();
    const welcome = client.frames.find((frame) => frame.t === "welcome");
    assert(welcome?.t === "welcome");
    assert(welcome.sidecar.harness.capabilities?.includes("models"));
    const catalog = await client.rpc<ModelCatalog>("models.list", {
      sessionID: session.id,
    });
    const native = await f.oc.request<{
      connected: string[];
      all: { id: string; models: Record<string, { status: string }> }[];
    }>("/provider");
    assertEquals(
      catalog.providers.map((provider) => provider.id).sort(),
      [...native.connected].sort(),
    );
    assertEquals([...native.connected].sort(), ["fake", "fake2", "opencode"]);
    assert(
      native.all.some((provider) => !native.connected.includes(provider.id)),
    );
    assertEquals(catalog.default, { provider: "fake", model: "scripted" });
    for (const provider of catalog.providers) {
      assertEquals(Object.keys(provider).sort(), ["id", "models", "name"]);
      for (const model of provider.models) {
        assertEquals(
          Object.keys(model).sort(),
          [
            "free",
            "id",
            "name",
            ...(model.releaseDate === undefined ? [] : ["releaseDate"]),
            "status",
            "variants",
          ].sort(),
        );
        assert(model.variants.every((variant) => typeof variant === "string"));
      }
    }
    const second = catalog.providers.find((provider) =>
      provider.id === "fake2"
    )!;
    assertEquals(second.name, "Second fixture provider");
    assertEquals(second.models.find((model) => model.id === "scripted"), {
      id: "scripted",
      name: "Scripted with variants",
      variants: ["low", "high"],
      status: "active",
      free: false,
      releaseDate: "2026-10-17",
    });
    assertEquals(
      second.models.find((model) => model.id === "plain")!.variants,
      [],
    );
    // Stock filters configured deprecated models before GET /provider. The
    // native mapping unit covers preserving deprecated status when returned.
    assertEquals(
      native.all.find((provider) => provider.id === "fake2")!.models.old,
      undefined,
    );
    assertEquals(second.models.map((model) => model.id).sort(), [
      "plain",
      "scripted",
    ]);
    assert(second.models.every((model) => !model.free));
    assert(catalog.providers.find((provider) => provider.id === "opencode")!
      .models.some((model) => model.free));
    const agents = await client.rpc<AgentOption[]>("agents.list", {
      sessionID: session.id,
      primary: true,
    });
    assertEquals(agents.find((agent) => agent.name === "reviewer"), {
      name: "reviewer",
      description: "Review changes",
      color: "#12abEF",
      model: { provider: "fake2", model: "scripted" },
      variant: "high",
    });
    assert(!JSON.stringify(agents).includes("Private instructions"));
    const text = "V3 select fake2 with the high variant";
    fake2.queue({ chunks: ["Metadata round trip complete."] });
    await client.rpc("session.prompt", {
      sessionID: session.id,
      mode: "normal",
      agent: "reviewer",
      model: { provider: "fake2", model: "scripted" },
      variant: "high",
      parts: [{ kind: "text", text }],
    });
    const request = await waitFor(
      () =>
        fake2.requests.find((request) =>
          request.stream === true &&
          JSON.stringify(request.messages).includes(text)
        ),
      (request) => request !== undefined,
    );
    assertEquals(request!.reasoning_effort, "high");
    const messages = await waitFor(
      () =>
        client!.rpc<Message[]>("session.messages", {
          sessionID: session.id,
          limit: 100,
        }),
      (rows) =>
        rows.some((message) =>
          message.role === "assistant" &&
          !!message.time.completed &&
          JSON.stringify(message.parts).includes(
            "Metadata round trip complete.",
          )
        ),
    );
    const user = messages.find((message) => message.role === "user");
    assert(user?.role === "user");
    assertEquals(user.agent, "reviewer");
    assertEquals(user.model, { provider: "fake2", model: "scripted" });
    assertEquals(user.variant, "high");
    assertEquals(user.agentColor, "#12abEF");
    const stored = await f.oc.request<
      { info: { role: string; model?: unknown } }[]
    >(
      `/session/${session.id}/message`,
    );
    assertEquals(stored.find((row) => row.info.role === "user")!.info.model, {
      providerID: "fake2",
      modelID: "scripted",
      variant: "high",
    });
    assertEquals(f.fake.requests, []);
  } finally {
    await client?.close();
    await f.stop();
  }
});
