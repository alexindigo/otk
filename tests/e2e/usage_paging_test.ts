// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
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
import { publishUsage, turnDetail } from "../support/usage-summary.ts";
import { settledTranscriptCount } from "../support/message-viewport.ts";

async function usagePaging(theme: string) {
  const root = await fixture();
  const messages: Message[] = [
    {
      id: "user",
      sessionID: "tstv1-core",
      role: "user",
      time: { created: 1 },
      parts: [],
    },
    ...Array.from({ length: 102 }, (_, i): AssistantMessage => ({
      id: `step-${String(i).padStart(3, "0")}`,
      sessionID: "tstv1-core",
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
    "tstv1-core",
    messages.filter((m): m is AssistantMessage => m.role === "assistant").map(
      usageHeader,
    ),
  );
  const calls: unknown[] = [];
  let hold: PromiseWithResolvers<SessionUsage> | undefined, held = false;
  const f = await coreBackendFixture(root, {
    usage: {
      getUsage: async (_id, turnID) => {
        const clock = f.clock();
        if (hold) {
          held = true;
          return turnDetail(await hold.promise, turnID, clock);
        }
        return turnDetail(ledger.snapshot(), turnID, clock);
      },
    },
  });
  let pendingPages = 0;
  f.app.backend.core.listMessages = async (_id, opts) => {
    calls.push(opts);
    const page = f.page(messages, opts.before);
    pendingPages++;
    // An unchanged painted range is not a settled provider page. Keep the read
    // pending beyond the driver's animation-frame stability observation.
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return page;
    } finally {
      pendingPages--;
    }
  };
  const b = await Cdp.launch(root), themeClient = new WsClient(f.url);
  publishUsage(f.app.index, ledger.snapshot());
  const visible =
    "document.querySelector('.otk-turn-usage > button')?.textContent";
  const last =
    "[...document.querySelectorAll('.otk-turn-usage > button')].at(-1)?.textContent";
  const cost = "document.querySelector('.otk-context-meter')?.dataset.cost";
  const emit = (input: number, completed = false) => {
    const message: AssistantMessage = {
      id: "live",
      sessionID: "tstv1-core",
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
    publishUsage(f.app.index, ledger.snapshot());
    f.app.connections.content("tstv1-core", { op: "message.upsert", message });
  };
  const usagePoint = async () =>
    await b.poll(`(async()=>{
    const e=[...document.querySelectorAll('.otk-turn-usage > button')].at(-1);
    if (!e) return false;
    e.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
    let r=e.getBoundingClientRect();
    for (let frame=0;frame<2;frame++) {
      await new Promise(requestAnimationFrame);
      const next=e.getBoundingClientRect();
      if(r.x!==next.x||r.y!==next.y||r.width!==next.width||r.height!==next.height) return false;
      r=next;
    }
    const point={x:r.x+r.width/2,y:r.y+r.height/2};
    return e.isConnected && e.contains(document.elementFromPoint(point.x,point.y)) && point;
  })()`) as { x: number; y: number };
  let hydrationEnd = 0;
  const hydration = async () => {
    const acquired = await settledTranscriptCount(b);
    assertEquals(
      pendingPages,
      0,
      "The measured cursor chain has no pending pages",
    );
    assert(
      acquired < messages.length,
      "Usage must remain complete beyond acquired bodies",
    );
    const expected = Array.from(
      { length: Math.ceil(acquired / 10) },
      (_, i) => ({
        before: i ? `fixture:${messages.length - i * 10}` : undefined,
      }),
    );
    assertEquals(
      calls.slice(hydrationEnd),
      expected,
      "Only the exact cursor chain for the measured viewport may hydrate",
    );
    hydrationEnd = calls.length;
    return hydrationEnd;
  };
  try {
    await themeClient.connect();
    await themeClient.rpc("prefs.set", { key: "theme", value: theme });
    await b.goto(`${f.url}/#/local/tstv1-core`);
    await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
    await b.poll(
      `${visible}==='102 model calls · 102 tokens · $1.02' && Math.abs(Number(${cost})-1.02)<.000001`,
    );
    await hydration();
    await b.reload();
    await b.poll(`${visible}==='102 model calls · 102 tokens · $1.02'`);
    const detailBodyReads = await hydration();
    const point = await usagePoint();
    await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await b.poll("!!document.querySelector('.otk-turn-usage :popover-open')");
    await b.poll(
      "document.querySelectorAll('.otk-usage-breakdown tbody tr').length===102",
    );
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
    // Most calls are outside the loaded ten-message page. Their clocks
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
    assertEquals(
      calls.length,
      detailBodyReads,
      "Opening the complete usage ledger admits zero body reads",
    );
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
    assertEquals(
      calls.length,
      detailBodyReads,
      "Live usage does not page historical bodies",
    );
    await b.reload();
    await b.poll(`${last}==='1 model call · 5 tokens · $0.05'`);
    const heldBodyReads = await hydration();
    const detailPoint = await usagePoint();
    await b.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...detailPoint,
    });
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
    assertEquals(
      calls.length,
      heldBodyReads,
      "Held and duplicate usage updates admit zero body reads",
    );
    await b.reload();
    await b.poll(
      `${last}==='1 model call · 9 tokens · $0.09' && Math.abs(Number(${cost})-1.11)<.000001`,
    );
    await hydration();
    assertEquals(b.errors, []);
  } finally {
    hold?.resolve(ledger.snapshot());
    await themeClient.close();
    await b.close();
    await f.app.stop();
  }
}

for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
  test(`U4 complete102-step turn and session totals survive paging, duplicate live updates, held snapshots and reload (${theme})`, () =>
    usagePaging(theme));
}
