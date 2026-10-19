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
      time: { created: i + 2, completed: i + 3 },
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
      time: { created: 1000, ...(completed ? { completed: 2000 } : {}) },
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
      `${visible}==='102 tokens · $1.02' && Math.abs(Number(${cost})-1.02)<.000001`,
    );
    assertEquals(calls, [{ limit: 100, before: undefined }]);
    await b.reload();
    await b.poll(`${visible}==='102 tokens · $1.02'`);
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
      `${last}==='2 tokens · $0.02' && Math.abs(Number(${cost})-1.04)<.000001`,
    );
    emit(5);
    await b.poll(
      `${last}==='5 tokens · $0.05' && Math.abs(Number(${cost})-1.07)<.000001`,
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
      `${last}==='7 tokens · $0.07' && Math.abs(Number(${cost})-1.09)<.000001`,
    );
    emit(9, true);
    emit(9, true);
    await b.poll(
      `${last}==='9 tokens · $0.09' && Math.abs(Number(${cost})-1.11)<.000001`,
    );
    await b.reload();
    await b.poll(
      `${last}==='9 tokens · $0.09' && Math.abs(Number(${cost})-1.11)<.000001`,
    );
    assertEquals(calls.length, 4, "Usage reads never page transcript content");
    assertEquals(b.errors, []);
  } finally {
    hold?.resolve(ledger.snapshot());
    await b.close();
    await f.app.stop();
  }
});
