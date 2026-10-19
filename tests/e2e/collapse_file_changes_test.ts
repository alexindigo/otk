// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  type AssistantMessage,
  type FileDiff,
  type Message,
  type Preferences,
  usageHeader,
  UsageLedger,
} from "@otk/protocol";
import { fixture } from "../support/config.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { Cdp } from "../support/cdp.ts";
import { WsClient } from "../support/ws-client.ts";

Deno.test("U6 file changes start collapsed, disclose real content and follow the persisted Display preference", async () => {
  const root = await fixture();
  const file = (path: string): FileDiff => ({
    path,
    status: "modified",
    additions: 1,
    deletions: 1,
    hunks: [{
      oldStart: 1,
      newStart: 1,
      oldLines: 1,
      newLines: 1,
      lines: [
        { kind: "del", text: "const before = true;", oldNo: 1 },
        { kind: "add", text: "const after = true;", newNo: 1 },
      ],
    }],
  });
  const base = {
    callID: "call",
    status: "completed" as const,
    awaitingPermission: false,
    time: { start: 2000, end: 6000 },
  };
  const reply: AssistantMessage = {
    id: "reply",
    sessionID: "core",
    replyTo: "user",
    role: "assistant",
    agent: "build",
    model: { provider: "test", model: "test" },
    time: { created: 2000, completed: 6000 },
    tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    interrupted: false,
    parts: [
      {
        id: "edit",
        kind: "tool",
        call: {
          ...base,
          tool: "edit",
          path: `${root}/edit.ts`,
          files: [file(`${root}/edit.ts`)],
          diagnostics: [],
        },
      },
      {
        id: "write",
        kind: "tool",
        call: {
          ...base,
          callID: "write",
          tool: "write",
          path: `${root}/write.ts`,
          content: "const written = true;",
          lang: "ts",
          diagnostics: [],
        },
      },
      {
        id: "patch",
        kind: "tool",
        call: {
          ...base,
          callID: "patch",
          tool: "patch",
          files: [file(`${root}/patch.ts`)],
        },
      },
      {
        id: "read",
        kind: "tool",
        call: {
          ...base,
          callID: "read",
          tool: "read",
          path: `${root}/read.ts`,
          loaded: [],
          output: "Read result",
        },
      },
    ],
  };
  const messages: Message[] = [{
    id: "user",
    sessionID: "core",
    role: "user",
    time: { created: 1000 },
    parts: [{
      id: "text",
      kind: "text",
      synthetic: false,
      blocks: [{
        b: "paragraph",
        inline: [{ i: "text", text: "Review the file changes" }],
      }],
    }],
  }, reply];
  const f = await coreBackendFixture(root, {
    usage: {
      getUsage: () =>
        Promise.resolve(
          new UsageLedger("core", [usageHeader(reply)]).snapshot(),
        ),
    },
    prompt: { prompt: () => Promise.resolve(), abort: () => Promise.resolve() },
  });
  f.app.backend.core.listMessages = () => Promise.resolve(messages);
  const b = await Cdp.launch(root), c = new WsClient(f.url);
  const shots = Deno.env.get("OTK_COLLAPSE_SHOTS");
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
  const state = async (open: boolean) => {
    await b.poll(
      `[...document.querySelectorAll('[data-tool=edit], [data-tool=write], [data-tool=patch]')].length===3 && [...document.querySelectorAll('[data-tool=edit], [data-tool=write], [data-tool=patch]')].every(row=>row.querySelector('.otk-tool-toggle').getAttribute('aria-expanded')==='${open}' && row.querySelector('.otk-tool-body').hidden===${!open} && (row.querySelector('.otk-tool-body').getBoundingClientRect().height>0)===${open})`,
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('[data-tool=read] .otk-tool-body').hidden",
      ),
      true,
    );
  };
  try {
    await c.connect();
    await c.rpc("prefs.set", { key: "animationsOff", value: true });
    await b.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await b.goto(`${f.url}/#/local/core`);
    await b.poll(
      "document.querySelectorAll('.otk-tool-line').length===4 && !!document.querySelector('.otk-turn-usage > button')",
    );
    await capture("default");
    await state(false);
    assertEquals(
      (await c.rpc<Preferences>("prefs.get", {})).collapseFileChanges,
      true,
    );
    for (const tool of ["edit", "patch"]) {
      assertEquals(
        await b.evaluate(
          `document.querySelector('[data-tool=${tool}] .otk-tool-target').textContent`,
        ),
        `${tool}.ts`,
      );
      assertEquals(
        await b.evaluate(
          `document.querySelector('[data-tool=${tool}] .otk-tool-add').textContent`,
        ),
        "+1",
      );
      assertEquals(
        await b.evaluate(
          `document.querySelector('[data-tool=${tool}] .otk-tool-del').textContent`,
        ),
        "−1",
      );
    }
    for (const tool of ["edit", "write", "patch"]) {
      await b.click(`[data-tool=${tool}] .otk-tool-toggle`);
    }
    await state(true);
    await b.poll(
      "document.querySelector('[data-tool=edit] .otk-diff').innerText.includes('const after = true;') && document.querySelector('[data-tool=patch] .otk-diff').innerText.includes('const after = true;') && document.querySelector('[data-tool=write] .otk-code').innerText.includes('const written = true;')",
    );
    await capture("manual-open");
    await b.reload();
    await state(false);
    await b.click(".otk-display-menu > button");
    await b.poll(
      "document.querySelector('input[name=collapseFileChanges]')?.checked===true",
    );
    await capture("display-on");
    await b.click("input[name=collapseFileChanges]");
    await state(true);
    await b.key("Escape");
    assertEquals(
      (await c.rpc<Preferences>("prefs.get", {})).collapseFileChanges,
      false,
    );
    await b.reload();
    await state(true);
    await capture("off-reload");
    // Explicit disclosure belongs to the row; a preference changes initial state.
    await b.click("[data-tool=edit] .otk-tool-toggle");
    await c.rpc("prefs.set", { key: "collapseFileChanges", value: true });
    await state(false);
    await c.rpc("prefs.set", { key: "collapseFileChanges", value: false });
    await b.poll(
      "document.querySelector('[data-tool=edit] .otk-tool-body').hidden && !document.querySelector('[data-tool=write] .otk-tool-body').hidden && !document.querySelector('[data-tool=patch] .otk-tool-body').hidden",
    );
    await b.reload();
    await state(true);
    await c.rpc("prefs.set", { key: "collapseFileChanges", value: true });
    await state(false);
    await b.reload();
    await state(false);
    assertEquals(b.errors, []);
  } finally {
    await Deno.writeTextFile(
      `${root}/collapse-state.html`,
      await b.evaluate<string>("document.documentElement.outerHTML"),
    );
    console.info("Collapse browser evidence:", root);
    await c.close();
    await b.close();
    await f.app.stop();
  }
});

Deno.test("U6 one-token labels and literal fallback phrases reach plain and picker footers", async () => {
  for (const picker of [false, true]) {
    const root = await fixture();
    const reply: AssistantMessage = {
      id: "reply",
      sessionID: "core",
      role: "assistant",
      replyTo: "user",
      agent: "build",
      model: { provider: "test", model: "test" },
      time: { created: 1000, completed: 2000 },
      tokens: {
        input: 1,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: 0,
      interrupted: false,
      parts: [],
    };
    const f = await coreBackendFixture(root, {
      prompt: {
        prompt: () => Promise.resolve(),
        abort: () => Promise.resolve(),
      },
      usage: {
        getUsage: () =>
          Promise.resolve(
            new UsageLedger("core", [usageHeader(reply)]).snapshot(),
          ),
      },
      ...(picker ? { agents: { listAgents: () => Promise.resolve([]) } } : {}),
    });
    f.app.backend.core.listMessages = () => Promise.resolve([reply]);
    const b = await Cdp.launch(root), c = new WsClient(f.url);
    try {
      await c.connect();
      await c.rpc("prefs.set", { key: "animationsOff", value: true });
      await b.goto(`${f.url}/#/local/core`);
      await b.poll(
        "!!document.querySelector('.otk-turn-usage > button') && !!document.querySelector('.otk-composer-model-name')",
      );
      const capture = async (name: string) => {
        const shots = Deno.env.get("OTK_COLLAPSE_SHOTS");
        if (!shots) return;
        await Deno.mkdir(shots, { recursive: true });
        for (
          const [label, theme] of [["dark", "otk-dark"], ["light", "otk-light"]]
        ) {
          await c.rpc("prefs.set", { key: "theme", value: theme });
          await b.poll(
            `document.documentElement.dataset.otkTheme==='${theme}'`,
          );
          await b.evaluate(
            "document.activeElement?.blur(); document.fonts.ready",
          );
          await b.screenshot(
            `${shots}/${name}-${label}.png`,
          );
        }
      };
      await capture(`labels-${picker ? "picker" : "plain"}`);
      assertEquals(
        await b.evaluate(
          "document.querySelector('.otk-context-meter > span').textContent",
        ),
        "1 token",
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('.otk-turn-usage > button').textContent",
        ),
        "1 token · $0.00",
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('.otk-turn-usage > button').getAttribute('aria-label')",
        ),
        "Turn usage: 1 token · $0.00",
      );
      assertEquals(
        await b.evaluate(
          picker
            ? "document.querySelector('.otk-agent-picker .otk-composer-agent').textContent"
            : "document.querySelector('.otk-prompt-context > span').textContent",
        ),
        "Default agent",
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('.otk-composer-model-name').textContent",
        ),
        "Default model",
      );
      if (picker) {
        assertEquals(
          await b.evaluate(
            "document.querySelector('.otk-agent-picker > button').getAttribute('aria-label')",
          ),
          "Agent: Default agent",
        );
      } else {
        await b.evaluate(
          `(()=>{const d=new DataTransfer();d.setData('text/plain',${
            JSON.stringify("long pasted line ".repeat(20))
          });document.querySelector('textarea[name=prompt]').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:d}));})()`,
        );
        await b.poll(
          "document.querySelector('.otk-prompt-chip')?.textContent.includes('[Pasted ~1 line]')",
        );
        f.app.connections.content("core", {
          op: "session.revert",
          messageID: "user",
          messageCount: 1,
          files: [{ path: "example.ts", additions: 1, deletions: 1 }],
        });
        await b.poll(
          "document.querySelector('.otk-revert-banner strong')?.textContent==='1 message reverted'",
        );
        await capture("paste-revert");
      }
      assertEquals(b.errors, []);
    } finally {
      console.info("Labels browser evidence:", root);
      await c.close();
      await b.close();
      await f.app.stop();
    }
  }
});
