// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type {
  AssistantMessage,
  Message,
  ModelCatalog,
  Preferences,
} from "@otk/protocol";
import { type SessionUsage, usageHeader, UsageLedger } from "@otk/protocol";
import {
  browserFixture,
  openSession,
  waitForReply,
} from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { Cdp } from "../support/cdp.ts";
import { fixture } from "../support/config.ts";
import { coreBackendFixture } from "../support/core-backend.ts";

const trigger = ".otk-turn-usage > button";
async function hover(b: Cdp, selector: string) {
  const point = await b.evaluate<{ x: number; y: number }>(
    `(()=>{const r=document.querySelector(${
      JSON.stringify(selector)
    }).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
}
const categories = (
  m: Pick<AssistantMessage, "tokens">,
) => [
  m.tokens.input,
  m.tokens.output,
  m.tokens.reasoning,
  m.tokens.cache.read,
  m.tokens.cache.write,
];

Deno.test("U4 stored multi-step turn usage reaches the footer and hover/focus split; Display cost off persists after reload", async () => {
  let step = 0;
  const provider = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const body = await request.json();
      const title = JSON.stringify(body.messages).includes(
        "Generate a title for this conversation:",
      );
      const n = title ? 1 : ++step;
      const tool = !title && n <= 2;
      const delta = tool
        ? {
          tool_calls: [{
            index: 0,
            id: `call_usage_${n}`,
            type: "function",
            function: {
              name: "bash",
              arguments: JSON.stringify({
                command: n === 1 ? "pwd" : "ls -la",
                description: n === 1
                  ? "Read the directory"
                  : "List directory files",
              }),
            },
          }],
        }
        : {
          content: title
            ? "Usage"
            : n === 3
            ? "Turn usage includes both steps."
            : "Another turn has its own usage.",
        };
      const chunk = (delta: unknown, finish_reason: string | null = null) =>
        `data: ${
          JSON.stringify({
            id: `usage-${n}`,
            object: "chat.completion.chunk",
            model: "priced",
            choices: [{ index: 0, delta, finish_reason }],
          })
        }\n\n`;
      return new Response(
        chunk({ role: "assistant" }) + chunk(delta) +
          chunk({}, tool ? "tool_calls" : "stop") + `data: ${
          JSON.stringify({
            id: `usage-${n}`,
            object: "chat.completion.chunk",
            choices: [],
            usage: {
              prompt_tokens: n * 100000,
              completion_tokens: n * 10000,
              total_tokens: n * 110000,
              prompt_tokens_details: { cached_tokens: n * 20000 },
              completion_tokens_details: { reasoning_tokens: n * 2000 },
            },
          })
        }\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  );
  const f = await browserFixture({ bash: "allow" }, {
    config: {
      model: "priced/priced",
      provider: {
        priced: {
          npm: "@ai-sdk/openai-compatible",
          name: "Priced provider",
          options: {
            baseURL: `http://127.0.0.1:${provider.addr.port}/v1`,
            apiKey: "fixture",
          },
          models: {
            priced: {
              name: "Priced model",
              limit: { context: 1000000, output: 100000 },
              cost: { input: 2, output: 4, cache_read: .5, cache_write: 3 },
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
      body: { title: "Charged turn usage" },
    });
    const server = await f.sidecar(), b = await f.browser(server.url);
    client = new WsClient(server.url);
    await client.connect();
    await openSession(b, session.id);
    await b.type(
      "textarea[name=prompt]",
      "Read the directory and report usage",
    );
    await b.key("Enter");
    await waitForReply(b, session.id, "Turn usage includes both steps.");
    const stored = await client.rpc<Message[]>("session.messages", {
      sessionID: session.id,
      limit: 100,
    });
    const steps = stored.filter((m): m is AssistantMessage =>
      m.role === "assistant"
    );
    assertEquals(steps.length, 3);
    const native = await f.oc.request<
      {
        info: {
          role: string;
          tokens?: AssistantMessage["tokens"];
          cost?: number;
        };
      }[]
    >(`/session/${session.id}/message`);
    assertEquals(
      native.filter((row) => row.info.role === "assistant").map((row) => ({
        counts: categories({ tokens: row.info.tokens! }),
        cost: row.info.cost,
      })),
      steps.map((m) => ({ counts: categories(m), cost: m.cost })),
    );
    const sums = steps.reduce(
      (sum, m) => categories(m).map((n, i) => n + sum[i]),
      [0, 0, 0, 0, 0],
    );
    const total = sums.reduce((a, n) => a + n, 0),
      cost = steps.reduce((a, m) => a + m.cost, 0);
    assert(total > 300000 && cost > 0);
    const text = `3 model calls · ${
      new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(total)
    } tokens · $${cost.toFixed(2)}`;
    await b.poll(
      `document.querySelector(${JSON.stringify(trigger)})?.textContent===${
        JSON.stringify(text)
      }`,
    );
    assertEquals(
      await b.evaluate("document.querySelectorAll('.otk-turn-usage').length"),
      1,
    );
    const catalog = await client.rpc<ModelCatalog>("models.list", {
      sessionID: session.id,
    });
    const price = catalog.providers.find((p) => p.id === "priced")!.models[0]
      .cost!;
    assertEquals(price, { input: 2, output: 4, cache: { read: .5, write: 3 } });
    await hover(b, trigger);
    await b.poll("!!document.querySelector('.otk-turn-usage :popover-open')");
    assertEquals(
      await b.evaluate(
        "[...document.querySelectorAll('.otk-usage-breakdown thead th')].map(cell=>cell.textContent)",
      ),
      [
        "Call",
        "Activity",
        "Context",
        "New input",
        "Output",
        "Reasoning",
        "Cache read",
        "Cache write",
        "Cost",
        "Time",
      ],
    );
    const rows = await b.evaluate<string[][]>(
      "[...document.querySelectorAll('.otk-usage-breakdown tbody tr')].map(row=>[...row.children].map(cell=>cell.textContent))",
    );
    assertEquals(rows.length, 3);
    assertEquals(rows.map((r) => r[0]), ["1", "2", "3"]);
    assertEquals(rows.map((r) => r[1]), [
      "bash: pwd",
      "bash: ls -la",
      "answered",
    ]);
    for (const [i, message] of steps.entries()) {
      assertEquals(
        rows[i].slice(3, 8),
        categories(message).map((n) => n.toLocaleString("en-US")),
      );
      const context = message.tokens.input + message.tokens.cache.read +
        message.tokens.cache.write;
      assertEquals(rows[i][2], context.toLocaleString("en-US"));
      if (i) {
        assert(
          Number(rows[i][2].replaceAll(",", "")) >=
            Number(rows[i - 1][2].replaceAll(",", "")),
          "The fixture's full prompt grows across calls",
        );
      }
      assertAlmostEquals(
        Number(rows[i][8].replace(/[$,]/g, "")),
        message.cost,
        .005,
      );
      assertEquals(
        rows[i][9],
        `${
          ((message.time.completed! - message.time.created) / 1000).toFixed(1)
        }s`,
      );
    }
    const totals = await b.evaluate<string[]>(
      "[...document.querySelector('.otk-usage-breakdown tfoot tr').children].map(cell=>cell.textContent)",
    );
    assertEquals(totals[0], "Total");
    assertEquals(
      totals[1],
      (sums[0] + sums[3] + sums[4]).toLocaleString("en-US"),
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('.otk-usage-context-note').textContent",
      ),
      "New input + Cache read + Cache write = Context.",
    );
    for (const [i, rate] of [2, 4, 4, .5, 3].entries()) {
      assertAlmostEquals(
        Number(
          (await b.evaluate<string[]>(
            "[...document.querySelectorAll('.otk-usage-category-cost .otk-usage-cost')].map(e=>e.getAttribute('aria-description').split('$')[1].replaceAll(',',''))",
          ))[i],
        ),
        sums[i] * rate / 1e6,
        1e-9,
      );
    }
    const turnTime = `${
      ((steps.at(-1)!.time.completed! - steps[0].time.created) / 1000).toFixed(
        1,
      )
    }s`;
    assertEquals(
      await b.evaluate("document.querySelector('.otk-turn-time').textContent"),
      turnTime,
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('.otk-work-fold span').textContent",
      ),
      `Worked for ${turnTime}`,
    );
    const geometry = await b.evaluate<{ before: boolean; centre: number }>(
      "(()=>{const u=document.querySelector('.otk-turn-usage'),e=u.previousElementSibling,a=u.getBoundingClientRect(),r=e.getBoundingClientRect();return {before:r.right<=a.left,centre:Math.abs(r.y+r.height/2-a.y-a.height/2)}})()",
    );
    assert(geometry.before && geometry.centre <= .5, JSON.stringify(geometry));
    const tableGeometry = await b.evaluate<
      { inside: boolean; aligned: boolean; bounds: number[] }
    >(
      "(()=>{const table=document.querySelector('.otk-usage-breakdown'),panel=table.closest('.otk-surface').getBoundingClientRect(),rows=[...table.querySelectorAll('tbody tr')];return {inside:panel.width>0 && panel.height>0 && panel.left>=0 && panel.right<=innerWidth,aligned:rows.every(row=>[...row.children].slice(2).every((cell,i)=>Math.abs(cell.getBoundingClientRect().right-rows[0].children[i+2].getBoundingClientRect().right)<=.5)),bounds:[panel.left,panel.right,innerWidth]}})()",
    );
    assert(
      tableGeometry.inside && tableGeometry.aligned,
      JSON.stringify(tableGeometry),
    );
    // Hover did not move focus out of the composer. Escape must dismiss the
    // preview without focusing its trigger and reopening it via focus-in.
    await b.key("Escape");
    await b.poll("!document.querySelector('.otk-turn-usage :popover-open')");
    assertEquals(
      await b.evaluate(
        "document.activeElement===document.querySelector('textarea[name=prompt]')",
      ),
      true,
    );
    await b.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 1,
      y: 1,
    });
    const shots = Deno.env.get("OTK_USAGE_SHOTS");
    const capture = async (name: string) => {
      if (shots) {
        await Deno.mkdir(shots, { recursive: true });
        await b.screenshot(join(shots, `${name}.png`));
      }
    };
    for (
      const [name, theme] of [["dark", "otk-dark"], ["light", "otk-light"]]
    ) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await capture(`${name}-hover-dismissed`);
      await hover(b, trigger);
      await b.poll("!!document.querySelector('.otk-turn-usage :popover-open')");
      await capture(`${name}-split`);
      await b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 1,
        y: 1,
      });
      await b.poll("!document.querySelector('.otk-turn-usage :popover-open')");
      await capture(`${name}-footer`);
    }
    // Keyboard focus alone reveals detail; Escape dismisses, Tab leaves normally.
    await b.evaluate(
      `document.querySelector(${JSON.stringify(trigger)}).focus()`,
    );
    await b.poll("!!document.querySelector('.otk-turn-usage :popover-open')");
    await b.key("Escape");
    await b.poll("!document.querySelector('.otk-turn-usage :popover-open')");
    await b.key("Tab");
    await b.click('[aria-label="Display options"]');
    await b.poll(
      "document.querySelector('input[name=showCost]')?.checked===true",
    );
    for (
      const [name, theme] of [["dark", "otk-dark"], ["light", "otk-light"]]
    ) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await capture(`${name}-display-on`);
    }
    await b.click('input[name="showCost"]');
    await b.poll(
      `document.querySelector(${JSON.stringify(trigger)})?.textContent===${
        JSON.stringify(text.slice(0, text.lastIndexOf(" · ")))
      } && !document.querySelector('.otk-context-meter').textContent.includes('$')`,
    );
    assertEquals(
      (await client.rpc<Preferences>("prefs.get", {})).showCost,
      false,
    );
    await b.key("Escape");
    await b.reload();
    await b.poll(
      `document.querySelector(${JSON.stringify(trigger)})?.textContent===${
        JSON.stringify(text.slice(0, text.lastIndexOf(" · ")))
      }`,
    );
    // Transcript loads independently of metadata; compare the settled cost-off
    // state, not the intentionally unknown-window/catalog-loading frame.
    await b.poll(
      "document.querySelector('.otk-context-meter')?.dataset.limit==='1000000' && document.querySelector('.otk-context-bar')?.getAttribute('aria-valuenow')==='33'",
    );
    for (
      const [name, theme] of [["dark", "otk-dark"], ["light", "otk-light"]]
    ) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await capture(`${name}-cost-off`);
      await hover(b, trigger);
      await b.poll("!!document.querySelector('.otk-turn-usage :popover-open')");
      assertEquals(
        await b.evaluate(
          "[...document.querySelectorAll('.otk-turn-usage > button')].every(button=>!button.hasAttribute('title') && document.getElementById(button.getAttribute('aria-describedby'))?.id===button.getAttribute('popovertarget'))",
        ),
        true,
        "Preview surfaces replace native tooltips and retain their accessible detail link",
      );
      assertEquals(
        await b.evaluate(
          "[...document.querySelectorAll('.otk-usage-breakdown tbody tr')].map(row=>row.children.length)",
        ),
        [9, 9, 9],
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('.otk-message-footer').textContent.includes('$') || document.querySelector('.otk-context-meter').outerHTML.includes('data-cost') || document.querySelector('.otk-context-meter').textContent.includes('$')",
        ),
        false,
      );
      await capture(`${name}-split-cost-off`);
      await b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 1,
        y: 1,
      });
    }
    await client.rpc("prefs.set", { key: "showCost", value: true });
    await b.type("textarea[name=prompt]", "Start a separate turn");
    await b.key("Enter");
    await waitForReply(b, session.id, "Another turn has its own usage.");
    assertEquals(
      await b.evaluate("document.querySelectorAll('.otk-turn-usage').length"),
      2,
    );
    assertEquals(
      await b.evaluate(
        `document.querySelector(${JSON.stringify(trigger)}).textContent`,
      ),
      text,
    );
    console.info(
      "U4 native stored usage",
      JSON.stringify({ sums, total, cost, steps: steps.length, price }),
    );
  } finally {
    await client?.close();
    await f.stop();
    await provider.shutdown();
  }
});

Deno.test("U4 unknown model prices show all five charged token categories without inventing costs", async () => {
  const root = await fixture(),
    f = await coreBackendFixture(root, {
      usage: {
        getUsage: async (id): Promise<SessionUsage> =>
          new UsageLedger(
            id,
            (await f.app.backend.core.listMessages(id, { limit: 200 })).filter((
              m,
            ): m is AssistantMessage => m.role === "assistant").map(
              usageHeader,
            ),
          ).snapshot(),
      },
    });
  f.app.backend.core.listMessages = () =>
    Promise.resolve([{
      id: "usage",
      sessionID: "core",
      role: "assistant",
      agent: "build",
      model: { provider: "unknown", model: "model" },
      time: { created: 1, completed: 2 },
      tokens: {
        input: 100,
        output: 20,
        reasoning: 30,
        cache: { read: 40, write: 50 },
      },
      cost: .43,
      interrupted: false,
      parts: [],
    }]);
  const b = await Cdp.launch(root);
  try {
    await b.goto(`${f.url}/#/local/core`);
    await b.poll(
      `document.querySelector(${
        JSON.stringify(trigger)
      })?.textContent==='1 model call · 240 tokens · $0.43'`,
    );
    await hover(b, trigger);
    await b.poll("!!document.querySelector('.otk-turn-usage :popover-open')");
    assertEquals(
      await b.evaluate(
        "(()=>{const trigger=document.querySelector('.otk-turn-usage > button'),panel=document.getElementById(trigger.getAttribute('popovertarget'));return {nativeTooltip:!!trigger.closest('[title]'),label:trigger.getAttribute('aria-label'),description:document.getElementById(trigger.getAttribute('aria-describedby'))===panel,open:panel.matches(':popover-open')}})()",
      ),
      {
        nativeTooltip: false,
        label:
          "Turn usage: 1 model call · 240 tokens · $0.43; exact cost $0.43",
        description: true,
        open: true,
      },
    );
    assertEquals(
      await b.evaluate(
        "[...document.querySelectorAll('.otk-usage-breakdown tbody tr')].map(row=>row.textContent)",
      ),
      ["1answered19010020304050$0.430.0s"],
    );
    const shots = Deno.env.get("OTK_USAGE_SHOTS");
    if (shots) {
      await Deno.mkdir(shots, { recursive: true });
      const client = new WsClient(f.url);
      await client.connect();
      try {
        for (
          const [name, theme] of [["dark", "otk-dark"], ["light", "otk-light"]]
        ) {
          await client.rpc("prefs.set", { key: "theme", value: theme });
          await b.poll(
            `document.documentElement.dataset.otkTheme==='${theme}'`,
          );
          await b.screenshot(join(shots, `${name}-unknown-prices.png`));
        }
      } finally {
        await client.close();
      }
    }
    assertEquals(b.errors, []);
  } finally {
    await b.close();
    await f.app.stop();
  }
});

Deno.test("U4 queued prompts do not split a turn and category costs use each step's exact provider", async () => {
  const root = await fixture();
  const catalog: ModelCatalog = {
    providers: ["first", "second"].map((id, i) => ({
      id,
      name: id,
      models: [{
        id: "shared",
        name: "Shared model ID",
        variants: [],
        status: "active",
        free: false,
        cost: {
          input: (i + 1) * 2,
          output: (i + 1) * 4,
          cache: { read: (i + 1) * .5, write: (i + 1) * 3 },
        },
      }],
    })),
  };
  const f = await coreBackendFixture(root, {
    models: { listModels: () => Promise.resolve(catalog) },
    usage: {
      getUsage: async (id): Promise<SessionUsage> =>
        new UsageLedger(
          id,
          (await f.app.backend.core.listMessages(id, { limit: 200 })).filter((
            m,
          ): m is AssistantMessage => m.role === "assistant").map(usageHeader),
        ).snapshot(),
    },
  });
  const step = (id: string, provider: string): AssistantMessage => ({
    id,
    sessionID: "core",
    role: "assistant",
    replyTo: "user",
    agent: "build",
    model: { provider, model: "shared" },
    time: { created: 1, completed: 2 },
    tokens: {
      input: 100000,
      output: 20000,
      reasoning: 30000,
      cache: { read: 40000, write: 50000 },
    },
    cost: .43,
    interrupted: false,
    parts: [],
  });
  f.app.backend.core.listMessages = () =>
    Promise.resolve([step("first-step", "first"), {
      id: "queued",
      sessionID: "core",
      role: "user",
      time: { created: 2 },
      parts: [],
    }, step("last-step", "second")]);
  const b = await Cdp.launch(root);
  try {
    await b.goto(`${f.url}/#/local/core`);
    await b.poll(
      `document.querySelector(${
        JSON.stringify(trigger)
      })?.textContent==='2 model calls · 480K tokens · $0.86'`,
    );
    assertEquals(
      await b.evaluate("document.querySelectorAll('.otk-turn-usage').length"),
      1,
    );
    await hover(b, trigger);
    await b.poll("!!document.querySelector('.otk-turn-usage :popover-open')");
    assertEquals(
      await b.evaluate(
        "[...document.querySelector('.otk-usage-breakdown tfoot tr').children].map(cell=>cell.textContent)",
      ),
      [
        "Total",
        "380,000",
        "200,000$0.60",
        "40,000$0.24",
        "60,000$0.36",
        "80,000$0.06",
        "100,000$0.45",
        "$0.86",
        "0.0s",
      ],
    );
    assertEquals(b.errors, []);
  } finally {
    await b.close();
    await f.app.stop();
  }
});
