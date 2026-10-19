// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import type { ModelCatalog } from "@otk/protocol";
import {
  browserFixture,
  openSession,
  waitForReply,
} from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { fixture } from "../support/config.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { Cdp } from "../support/cdp.ts";

Deno.test("U1 composer and meter share exactly one models.list per session open", async () => {
  const root = await fixture(), pending = Promise.withResolvers<ModelCatalog>();
  const catalog: ModelCatalog = {
    default: { provider: "opencode", model: "beam-free" },
    providers: [{
      id: "opencode",
      name: "OpenCode",
      models: [{
        id: "beam-free",
        name: "Beam Free",
        free: true,
        status: "active",
        variants: [],
        contextLimit: 10000,
      }],
    }],
  };
  const calls: string[] = [];
  const { app, url } = await coreBackendFixture(root, {
    models: {
      listModels: (id) => {
        calls.push(id);
        return calls.length === 1 ? pending.promise : Promise.resolve(catalog);
      },
    },
  });
  app.backend.core.listMessages = () =>
    Promise.resolve([{
      id: "usage",
      sessionID: "core",
      role: "assistant",
      agent: "build",
      model: catalog.default!,
      time: { created: 1, completed: 2 },
      tokens: {
        input: 2400,
        output: 100,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: 0,
      parts: [],
      interrupted: false,
    }]);
  const b = await Cdp.launch(root);
  try {
    await b.goto(`${url}/#/local/core`);
    await b.poll(
      "!!document.querySelector('.otk-model-picker > button') && document.querySelector('.otk-context-meter')?.dataset.tokens==='2500'",
    );
    assertEquals(
      calls,
      ["core"],
      "Composer and meter must join the same initial catalog work",
    );
    assertEquals(
      await b.evaluate("!!document.querySelector('.otk-context-bar')"),
      false,
    );
    pending.resolve(catalog);
    await b.poll(
      "document.querySelector('.otk-model-picker > button > span')?.textContent==='Beam Free' && document.querySelector('.otk-context-bar')?.getAttribute('aria-valuenow')==='25'",
    );
    assertEquals(calls, ["core"]);
    await b.reload();
    await b.poll(
      "document.querySelector('.otk-model-picker > button > span')?.textContent==='Beam Free' && document.querySelector('.otk-context-bar')?.getAttribute('aria-valuenow')==='25'",
    );
    assertEquals(
      calls,
      ["core", "core"],
      "Reload opens one new shared catalog lifetime",
    );
    assertEquals(b.errors, []);
  } finally {
    pending.resolve(catalog);
    await b.close();
    await app.stop();
  }
});

Deno.test("U1 catalog context limit reaches the meter for OpenCode Beam Free", async () => {
  // Stock opencode consumes a credential-free local provider, including reported
  // usage. Keep its catalog in the real native path, rather than injecting UI data.
  const provider = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      await request.json();
      const chunk = (delta: unknown, finish_reason: string | null = null) =>
        `data: ${
          JSON.stringify({
            id: "context-reply",
            object: "chat.completion.chunk",
            model: "beam-free",
            choices: [{ index: 0, delta, finish_reason }],
          })
        }\n\n`;
      return new Response(
        chunk({ role: "assistant", content: "Catalog context reply." }) +
          chunk({}, "stop") +
          `data: ${
            JSON.stringify({
              id: "context-reply",
              object: "chat.completion.chunk",
              choices: [],
              usage: {
                prompt_tokens: 2400,
                completion_tokens: 100,
                total_tokens: 2500,
              },
            })
          }\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  );
  const f = await browserFixture(undefined, {
    config: {
      model: "opencode/beam-free",
      provider: {
        opencode: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: `http://127.0.0.1:${provider.addr.port}/v1`,
            apiKey: "fixture",
          },
          models: {
            "beam-free": {
              name: "Beam Free",
              limit: { context: 10000, output: 1000 },
              cost: { input: 0, output: 0 },
            },
          },
        },
        other: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: `http://127.0.0.1:${provider.addr.port}/v1`,
            apiKey: "fixture",
          },
          models: {
            "beam-free": {
              name: "Other catalog model",
              limit: { context: 20000, output: 1000 },
            },
          },
        },
      },
    },
  });
  let client: WsClient | undefined;
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Beam Free context" },
    });
    const sidecar = await f.sidecar(), b = await f.browser(sidecar.url);
    client = new WsClient(sidecar.url);
    await client.connect();
    const native = await f.oc.request<
      {
        all: {
          id: string;
          models: Record<string, { limit: { context: number } }>;
        }[];
      }
    >("/provider");
    assertEquals(
      native.all.find((p) => p.id === "opencode")!.models["beam-free"].limit
        .context,
      10000,
    );
    const catalog = await client.rpc<ModelCatalog>("models.list", {
      sessionID: session.id,
    });
    console.info(
      "U1 catalog evidence:",
      JSON.stringify(
        catalog.providers.find((p) => p.id === "opencode")!.models.find((m) =>
          m.id === "beam-free"
        ),
      ),
    );
    await openSession(b, session.id);
    await b.type("textarea[name=prompt]", "Check catalog context usage");
    await b.key("Enter");
    await waitForReply(b, session.id, "Catalog context reply.");
    await b.poll(
      "document.querySelector('.otk-context-meter')?.dataset.tokens==='2500'",
    );
    console.info(
      "U1 meter evidence:",
      await b.evaluate(
        "document.querySelector('.otk-context-meter').outerHTML",
      ),
    );
    const shots = Deno.env.get("OTK_CONTEXT_SHOTS");
    if (shots) {
      await Deno.mkdir(shots, { recursive: true });
      for (
        const [name, theme] of [["dark", "otk-dark"], ["light", "otk-light"]]
      ) {
        await client.rpc("prefs.set", { key: "theme", value: theme });
        await b.poll(
          `document.documentElement.dataset.otkTheme===${
            JSON.stringify(theme)
          }`,
        );
        await b.screenshot(`${shots}/context-${name}.png`);
      }
    }
    assertEquals(
      await b.evaluate(
        "document.querySelector('.otk-context-meter').dataset.limit",
      ),
      "10000",
    );
    const fraction = await b.evaluate<number>(
      "(()=>{const bar=document.querySelector('.otk-context-bar');return bar.firstElementChild.getBoundingClientRect().width/bar.getBoundingClientRect().width})()",
    );
    assertAlmostEquals(fraction, .25, .001);
    assert(
      await b.evaluate(
        "document.querySelector('.otk-context-meter').title.includes('10,000')",
      ),
    );
    await b.reload();
    await b.poll(
      "document.querySelector('.otk-context-meter')?.dataset.limit==='10000'",
    );
    // A draft model is for the next send, not the source of reported usage.
    await b.click(".otk-model-picker > button");
    await b.type(".otk-model-picker input[type=search]", "Other catalog model");
    const other = `.otk-model-picker .otk-picker-row[data-picker-key=${
      JSON.stringify(JSON.stringify(["other", "beam-free"]))
    }] .otk-picker-option`;
    await b.click(other);
    await b.poll(
      "document.querySelector('.otk-model-picker > button > span')?.textContent==='Other catalog model'",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('.otk-context-meter').dataset.limit",
      ),
      "10000",
    );
    await b.type("textarea[name=prompt]", "Use the other catalog window");
    await b.key("Enter");
    await b.poll(
      "document.querySelector('.otk-context-meter')?.dataset.limit==='20000'",
    );
    assertAlmostEquals(
      await b.evaluate<number>(
        "(()=>{const bar=document.querySelector('.otk-context-bar');return bar.firstElementChild.getBoundingClientRect().width/bar.getBoundingClientRect().width})()",
      ),
      .125,
      .001,
    );
    // Helpers have no editable composer: the meter still gets their catalog.
    const child = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Helper context", parentID: session.id },
    });
    await client.rpc("session.prompt", {
      sessionID: child.id,
      mode: "normal",
      model: { provider: "opencode", model: "beam-free" },
      parts: [{ kind: "text", text: "Check helper context" }],
    });
    await openSession(b, child.id);
    await b.poll(
      "document.querySelector('.otk-context-meter')?.dataset.limit==='10000' && document.querySelector('.otk-context-meter')?.dataset.tokens==='2500'",
    );
    assertEquals(
      await b.evaluate("document.querySelector('textarea[name=prompt]')"),
      null,
    );
  } finally {
    await client?.close();
    await f.stop();
    await provider.shutdown();
  }
});
