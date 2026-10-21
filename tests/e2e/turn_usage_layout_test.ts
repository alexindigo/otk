// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { type AssistantMessage, usageHeader, UsageLedger } from "@otk/protocol";
import { Cdp } from "../support/cdp.ts";
import { fixture } from "../support/config.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { WsClient } from "../support/ws-client.ts";

const trigger = ".otk-turn-usage > button";
const panel = ".otk-turn-usage :popover-open";
const scroll = ".otk-usage-scroll";
const activity =
  "read: packages/client/session-usage.ts and every dependent consumer of the complete turn metadata";

async function point(b: Cdp, selector: string) {
  return await b.evaluate<{ x: number; y: number }>(
    `(()=>{const e=document.querySelector(${
      JSON.stringify(selector)
    });const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
}
async function hover(b: Cdp, selector: string) {
  await b.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    ...await point(b, selector),
  });
}
async function setup(count: number) {
  const root = await fixture();
  const messages = Array.from({ length: count }, (_, i): AssistantMessage => ({
    id: `call-${String(i + 1).padStart(3, "0")}`,
    sessionID: "core",
    role: "assistant",
    replyTo: "user",
    agent: "build",
    model: { provider: "test", model: "test" },
    time: { created: i * 1000 + 2, completed: i * 1000 + 902 },
    tokens: {
      input: (i + 1) * 800,
      output: 80,
      reasoning: 20,
      cache: { read: (i + 1) * 150, write: (i + 1) * 50 },
    },
    cost: .01,
    interrupted: false,
    parts: i === count - 1
      ? [{
        kind: "text",
        id: "answer",
        synthetic: false,
        blocks: [{
          b: "paragraph",
          inline: [{ i: "text", text: "Run complete." }],
        }],
      }]
      : [],
  }));
  const ledger = new UsageLedger(
    "core",
    messages.map((message, i) => ({
      ...usageHeader(message),
      tools: i < count - 1
        ? [{ id: `tool-${i}`, name: "read", summary: activity.slice(6) }]
        : [],
    })),
  );
  const f = await coreBackendFixture(root, {
    usage: { getUsage: () => Promise.resolve(ledger.snapshot()) },
    models: {
      listModels: () =>
        Promise.resolve({
          providers: [{
            id: "test",
            name: "Test provider",
            models: [{
              id: "test",
              name: "Test model",
              variants: [],
              status: "active",
              free: false,
              cost: { input: 2, output: 4, cache: { read: .5, write: 3 } },
            }],
          }],
        }),
    },
  });
  f.app.backend.core.listMessages = (_id, opts) =>
    Promise.resolve(messages.slice(-opts.limit));
  const b = await Cdp.launch(root), client = new WsClient(f.url);
  await client.connect();
  await b.goto(`${f.url}/#/local/core`);
  await b.poll(
    `document.querySelector('${trigger}')?.textContent.startsWith('${count} model calls')`,
  );
  await b.poll("!!document.querySelector('.otk-composer-model-name')");
  return { root, f, b, client };
}

for (const count of [3, 120]) {
  Deno.test(`U14 ${count} calls keep summary, header and Total on screen, support pointer and keyboard and retain exact U12 values`, async () => {
    const { root, f, b, client } = await setup(count);
    const shots = Deno.env.get("OTK_U14_SHOTS");
    try {
      const closedRows = await b.evaluate(
        "document.querySelectorAll('.otk-usage-breakdown tbody tr').length",
      );
      for (const [width, height] of [[1280, 720], [800, 600]]) {
        await b.send("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await b.evaluate(
          `document.querySelector('${trigger}').scrollIntoView({block:'center'})`,
        );
        await hover(b, trigger);
        await b.poll(`!!document.querySelector('${panel}')`);
        // Baseline captures precede the first contract assertion.
        if (shots) {
          await Deno.mkdir(shots, { recursive: true });
          await b.screenshot(join(shots, `${count}-${width}-initial.png`));
        }
        const bounds = await b.evaluate<{ rect: number[]; viewport: number[] }>(
          `(()=>{const r=document.querySelector('${panel}').getBoundingClientRect();return {rect:[r.left,r.top,r.right,r.bottom],viewport:[innerWidth,innerHeight]}})()`,
        );
        assert(
          bounds.rect[0] >= 8 && bounds.rect[1] >= 8 &&
            bounds.rect[2] <= width - 8 && bounds.rect[3] <= height - 8,
          JSON.stringify(bounds),
        );
        assertEquals(closedRows, 0, "Detail rows mount only while open");
        await b.poll(
          `document.querySelectorAll('.otk-usage-breakdown tbody tr').length===${count}`,
        );
        if (width === 1280) {
          assertEquals(
            await b.evaluate(
              `(()=>{const s=document.querySelector('${scroll}');return s.scrollWidth===s.clientWidth})()`,
            ),
            true,
            "All columns fit at the wide viewport",
          );
        }
        const contextEdges = await b.evaluate<number[]>(
          "[document.querySelector('tbody .otk-usage-context > span'),document.querySelector('tfoot tr').children[1]].map(e=>{const range=document.createRange();range.selectNodeContents(e);return range.getBoundingClientRect().right})",
        );
        assertAlmostEquals(
          contextEdges[0],
          contextEdges[1],
          .5,
          "Row and Total context numerals share a right edge",
        );
        assertEquals(
          await b.evaluate(
            "[...document.querySelectorAll('.otk-usage-breakdown tbody tr')].map(row=>[...row.children].slice(2,8).map(cell=>cell.textContent))",
          ),
          Array.from(
            { length: count },
            (_, i) =>
              [
                (i + 1) * 1000,
                (i + 1) * 800,
                80,
                20,
                (i + 1) * 150,
                (i + 1) * 50,
              ].map((n) => n.toLocaleString("en-US")),
          ),
        );
        assertEquals(
          await b.evaluate(
            "[...document.querySelectorAll('.otk-usage-breakdown tbody tr')].map(row=>row.children[8].textContent)",
          ),
          Array(count).fill("$0.01"),
        );
        const n = count * (count + 1) / 2;
        const total = await b.evaluate<string[]>(
          "[...document.querySelector('.otk-usage-breakdown tfoot tr').children].map(cell=>cell.textContent)",
        );
        assertEquals(total[1], (n * 1000).toLocaleString("en-US"));
        const priced = await b.evaluate<{ tokens: string; exact: string }[]>(
          "[...document.querySelectorAll('tfoot .otk-usage-category-cost')].map(e=>({tokens:e.previousElementSibling.textContent,exact:e.querySelector('.otk-usage-cost').getAttribute('aria-description')}))",
        );
        for (
          const [i, value] of [n * 800, count * 80, count * 20, n * 150, n * 50]
            .entries()
        ) {
          assertEquals(
            priced[i].tokens,
            value.toLocaleString("en-US"),
          );
          assertAlmostEquals(
            Number(priced[i].exact.split("$")[1].replaceAll(",", "")),
            value * [2, 4, 4, .5, 3][i] / 1e6,
            1e-9,
          );
        }
        assertEquals(total[7], `$${(count * .01).toFixed(2)}`);
        assertEquals(
          await b.evaluate(
            "document.querySelector('.otk-usage-activity').getAttribute('aria-label')",
          ),
          activity,
        );
        assertEquals(
          await b.evaluate(
            "(()=>{const e=document.querySelector('.otk-usage-activity span');return e.scrollWidth>e.clientWidth && getComputedStyle(e).textOverflow==='ellipsis'})()",
          ),
          true,
        );
        const bars = await b.evaluate<number[]>(
          "[...document.querySelectorAll('.otk-usage-context-bar > span')].map(e=>e.getBoundingClientRect().width/e.parentElement.getBoundingClientRect().width)",
        );
        assertAlmostEquals(bars[0], 1 / count, .01);
        assertAlmostEquals(bars.at(-1)!, 1, .01);
        assertEquals(
          await b.evaluate(
            "document.querySelector('[data-usage-summary=context]').getAttribute('aria-label')",
          ),
          `Context peak: ${(count * 1000).toLocaleString("en-US")} tokens`,
        );
        // Real pointer travel, in steps, from the footer through the surface edge.
        const from = await point(b, trigger), to = await point(b, scroll);
        for (let step = 1; step <= 12; step++) {
          await b.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: from.x + (to.x - from.x) * step / 12,
            y: from.y + (to.y - from.y) * step / 12,
          });
        }
        await b.poll(`!!document.querySelector('${panel}')`);
        const pinned = await b.evaluate<number[]>(
          "['.otk-usage-summary','thead th','tfoot th'].map(s=>document.querySelector(s).getBoundingClientRect().y)",
        );
        await b.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          ...to,
          deltaX: 0,
          deltaY: 20000,
        });
        if (count > 3) {
          await b.poll(`document.querySelector('${scroll}').scrollTop>0`);
        }
        await b.poll(`!!document.querySelector('${panel}')`);
        assertEquals(
          await b.evaluate(
            "['.otk-usage-summary','thead th','tfoot th'].map(s=>document.querySelector(s).getBoundingClientRect().y)",
          ),
          pinned,
        );
        assertEquals(
          await b.evaluate(
            `(()=>{const s=document.querySelector('${scroll}'),r=s.getBoundingClientRect();return ['thead th','tfoot th','tbody tr:last-child'].every(q=>{const b=s.querySelector(q).getBoundingClientRect();return b.top>=r.top && b.bottom<=r.bottom})})()`,
          ),
          true,
        );
        if (width === 800) {
          const left = await b.evaluate<number[]>(
            "[...document.querySelectorAll('tbody tr:first-child > :nth-child(-n+2)')].map(e=>e.getBoundingClientRect().x)",
          );
          await b.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            ...to,
            deltaX: 20000,
            deltaY: 0,
          });
          await b.poll(`document.querySelector('${scroll}').scrollLeft>0`);
          assertEquals(
            await b.evaluate(
              "[...document.querySelectorAll('tbody tr:first-child > :nth-child(-n+2)')].map(e=>e.getBoundingClientRect().x)",
            ),
            left,
          );
          assertEquals(
            await b.evaluate(
              `(()=>{const s=document.querySelector('${scroll}'),r=s.getBoundingClientRect(),c=s.querySelector('thead th:last-child').getBoundingClientRect();return c.right<=r.right && c.left>=r.left})()`,
            ),
            true,
          );
        }
        for (
          const [name, theme] of [["dark", "otk-dark"], ["light", "otk-light"]]
        ) {
          await client.rpc("prefs.set", { key: "theme", value: theme });
          await b.poll(
            `document.documentElement.dataset.otkTheme==='${theme}'`,
          );
          await b.evaluate(
            `(()=>{const s=document.querySelector('${scroll}');s.scrollLeft=0;s.scrollTop=(s.scrollHeight-s.clientHeight)/2})()`,
          );
          await b.evaluate("new Promise(requestAnimationFrame)");
          if (shots) {
            await b.screenshot(join(shots, `${count}-${width}-${name}.png`));
          }
        }
        await b.key("Escape");
        await b.poll(`!document.querySelector('${panel}')`);
        await b.poll(
          "document.querySelectorAll('.otk-usage-breakdown tbody tr').length===0",
        );
        // Focused scrollport remains open after pointer exits; Escape returns to trigger.
        await b.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: 1,
          y: 1,
        });
        await b.evaluate(`document.querySelector('${trigger}').focus()`);
        await b.poll(`!!document.querySelector('${panel}')`);
        await b.key("Tab");
        await b.poll(
          `document.activeElement===document.querySelector('${scroll}')`,
        );
        await b.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: 1,
          y: 1,
        });
        assertEquals(
          await b.evaluate(`!!document.querySelector('${panel}')`),
          true,
        );
        await b.key("Escape");
        await b.poll(
          `!document.querySelector('${panel}') && document.activeElement===document.querySelector('${trigger}')`,
        );
        await b.key("Tab");
      }
      assertEquals(b.errors, []);
    } finally {
      await Deno.writeTextFile(
        join(root, "u14-dom.html"),
        await b.evaluate<string>("document.documentElement.outerHTML"),
      );
      await client.close();
      await b.close();
      await f.app.stop();
    }
  });
}

Deno.test("U14 500-call detail is lazy and opens within a one-second interaction budget", async () => {
  const { f, b, client } = await setup(500);
  try {
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      // A fresh headless page can update activeElement without delivering focus
      // events until native input activates it. Start each sample in the composer.
      await b.click("textarea[name=prompt]");
      assertEquals(
        await b.evaluate(
          "document.querySelectorAll('.otk-usage-breakdown tbody tr').length",
        ),
        0,
      );
      samples.push(
        await b.evaluate<number>(
          `(async()=>{const t=performance.now();document.querySelector('${trigger}').focus();while(document.querySelectorAll('.otk-usage-breakdown tbody tr').length!==500){if(performance.now()-t>2000)throw new Error('500 rows did not mount: '+document.activeElement?.outerHTML);await new Promise(requestAnimationFrame)}await new Promise(requestAnimationFrame);return performance.now()-t})()`,
        ),
      );
      await b.key("Escape");
      await b.poll(
        `!document.querySelector('${panel}') && document.querySelectorAll('.otk-usage-breakdown tbody tr').length===0`,
      );
      await b.key("Tab");
    }
    console.info(
      "U14 500-call open-to-painted-row ms",
      JSON.stringify(samples),
    );
    assert(Math.max(...samples) < 1000, JSON.stringify(samples));
    assertEquals(b.errors, []);
  } finally {
    await client.close();
    await b.close();
    await f.app.stop();
  }
});
