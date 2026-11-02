// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { mapDiffs, mapTool, type RawPart } from "@otk/harness-opencode-v1";
import type { AssistantMessage } from "@otk/protocol";
import { fixture } from "../support/config.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { Cdp } from "../support/cdp.ts";
import { WsClient } from "../support/ws-client.ts";
import { test } from "../support/resources.ts";

test("native unknown search/diff metadata and shared output policy reach both themed consumers", async () => {
  const root = await fixture();
  const raw = (
    id: string,
    tool: string,
    output?: string,
    metadata: Record<string, unknown> = {},
  ): RawPart => ({
    id,
    sessionID: "native",
    messageID: "reply",
    type: "tool",
    callID: id,
    tool,
    state: {
      status: "completed",
      input: {},
      output,
      metadata,
      time: { start: 1000, end: 2000 },
    },
  });
  const lines = Array.from({ length: 15 }, (_, i) => `Output line ${i + 1}`)
    .join("\n");
  const reply: AssistantMessage = {
    id: "reply",
    sessionID: "tstv1-core",
    role: "assistant",
    agent: "reviewer",
    model: { provider: "unreported", model: "model" },
    interrupted: false,
    time: { created: 1000, completed: 2000 },
    tokens: {
      input: null,
      output: 0,
      reasoning: null,
      cache: { read: null, write: 0 },
    },
    cost: null,
    parts: [
      {
        kind: "tool",
        id: "unknown-search",
        call: mapTool(raw("unknown-search", "grep")),
      },
      {
        kind: "tool",
        id: "zero-search",
        call: mapTool(raw("zero-search", "grep", undefined, { matches: 0 })),
      },
      {
        kind: "tool",
        id: "unknown-diff",
        call: {
          tool: "patch",
          callID: "unknown-diff",
          status: "completed",
          time: {},
          awaitingPermission: false,
          files: mapDiffs([{ additions: 0, deletions: 0 }]),
        },
      },
      {
        kind: "tool",
        id: "plain-output",
        call: mapTool(raw("plain-output", "external", lines)),
      },
    ],
  };
  const f = await coreBackendFixture(root, {
    prompt: { prompt: () => Promise.resolve(), abort: () => Promise.resolve() },
  });
  f.app.backend.core.listMessages = () => Promise.resolve(f.page([reply]));
  const b = await Cdp.launch(root), client = new WsClient(f.url);
  try {
    await client.connect();
    await client.rpc("prefs.set", { key: "genericToolOutput", value: true });
    await client.rpc("prefs.set", { key: "animationsOff", value: true });
    await b.goto(`${f.url}/#/local/tstv1-core`);
    await b.poll("document.querySelectorAll('[data-tool=search]').length===2");
    const rows = await b.evaluate<string[]>(
      "[...document.querySelectorAll('[data-tool=search] .otk-tool-toggle')].map(el=>el.textContent)",
    );
    assert(!rows[0].includes("0 matches"));
    assert(!rows[0].includes("*"));
    assert(rows[1].includes("0 matches"));
    await b.click("[data-tool=patch] .otk-tool-toggle");
    await b.poll(
      "document.querySelector('[data-tool=patch] .otk-diff')?.getAttribute('aria-label')==='Change Path not reported'",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('[data-tool=patch] .otk-tool-target')?.textContent",
      ),
      "Path not reported",
    );
    const point = await b.evaluate<{ x: number; y: number }>(
      "(()=>{const r=document.querySelector('[data-tool=patch] .otk-tool-toggle').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
    );
    await b.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "right",
      clickCount: 1,
      ...point,
    });
    await b.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "right",
      clickCount: 1,
      ...point,
    });
    await b.poll("!!document.querySelector(':popover-open [role=menu]')");
    assertEquals(
      await b.evaluate(
        "!!document.querySelector(':popover-open [data-context-command=\"tool.copy.path\"]')",
      ),
      false,
    );
    await b.key("Escape");
    await b.click("[data-tool=external] .otk-tool-toggle");
    const count = () =>
      b.evaluate<number>(
        "document.querySelector('[data-tool=external] pre').textContent.split('\\n').length",
      );
    assertEquals(await count(), 10);
    await b.click("[data-tool=external] .otk-output-toggle");
    assertEquals(await count(), 15);
    await b.click("[data-tool=external] .otk-output-toggle");
    assertEquals(await count(), 10);
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      const shots = Deno.env.get("OTK_METADATA_SHOTS");
      if (shots) {
        await Deno.mkdir(shots, { recursive: true });
        await b.evaluate(
          "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
        );
        await b.screenshot(join(shots, `${theme}-metadata.png`));
      }
    }
    assertEquals(b.errors, []);
  } finally {
    await b.close();
    await client.close();
    await f.app.stop();
  }
});
