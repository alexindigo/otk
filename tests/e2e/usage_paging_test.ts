// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  type AssistantMessage,
  type Message,
  type SessionUsage,
  usageHeader,
  UsageLedger,
} from "@otk/protocol";
import { fixture } from "../support/config.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { Cdp } from "../support/cdp.ts";
import { WsClient } from "../support/ws-client.ts";

Deno.test("U4 complete102-step turn and session totals survive paging, duplicate live updates, held snapshots and reload", async () => {
  const root = await fixture();
  const messages: Message[] = [
    {
      id: "user",
      sessionID: "core",
      role: "user",
      time: { created: 1 },
      parts: [],
    },
    ...Array.from({ length: 102 }, (_, i): AssistantMessage => ({
      id: `step-${String(i).padStart(3, "0")}`,
      sessionID: "core",
      role: "assistant",
      replyTo: "user",
      agent: "build",
      model: { provider: "test", model: "test" },
      time: { created: i * 1000 + 2, completed: i * 1000 + 1002 },
      tokens: {
        input: 1,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: .01,
      interrupted: false,
      parts: [{
        kind: "text",
        id: `text-${i}`,
        synthetic: false,
        blocks: [{
          b: "paragraph",
          inline: [{ i: "text", text: `Charged backend step ${i}.` }],
        }],
      }],
    })),
  ];
  const ledger = new UsageLedger(
    "core",
    messages.filter((m): m is AssistantMessage => m.role === "assistant").map(
      usageHeader,
    ),
  );
  const calls: unknown[] = [];
  let hold: PromiseWithResolvers<SessionUsage> | undefined, held = false;
  const f = await coreBackendFixture(root, {
    usage: {
      getUsage: () => {
        if (hold) {
          held = true;
          return hold.promise;
        }
        return Promise.resolve(ledger.snapshot());
      },
    },
  });
  f.app.backend.core.listMessages = (_id, opts) => {
    calls.push(opts);
    const before = opts.before
      ? messages.findIndex((m) => m.id === opts.before)
      : messages.length;
    return Promise.resolve(messages.slice(0, before).slice(-opts.limit));
  };
  const b = await Cdp.launch(root);
  const visible =
    "document.querySelector('.otk-turn-usage > button')?.textContent";
  const last =
    "[...document.querySelectorAll('.otk-turn-usage > button')].at(-1)?.textContent";
  const cost = "document.querySelector('.otk-context-meter')?.dataset.cost";
  const emit = (input: number, completed = false) => {
    const message: AssistantMessage = {
      id: "live",
      sessionID: "core",
      role: "assistant",
      replyTo: "next-user",
      agent: "build",
      model: { provider: "test", model: "test" },
      time: { created: 200000, ...(completed ? { completed: 201000 } : {}) },
      tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: input * .01,
      interrupted: false,
      parts: [{
        kind: "text",
        id: "live-text",
        synthetic: false,
        blocks: [{
          b: "paragraph",
          inline: [{ i: "text", text: "Live usage." }],
        }],
      }],
    };
    const at = messages.findIndex((m) => m.id === "live");
    if (at < 0) messages.push(message);
    else messages[at] = message;
    ledger.upsert(usageHeader(message));
    f.app.connections.content("core", { op: "message.upsert", message });
  };
  try {
    await b.goto(`${f.url}/#/local/core`);
    await b.poll(
      `${visible}==='102 model calls · 102 tokens · $1.02' && Math.abs(Number(${cost})-1.02)<.000001`,
    );
    assertEquals(calls, [{ limit: 100, before: undefined }]);
    await b.reload();
    await b.poll(`${visible}==='102 model calls · 102 tokens · $1.02'`);
    const point = await b.evaluate<{ x: number; y: number }>(
      "(()=>{const trigger=document.querySelector('.otk-turn-usage > button');trigger.scrollIntoView({block:'center'});const r=trigger.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
    );
    await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await b.poll("!!document.querySelector('.otk-turn-usage :popover-open')");
    assertEquals(
      await b.evaluate(
        "document.querySelectorAll('.otk-usage-breakdown tbody tr').length",
      ),
      102,
    );
    assertEquals(
      await b.evaluate(
        "document.querySelectorAll('.otk-usage-breakdown tfoot tr').length",
      ),
      1,
    );
    assertEquals(
      await b.evaluate(
        "[...document.querySelectorAll('.otk-usage-breakdown tbody tr')].reduce((sum,row)=>sum+Number(row.children[2].textContent),0)",
      ),
      102,
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('.otk-usage-breakdown tfoot tr').children[1].firstChild.textContent",
      ),
      "102",
    );
    assertEquals(
      await b.evaluate(
        "[...document.querySelectorAll('.otk-usage-breakdown tbody tr')].every(row=>Number(row.children[2].textContent)===Number(row.children[3].textContent)+Number(row.children[6].textContent)+Number(row.children[7].textContent))",
      ),
      true,
      "All calls, including those beyond the transcript page, retain full context",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('.otk-usage-breakdown tfoot tr').children[2].firstChild.textContent",
      ),
      "102",
      "The new input category remains independent of the Context total",
    );
    assertEquals(
      await b.evaluate(
        "[...document.querySelectorAll('.otk-usage-breakdown tbody tr')].reduce((sum,row)=>sum+Number(row.children[8].textContent.replace('$','')),0).toFixed(2)",
      ),
      "1.02",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('.otk-usage-breakdown tfoot tr').children[7].textContent",
      ),
      "$1.02",
    );
    // The first two calls are outside the loaded100-message page. Their clocks
    // must still own the footer's complete first-start/last-end range.
    assertEquals(
      await b.evaluate("document.querySelector('.otk-turn-time').textContent"),
      "102.0s",
    );
    const scrollPoint = await b.evaluate<{ x: number; y: number }>(
      "(()=>{const r=document.querySelector('.otk-usage-scroll').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
    );
    await b.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...scrollPoint,
      deltaX: 0,
      deltaY: 5000,
    });
    await b.poll(
      "(()=>{const body=document.querySelector('.otk-usage-scroll'),foot=body.querySelector('tfoot').getBoundingClientRect(),bounds=body.getBoundingClientRect();return body.scrollTop>0 && foot.top>=bounds.top && foot.bottom<=bounds.bottom})()",
    );
    await b.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 1,
      y: 1,
    });
    assertEquals(calls, [{ limit: 100, before: undefined }, {
      limit: 100,
      before: undefined,
    }]);
    const shots = Deno.env.get("OTK_USAGE_OWNER_SHOTS");
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
          await b.screenshot(`${shots}/page102-${name}.png`);
        }
      } finally {
        await client.close();
      }
    }
    emit(2);
    emit(2);
    await b.poll(
      `${last}==='1 model call · 2 tokens · $0.02' && Math.abs(Number(${cost})-1.04)<.000001`,
    );
    emit(5);
    await b.poll(
      `${last}==='1 model call · 5 tokens · $0.05' && Math.abs(Number(${cost})-1.07)<.000001`,
    );
    hold = Promise.withResolvers<SessionUsage>();
    await b.reload();
    for (let i = 0; !held && i < 100; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assertEquals(held, true);
    emit(7);
    emit(7);
    hold.resolve(ledger.snapshot());
    hold = undefined;
    await b.poll(
      `${last}==='1 model call · 7 tokens · $0.07' && Math.abs(Number(${cost})-1.09)<.000001`,
    );
    emit(9, true);
    emit(9, true);
    await b.poll(
      `${last}==='1 model call · 9 tokens · $0.09' && Math.abs(Number(${cost})-1.11)<.000001`,
    );
    await b.reload();
    await b.poll(
      `${last}==='1 model call · 9 tokens · $0.09' && Math.abs(Number(${cost})-1.11)<.000001`,
    );
    assertEquals(calls.length, 4, "Usage reads never page transcript content");
    assertEquals(b.errors, []);
  } finally {
    hold?.resolve(ledger.snapshot());
    await b.close();
    await f.app.stop();
  }
});
