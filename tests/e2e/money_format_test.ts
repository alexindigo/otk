// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  type AssistantMessage,
  type ModelCatalog,
  usageHeader,
  UsageLedger,
} from "@otk/protocol";
import { fixture } from "../support/config.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { Cdp } from "../support/cdp.ts";
import { WsClient } from "../support/ws-client.ts";

Deno.test("U14 r2 one money rule and exact title-free accessibility reach overlay, footer, meter and session rows", async () => {
  const root = await fixture();
  let amount = 0;
  const message = (): AssistantMessage => ({
    id: "call",
    sessionID: "core",
    role: "assistant",
    replyTo: "user",
    agent: "build",
    model: { provider: "test", model: "test" },
    time: { created: 2, completed: 1002 },
    tokens: {
      input: 100,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    cost: amount,
    interrupted: false,
    parts: [{
      id: "text",
      kind: "text",
      synthetic: false,
      blocks: [{
        b: "paragraph",
        inline: [{ i: "text", text: "One money rule." }],
      }],
    }],
  });
  const catalog: ModelCatalog = {
    providers: [{
      id: "test",
      name: "Test",
      models: [{
        id: "test",
        name: "Test",
        variants: [],
        free: false,
        status: "active",
        cost: { input: 2, output: 4, cache: { read: .5, write: 3 } },
      }],
    }],
  };
  const f = await coreBackendFixture(root, {
    usage: {
      getUsage: () =>
        Promise.resolve(
          new UsageLedger("core", [usageHeader(message())]).snapshot(),
        ),
    },
    models: { listModels: () => Promise.resolve(catalog) },
  });
  f.app.backend.core.listMessages = () => Promise.resolve([message()]);
  const b = await Cdp.launch(root), client = new WsClient(f.url);
  const shots = Deno.env.get("OTK_MONEY_SHOTS");
  const capture = async (name: string) => {
    if (!shots) return;
    await Deno.mkdir(shots, { recursive: true });
    for (
      const [label, theme] of [["dark", "otk-dark"], ["light", "otk-light"]]
    ) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await b.screenshot(join(shots, `money-${name}-${label}.png`));
    }
  };
  try {
    await client.connect();
    await client.rpc("layout.patch", { rightCollapsed: false });
    await b.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await b.goto(`${f.url}/#/local/core`);
    for (
      const [value, label, exact] of [
        [0, "$0.00", "$0"],
        [.00000005, "<$0.01", "$0.00000005"],
        [.0096, "<$0.01", "$0.0096"],
        [.01, "$0.01", "$0.01"],
        [1.2, "$1.20", "$1.2"],
        [1234.567, "$1,234.57", "$1,234.567"],
      ] as const
    ) {
      amount = value;
      await b.reload();
      await b.poll(
        "!!document.querySelector('.otk-context-meter .otk-usage-cost') && !!document.querySelector('.otk-session-cost') && !!document.querySelector('.otk-turn-usage > button')",
      );
      await b.poll(
        `document.querySelector('.otk-context-meter').dataset.cost===${
          JSON.stringify(String(value))
        }`,
      );
      const names = [".otk-context-meter .otk-usage-cost", ".otk-session-cost"];
      assertEquals(
        await b.evaluate(
          `[${
            names.map((s) =>
              `document.querySelector(${JSON.stringify(s)}).textContent`
            ).join(",")
          } ]`,
        ),
        [label, label],
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('.otk-turn-usage > button').textContent",
        ),
        `1 model call · 100 tokens · ${label}`,
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('.otk-turn-usage > button').getAttribute('aria-label')",
        ),
        `Turn usage: 1 model call · 100 tokens · ${label}; exact cost ${exact}`,
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('.otk-session-row').getAttribute('aria-description')",
        ),
        `Exact session cost: ${exact}`,
      );
      const point = await b.evaluate<{ x: number; y: number }>(
        "(()=>{const t=document.querySelector('.otk-turn-usage > button');t.scrollIntoView({block:'center'});const r=t.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
      );
      await b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...point,
      });
      await b.poll(
        "!!document.querySelector('.otk-turn-usage :popover-open') && document.querySelectorAll('.otk-usage-breakdown tbody tr').length===1 && !!document.querySelector('tfoot .otk-usage-category-cost')",
      );
      assertEquals(
        await b.evaluate(
          "['[data-usage-summary=cost] .otk-usage-cost','tbody .otk-usage-cost','tfoot tr > td:nth-last-child(2) .otk-usage-cost'].map(s=>document.querySelector(s).textContent)",
        ),
        [label, label, label],
      );
      assertEquals(
        await b.evaluate(
          "[...document.querySelectorAll('tfoot .otk-usage-category-cost')].map(e=>e.textContent)",
        ),
        ["<$0.01", "$0.00", "$0.00", "$0.00", "$0.00"],
      );
      const categoryExact = await b.evaluate<string[]>(
        "[...document.querySelectorAll('tfoot .otk-usage-category-cost .otk-usage-cost')].map(e=>e.getAttribute('aria-description'))",
      );
      assertAlmostEquals(Number(categoryExact[0].split("$")[1]), .0002, 1e-12);
      assertEquals(
        await b.evaluate(
          "[...document.querySelectorAll('.otk-usage-cost')].every(e=>!e.hasAttribute('title')) && !document.querySelector('.otk-turn-usage > button').hasAttribute('title')",
        ),
        true,
      );
      const tree = await b.send("Accessibility.getFullAXTree") as {
        nodes: {
          role?: { value: string };
          name?: { value: string };
          description?: { value: string };
        }[];
      };
      assertEquals(
        tree.nodes.filter((node) =>
          node.role?.value === "group" && node.name?.value === label &&
          node.description?.value === `Exact cost: ${exact}`
        ).length,
        value === 0 ? 8 : 4,
        "Meter plus overview, call and Total expose exact costs; four zero-priced categories add four groups for real zero",
      );
      assert(
        tree.nodes.some((node) =>
          node.role?.value === "button" &&
          node.description?.value === `Exact session cost: ${exact}`
        ),
      );
      assert(
        tree.nodes.some((node) =>
          node.role?.value === "button" &&
          node.name?.value ===
            `Turn usage: 1 model call · 100 tokens · ${label}; exact cost ${exact}`
        ),
      );
      if (value === .0096) await capture("sub-cent");
      if (value === 1.2) await capture("cents");
      await b.key("Escape");
      await b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 1,
        y: 1,
      });
    }
    await b.click(".otk-display-menu > button");
    await b.click('input[name="showCost"]');
    await b.poll(
      "document.querySelectorAll('.otk-usage-cost,.otk-session-cost').length===0",
    );
    await b.key("Escape");
    await b.reload();
    await b.poll(
      "document.querySelector('.otk-turn-usage > button')?.textContent==='1 model call · 100 tokens'",
    );
    assertEquals(
      await b.evaluate(
        'document.querySelectorAll(\'.otk-usage-cost,.otk-session-cost,[aria-description*="$"],[aria-label*="$"]\').length',
      ),
      0,
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('.otk-context-meter').hasAttribute('data-cost')",
      ),
      false,
    );
    await capture("cost-off");
    assertEquals(b.errors, []);
  } finally {
    await Deno.writeTextFile(
      join(root, "money-dom.html"),
      await b.evaluate<string>("document.documentElement.outerHTML"),
    );
    await client.close();
    await b.close();
    await f.app.stop();
  }
});
