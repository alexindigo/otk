// SPDX-License-Identifier: LGPL-3.0-only
import { fixturePage } from "../support/message-pages.ts";
import { test } from "../support/resources.ts";
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
import { publishUsage, turnDetail } from "../support/usage-summary.ts";
import { settledTranscriptCount } from "../support/message-viewport.ts";

const row = (id: string) => `.otk-session-row[data-session="${id}"]`;
const cost = (id: string) =>
  `document.querySelector('${row(id)} .otk-session-cost')?.textContent`;

async function sessionCost(theme: string) {
  const root = await fixture();
  const step = (
    sessionID: string,
    id: string,
    cost: number,
    created = 2,
  ): AssistantMessage => ({
    id,
    sessionID,
    role: "assistant",
    replyTo: "user",
    agent: "build",
    model: { provider: "test", model: "test" },
    time: { created, completed: created + 1 },
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
      sessionID: "tstv1-core",
      role: "user",
      time: { created: 1 },
      parts: [],
    },
    ...Array.from(
      { length: 102 },
      (_, i) => step("tstv1-core", `step-${i}`, .01, i * 1000 + 2),
    ),
  ];
  messages.at(-1)!.parts = [{
    id: "text",
    kind: "text",
    synthetic: false,
    blocks: [{
      b: "paragraph",
      inline: [{
        i: "text",
        // A viewport-sized tail isolates summary reads from legitimate reserve
        // refills for a screenful of otherwise empty historical steps.
        text: "Complete session usage, independent of transcript pages. "
          .repeat(100),
      }],
    }],
  }];
  const ledgers = new Map([
    [
      "tstv1-core",
      new UsageLedger(
        "tstv1-core",
        messages.filter((m): m is AssistantMessage => m.role === "assistant")
          .map(usageHeader),
      ),
    ],
    [
      "tstv1-helper",
      new UsageLedger("tstv1-helper", [
        usageHeader(step("tstv1-helper", "h", .07)),
      ]),
    ],
    ["tstv1-idle", new UsageLedger("tstv1-idle")],
    [
      "tstv1-other",
      new UsageLedger("tstv1-other", [
        usageHeader(step("tstv1-other", "o", 3.25)),
      ]),
    ],
  ]);
  const reads: string[] = [], contentReads: string[] = [];
  const unknown = Promise.withResolvers<SessionUsage>();
  const f = await coreBackendFixture(root, {
    usage: {
      async getUsage(id, turnID) {
        reads.push(id);
        const ledger = ledgers.get(id);
        return turnDetail(
          ledger ? ledger.snapshot() : await unknown.promise,
          turnID,
        );
      },
    },
  });
  const base = f.app.index.get("tstv1-core")!;
  const entries = [
    {
      ...base,
      title:
        "Charged session with a deliberately long title to test truncation",
      directory: `${root}/otk`,
    },
    {
      ...base,
      id: "tstv1-helper",
      parentID: "tstv1-core",
      title: "Explore callers",
      directory: `${root}/otk`,
      attention: { ...base.attention, questions: 1 },
    },
    {
      ...base,
      id: "tstv1-idle",
      title: "Fresh session",
      directory: `${root}/otk`,
    },
    {
      ...base,
      id: "tstv1-unknown",
      title: "Usage unavailable",
      directory: `${root}/otk`,
    },
    {
      ...base,
      id: "tstv1-other",
      title: "Another project's session",
      directory: `${root}/other-project`,
    },
  ];
  for (const entry of entries) f.app.index.upsert(entry);
  for (const ledger of ledgers.values()) {
    publishUsage(f.app.index, ledger.snapshot());
  }
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
  f.app.backend.core.listMessages = async (id, opts) => {
    contentReads.push(id);
    return fixturePage(
      id,
      id === "tstv1-core" ? messages : [],
      opts.before,
      await f.app.backend.core.getSession(id),
      f.clock(id),
    );
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
    await c.rpc("prefs.set", { key: "theme", value: theme });
    await b.goto(`${f.url}/#/local/tstv1-core`);
    await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
    await b.poll(
      "document.querySelector('.otk-turn-usage > button')?.textContent==='102 model calls · 102 tokens · $1.02'",
    );
    await b.click('[aria-label="Open right panel"]');
    await b.poll("!document.querySelector('.otk-right-panel').hidden");
    await b.poll("document.querySelectorAll('.otk-session-row').length===4");
    // Capture visible rows even if their cost assertion fails.
    await capture("rows");
    await b.poll(
      `${cost("tstv1-core")}==='$1.02' && ${
        cost("tstv1-helper")
      }==='$0.07' && ${cost("tstv1-idle")}==='$0.00'`,
    );
    assertEquals(await b.evaluate(cost("tstv1-unknown")), undefined);
    const acquired = await settledTranscriptCount(b);
    assert(
      acquired < messages.length,
      "Whole-session totals include unacquired charged steps",
    );
    assertEquals(
      contentReads.filter((id) => id === "tstv1-core").length,
      Math.ceil(acquired / 10),
      "Only pages acquired by the selected viewport and its reserve",
    );
    assertEquals([...new Set(contentReads)].sort(), [
      "tstv1-core",
      "tstv1-helper",
      "tstv1-idle",
      "tstv1-unknown",
    ], "Only the active project receives C2 scope warming");
    for (const id of ["tstv1-helper", "tstv1-idle", "tstv1-unknown"]) {
      assertEquals(
        contentReads.filter((read) => read === id).length,
        1,
        "Empty scope members receive exactly one page",
      );
    }
    const hydratedReads = [...contentReads];
    assertEquals(
      reads.filter((id) => id === "tstv1-core").length,
      0,
      "Panel and transcript summaries admit no detail reads",
    );
    assert(
      !reads.includes("tstv1-other"),
      "Only the selected project's rows are loaded",
    );
    assertEquals(
      await b.evaluate(
        `document.querySelector('${
          row("tstv1-core")
        }').getAttribute('aria-label')`,
      ),
      `${entries[0].title}, session cost $1.02`,
    );
    assertEquals(
      await b.evaluate(
        `document.querySelector('${
          row("tstv1-helper")
        }').getAttribute('aria-label')`,
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
    ledgers.get("tstv1-helper")!.upsert(
      usageHeader(step("tstv1-helper", "next", .05)),
    );
    const helper = f.app.index.get("tstv1-helper")!;
    f.app.index.upsert({ ...helper, timeUpdated: helper.timeUpdated + 1 });
    publishUsage(f.app.index, ledgers.get("tstv1-helper")!.snapshot());
    await b.poll(`${cost("tstv1-helper")}==='$0.12'`);
    const live = step("tstv1-core", "live", .03, 200000);
    messages.push(live);
    ledgers.get("tstv1-core")!.upsert(usageHeader(live));
    f.app.connections.content("tstv1-core", {
      op: "message.upsert",
      message: live,
    });
    publishUsage(f.app.index, ledgers.get("tstv1-core")!.snapshot());
    f.app.connections.content("tstv1-core", {
      op: "message.upsert",
      message: live,
    });
    await b.poll(`${cost("tstv1-core")}==='$1.05'`);
    assertEquals(
      contentReads,
      hydratedReads,
      "Summary changes do not reload warmed bodies",
    );
    await b.reload();
    await b.poll(
      `${cost("tstv1-core")}==='$1.05' && ${cost("tstv1-helper")}==='$0.12'`,
    );

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
    await b.poll(`${cost("tstv1-core")}==='$1.05'`);
    await b.click(row("tstv1-idle"));
    await b.poll(
      `location.hash==='#/local/tstv1-idle' && ${
        cost("tstv1-core")
      }==='$1.05' && ${cost("tstv1-idle")}==='$0.00'`,
    );
    await b.goto(`${f.url}/#/local/tstv1-other`);
    await b.poll(
      `${
        cost("tstv1-other")
      }==='$3.25' && document.querySelectorAll('.otk-session-row').length===1`,
    );
    await b.goto(`${f.url}/#/local/tstv1-core`);
    await b.poll(
      `${cost("tstv1-core")}==='$1.05' && ${cost("tstv1-helper")}==='$0.12'`,
    );
    assertEquals(b.errors, []);
  } finally {
    unknown.resolve(new UsageLedger("tstv1-unknown").snapshot());
    await Deno.writeTextFile(
      `${root}/session-cost-state.html`,
      await b.evaluate<string>("document.documentElement.outerHTML"),
    );
    console.info("Session cost browser evidence:", root);
    await c.close();
    await b.close();
    await f.app.stop();
  }
}

for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
  test(`U5 Sessions rows present whole-session usage for unopened sessions and helpers, refresh live and respect persisted Show cost (${theme})`, () =>
    sessionCost(theme));
}
