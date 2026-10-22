// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { browserFixture } from "../support/browser-fixture.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { waitFor } from "../support/opencode.ts";

interface Providers {
  connected: string[];
  all: {
    id: string;
    source: string;
    models: Record<string, { variants?: Record<string, unknown> }>;
  }[];
}

test("V2 default fixture preserves its config and exact connected providers", async () => {
  const f = await browserFixture();
  try {
    const config = await Deno.readTextFile(
      join(f.oc.root, "config/opencode/opencode.json"),
    );
    assertEquals(
      config,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        autoupdate: false,
        share: "disabled",
        model: "fake/scripted",
        permission: { bash: "ask" },
        provider: {
          fake: {
            npm: "@ai-sdk/openai-compatible",
            options: {
              baseURL: `http://127.0.0.1:${f.fake.port}/v1`,
              apiKey: "x",
            },
            models: {
              scripted: { name: "scripted" },
              "gpt-scripted": { name: "gpt-scripted" },
            },
          },
        },
      }),
    );
    const catalog = await f.oc.request<Providers>("/provider");
    assertEquals(catalog.connected.sort(), ["fake", "opencode"]);
    assertEquals(
      catalog.all.find((provider) => provider.id === "opencode")!.source,
      "custom",
    );
    const fake = catalog.all.find((provider) => provider.id === "fake")!;
    assertEquals(Object.keys(fake.models).sort(), ["gpt-scripted", "scripted"]);
    for (const model of Object.values(fake.models)) {
      assertEquals(Object.keys(model.variants ?? {}), []);
    }
  } finally {
    await f.stop();
  }
});

test("V2 extra provider advertises variants and exclusively receives its selected prompt", async () => {
  const fake2 = new FakeLlm();
  const f = await browserFixture(undefined, {
    providers: {
      fake2: {
        fake: fake2,
        name: "Second fixture provider",
        models: {
          scripted: {
            name: "Scripted with variants",
            variants: {
              low: { reasoningEffort: "low" },
              high: { reasoningEffort: "high" },
            },
          },
          plain: { name: "No variants" },
        },
      },
    },
  });
  try {
    assert(f.fake.port !== fake2.port);
    const catalog = await f.oc.request<Providers>("/provider");
    assertEquals(catalog.connected.sort(), ["fake", "fake2", "opencode"]);
    assertEquals(
      catalog.all.find((provider) => provider.id === "opencode")!.source,
      "custom",
    );
    const provider = catalog.all.find((provider) => provider.id === "fake2")!;
    assertEquals(Object.keys(provider.models.scripted.variants ?? {}).sort(), [
      "high",
      "low",
    ]);
    assertEquals(Object.keys(provider.models.plain.variants ?? {}), []);
    await Deno.writeTextFile(
      join(f.oc.root, "fixture-catalog.json"),
      JSON.stringify(
        {
          connected: catalog.connected,
          models: Object.fromEntries(
            Object.entries(provider.models).map(([id, model]) => [id, {
              variants: model.variants,
            }]),
          ),
        },
        null,
        2,
      ),
    );
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Variant routing fixture" },
    });
    const text = "V2 route this prompt only to fake2";
    fake2.queue({ chunks: ["Second provider replied."] });
    await f.oc.request(`/session/${session.id}/prompt_async`, {
      method: "POST",
      body: {
        model: { providerID: "fake2", modelID: "scripted" },
        variant: "high",
        parts: [{ type: "text", text }],
      },
    });
    const request = await waitFor(
      () =>
        fake2.requests.find((request) =>
          request.stream === true &&
          JSON.stringify(request.messages).includes(text)
        ),
      (request) => request !== undefined,
    );
    assertEquals(request!.model, "scripted");
    assertEquals(request!.reasoning_effort, "high");
    const messages = await waitFor(
      () =>
        f.oc.request<{
          info: {
            role: string;
            model?: { providerID: string; modelID: string; variant?: string };
            time?: { completed?: number };
          };
          parts: { type: string; text?: string }[];
        }[]>(`/session/${session.id}/message`),
      (rows) =>
        rows.some((row) =>
          row.info.role === "assistant" && !!row.info.time?.completed &&
          row.parts.some((part) => part.text === "Second provider replied.")
        ),
    );
    assertEquals(messages.find((row) => row.info.role === "user")!.info.model, {
      providerID: "fake2",
      modelID: "scripted",
      variant: "high",
    });
    assertEquals(f.fake.requests, []);
  } finally {
    await f.stop();
  }
  assertEquals(
    JSON.parse(
      await Deno.readTextFile(join(f.oc.root, "provider-fake2-requests.json")),
    ),
    fake2.requests,
  );
});
