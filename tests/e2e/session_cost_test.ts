// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  type AssistantMessage,
  type ContentSession,
  type Message,
  type Preferences,
  type SessionUsage,
  usageHeader,
  UsageLedger,
} from "@otk/protocol";
import { fixture } from "../support/config.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { Cdp } from "../support/cdp.ts";
import { WsClient } from "../support/ws-client.ts";

const row = (id: string) => `.otk-session-row[data-session="${id}"]`;
const cost = (id: string) =>
  `document.querySelector('${row(id)} .otk-session-cost')?.textContent`;

Deno.test("U5 Sessions rows present whole-session usage for unopened sessions and helpers, refresh live and respect persisted Show cost", async () => {
  const root = await fixture();
  const step = (
    sessionID: string,
    id: string,
    cost: number,
  ): AssistantMessage => ({
    id,
    sessionID,
    role: "assistant",
    replyTo: "user",
    agent: "build",
    model: { provider: "test", model: "test" },
    time: { created: 2, completed: 3 },
    tokens: {
      input: 1,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    cost,
    interrupted: false,
    parts: [],
  });
  const messages: Message[] = [
    {
      id: "user",
      sessionID: "core",
      role: "user",
      time: { created: 1 },
      parts: [],
    },
    ...Array.from({ length: 102 }, (_, i) => step("core", `step-${i}`, .01)),
  ];
  messages.at(-1)!.parts = [{
    id: "text",
    kind: "text",
    synthetic: false,
    blocks: [{
      b: "paragraph",
      inline: [{
        i: "text",
        text: "Complete session usage, independent of transcript pages.",
      }],
    }],
  }];
  const ledgers = new Map([
    [
      "core",
      new UsageLedger(
        "core",
        messages.filter((m): m is AssistantMessage => m.role === "assistant")
          .map(usageHeader),
      ),
    ],
    [
      "helper",
      new UsageLedger("helper", [usageHeader(step("helper", "h", .07))]),
    ],
    ["idle", new UsageLedger("idle")],
    [
      "other",
      new UsageLedger("other", [usageHeader(step("other", "o", 3.25))]),
    ],
  ]);
  const reads: string[] = [], contentReads: string[] = [];
  const unknown = Promise.withResolvers<SessionUsage>();
  const f = await coreBackendFixture(root, {
    usage: {
      getUsage(id) {
        reads.push(id);
        const ledger = ledgers.get(id);
        return ledger ? Promise.resolve(ledger.snapshot()) : unknown.promise;
      },
    },
  });
  const base = f.app.index.get("core")!;
  const entries = [
    {
      ...base,
      title:
        "Charged session with a deliberately long title to test truncation",
      directory: `${root}/otk`,
    },
    {
      ...base,
      id: "helper",
      parentID: "core",
      title: "Explore callers",
      directory: `${root}/otk`,
      attention: { ...base.attention, questions: 1 },
    },
    { ...base, id: "idle", title: "Fresh session", directory: `${root}/otk` },
    {
      ...base,
      id: "unknown",
      title: "Usage unavailable",
      directory: `${root}/otk`,
    },
    {
      ...base,
      id: "other",
      title: "Another project's session",
      directory: `${root}/other-project`,
    },
  ];
  for (const entry of entries) f.app.index.upsert(entry);
  f.app.backend.core.getSession = (id) => {
    const entry = entries.find((e) => e.id === id)!;
    return Promise.resolve<ContentSession>({
      id,
      title: entry.title,
      directory: entry.directory,
      projectID: entry.projectID,
      parentID: entry.parentID,
      archived: false,
      time: { created: 1, updated: 1 },
    });
  };
  f.app.backend.core.listMessages = (id, opts) => {
    contentReads.push(id);
    assertEquals(opts.limit, 100);
    assertEquals(opts.before, undefined);
    return Promise.resolve(id === "core" ? messages.slice(-opts.limit) : []);
  };
  const b = await Cdp.launch(root), c = new WsClient(f.url);
  const shots = Deno.env.get("OTK_SESSION_COST_SHOTS");
  const capture = async (name: string) => {
    if (!shots) return;
    await Deno.mkdir(shots, { recursive: true });
    for (
      const [label, theme] of [["dark", "otk-dark"], ["light", "otk-light"]]
    ) {
      await c.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await b.evaluate("document.activeElement?.blur(); document.fonts.ready");
      await b.screenshot(`${shots}/${name}-${label}.png`);
    }
  };
  try {
    await c.connect();
    await c.rpc("prefs.set", { key: "animationsOff", value: true });
    await b.goto(`${f.url}/#/local/core`);
    await b.poll(
      "document.querySelectorAll('.otk-session-row').length===4 && document.querySelector('.otk-turn-usage > button')?.textContent==='102 model calls · 102 tokens · $1.02'",
    );
    await b.click('[aria-label="Open right panel"]');
    await b.poll("!document.querySelector('.otk-right-panel').hidden");
    // Also captures a reproducible pre-U5 baseline before its missing-row assertion.
    await capture("rows");
    await b.poll(
      `${cost("core")}==='$1.02' && ${cost("helper")}==='$0.07' && ${
        cost("idle")
      }==='$0.00'`,
    );
    assertEquals(await b.evaluate(cost("unknown")), undefined);
    assertEquals(
      contentReads,
      ["core"],
      "Unopened rows must not load transcripts",
    );
    assertEquals(
      reads.filter((id) => id === "core").length,
      1,
      "Panel and transcript join the same usage read",
    );
    assert(
      !reads.includes("other"),
      "Only the selected project's rows are loaded",
    );
    assertEquals(
      await b.evaluate(
        `document.querySelector('${row("core")}').getAttribute('aria-label')`,
      ),
      `${entries[0].title}, session cost $1.02`,
    );
    assertEquals(
      await b.evaluate(
        `document.querySelector('${row("helper")}').getAttribute('aria-label')`,
      ),
      `Explore callers, child of ${entries[0].title}, session cost $0.07`,
    );

    const geometry = async () => {
      const boxes = await b.evaluate<
        {
          right: number;
          centre: number;
          titleCentre: number;
          lightCentre: number;
          height: number;
          overflow: boolean;
        }[]
      >(`[...document.querySelectorAll('.otk-session-row')].filter(r=>r.querySelector('.otk-session-cost')).map(r=>{const c=r.querySelector('.otk-session-cost').getBoundingClientRect(),t=r.querySelector('.otk-row-title').getBoundingClientRect(),l=r.querySelector('.otk-status-light').getBoundingClientRect(),b=r.getBoundingClientRect();return {right:c.right,centre:c.y+c.height/2,titleCentre:t.y+t.height/2,lightCentre:l.y+l.height/2,height:b.height,overflow:r.scrollWidth>r.clientWidth}})`);
      assertEquals(boxes.length, 3);
      for (const box of boxes) {
        assertAlmostEquals(box.right, boxes[0].right, .5);
        assertAlmostEquals(box.centre, box.titleCentre, .5);
        assertAlmostEquals(box.centre, box.lightCentre, .5);
        assertEquals(box.height, 30);
        assertEquals(box.overflow, false);
      }
    };
    await geometry();
    const prefs = await c.rpc<Preferences>("prefs.get", {});
    await c.rpc("layout.patch", { rightWidth: 280 });
    await b.poll(
      "document.querySelector('.otk-right-panel').getBoundingClientRect().width===280",
    );
    await geometry();
    await capture("narrow");
    await c.rpc("layout.patch", { rightWidth: prefs.shellLayout.rightWidth });

    // Unselected helper changes arrive through the existing metadata refresh owner.
    ledgers.get("helper")!.upsert(usageHeader(step("helper", "next", .05)));
    const helper = f.app.index.get("helper")!;
    f.app.index.upsert({ ...helper, timeUpdated: helper.timeUpdated + 1 });
    await b.poll(`${cost("helper")}==='$0.12'`);
    const live = step("core", "live", .03);
    ledgers.get("core")!.upsert(usageHeader(live));
    f.app.connections.content("core", { op: "message.upsert", message: live });
    f.app.connections.content("core", { op: "message.upsert", message: live });
    await b.poll(`${cost("core")}==='$1.05'`);
    assertEquals(contentReads, ["core"]);
    await b.reload();
    await b.poll(`${cost("core")}==='$1.05' && ${cost("helper")}==='$0.12'`);

    await b.click(".otk-display-menu > button");
    await b.click('input[name="showCost"]');
    await b.poll(
      "!document.querySelector('.otk-session-cost') && !document.querySelector('.otk-project-sessions [aria-label*=\"$\"]')",
    );
    await b.key("Escape");
    assertEquals((await c.rpc<Preferences>("prefs.get", {})).showCost, false);
    await b.reload();
    await b.poll(
      "document.querySelectorAll('.otk-session-row').length===4 && document.querySelector('.otk-turn-usage > button')?.textContent==='103 model calls · 103 tokens'",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelectorAll('.otk-session-cost, .otk-project-sessions [aria-label*=\"$\"]').length",
      ),
      0,
    );
    await capture("cost-off");
    await c.rpc("prefs.set", { key: "showCost", value: true });
    await b.poll(`${cost("core")}==='$1.05'`);
    await b.click(row("idle"));
    await b.poll(
      `location.hash==='#/local/idle' && ${cost("core")}==='$1.05' && ${
        cost("idle")
      }==='$0.00'`,
    );
    await b.goto(`${f.url}/#/local/other`);
    await b.poll(
      `${
        cost("other")
      }==='$3.25' && document.querySelectorAll('.otk-session-row').length===1`,
    );
    await b.goto(`${f.url}/#/local/core`);
    await b.poll(`${cost("core")}==='$1.05' && ${cost("helper")}==='$0.12'`);
    assertEquals(b.errors, []);
  } finally {
    unknown.resolve(new UsageLedger("unknown").snapshot());
    await Deno.writeTextFile(
      `${root}/session-cost-state.html`,
      await b.evaluate<string>("document.documentElement.outerHTML"),
    );
    console.info("Session cost browser evidence:", root);
    await c.close();
    await b.close();
    await f.app.stop();
  }
});
