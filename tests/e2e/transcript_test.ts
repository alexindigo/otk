// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { AssistantMessage, Message } from "@otk/protocol";
import { usageHeader, UsageLedger } from "@otk/protocol";
import { registerUsage } from "../../core/mod.ts";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import {
  browserFixture,
  openSession,
  sentFrames,
} from "../support/browser-fixture.ts";
import { waitFor } from "../support/opencode.ts";
import { WsClient } from "../support/ws-client.ts";

const prose =
  "A readable reply stays in a centred lane with source and diffs aligned to its shared edges. "
    .repeat(12);
const part = (id: string, text: string) => ({
  id,
  kind: "text" as const,
  synthetic: false,
  blocks: [{ b: "paragraph" as const, inline: [{ i: "text" as const, text }] }],
});
const reply = (id: string): AssistantMessage => ({
  id,
  sessionID: "otk",
  role: "assistant",
  replyTo: "user",
  agent: "build",
  model: { provider: "test", model: "reported-model" },
  time: { created: 2000, completed: 6000, lastOutput: 5500 },
  tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 2, write: 1 } },
  cost: .125,
  interrupted: false,
  parts: [],
});

Deno.test("reading column, renderer disclosures, reply metadata, reported composer settings, retry and tab title", async () => {
  const root = await fixture();
  const base = {
    callID: "call",
    status: "completed" as const,
    awaitingPermission: false,
    time: { start: 2000, end: 6000 },
  };
  const messages: Message[] = [
    {
      id: "user",
      sessionID: "otk",
      role: "user",
      agent: "build",
      model: { provider: "test", model: "reported-model" },
      time: { created: 1000 },
      parts: [part("user-text", "Read this project")],
    },
    {
      ...reply("step-1"),
      parts: [
        part("prose", prose),
        {
          id: "source",
          kind: "text",
          synthetic: false,
          blocks: [{
            b: "code",
            lang: "ts",
            text: "const readingColumn = true;",
          }],
        },
        {
          id: "thought",
          kind: "reasoning",
          time: { start: 2000, end: 6000 },
          blocks: [{
            b: "paragraph",
            inline: [{ i: "text", text: "Reasoning remains available." }],
          }],
        },
        {
          id: "bash",
          kind: "tool",
          call: {
            ...base,
            tool: "bash",
            command: "pwd",
            description: "Project directory",
            output: "reported directory",
          },
        },
        {
          id: "edit",
          kind: "tool",
          call: {
            ...base,
            callID: "edit",
            tool: "edit",
            path: `${root}/projects/otk/source.ts`,
            diagnostics: [],
            files: [{
              path: `${root}/projects/otk/source.ts`,
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
            }],
          },
        },
        { id: "step-boundary", kind: "step", phase: "finish" },
        { id: "bookkeeping", kind: "meta" },
        { id: "step-next", kind: "step", phase: "start" },
        {
          id: "continued-read",
          kind: "tool",
          call: {
            ...base,
            callID: "continued",
            tool: "read",
            output: "Unrecognized read result\n<literal>keep me</literal>",
            path: `${root}/projects/otk/source.ts`,
            loaded: [],
          },
        },
        {
          id: "rename",
          kind: "tool",
          call: {
            ...base,
            callID: "rename",
            tool: "patch",
            files: [{
              path: `${root}/projects/otk/new-name.ts`,
              oldPath: "old-name.ts",
              status: "moved",
              additions: 0,
              deletions: 0,
              hunks: [],
            }],
          },
        },
      ],
    },
    {
      ...reply("step-2"),
      interrupted: true,
      time: { created: 6000, completed: 8000, lastOutput: 7500 },
      parts: [part("done", "The reply is complete.")],
    },
  ];
  const f = await inboxBrowserFixture(root, [], { otk: messages }),
    b = await Cdp.launch(root);
  Object.assign(f.app.backend.capabilities, {
    usage: {
      getUsage: (id: string) =>
        Promise.resolve(
          new UsageLedger(
            id,
            messages.filter((m): m is AssistantMessage =>
              m.role === "assistant"
            ).map(usageHeader),
          ).snapshot(),
        ),
    },
  });
  registerUsage(f.app.connections.rpc, f.app.backend);
  try {
    await b.send("Emulation.setDeviceMetricsOverride", {
      width: 2000,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await b.goto(f.url);
    await b.send("Browser.grantPermissions", {
      origin: f.url,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    await openSession(b, "otk");
    await b.poll(
      "document.querySelectorAll('.otk-message-footer').length===1 && document.title==='Execution — otk — OTK'",
    );
    assertEquals(
      await b.evaluate("document.querySelectorAll('.otk-work-fold').length"),
      1,
    );
    assertEquals(
      await b.evaluate(
        "document.querySelectorAll('[data-role=assistant] .otk-message-role').length",
      ),
      0,
    );
    const geometry = await b.evaluate<
      {
        prose: number;
        code: number;
        left: number;
        codeLeft: number;
        font: string;
        size: string;
        line: string;
      }
    >("(()=>{const p=document.querySelector('[data-message=step-1] .otk-text p'),c=document.querySelector('[data-message=step-1] .otk-code'),a=p.getBoundingClientRect(),z=c.getBoundingClientRect(),s=getComputedStyle(p);return {prose:a.width,code:z.width,left:a.left,codeLeft:z.left,font:s.fontFamily,size:s.fontSize,line:s.lineHeight}})()");
    assert(
      geometry.prose <= 736 && Math.abs(geometry.code - geometry.prose) < .5,
    );
    assert(Math.abs(geometry.left - geometry.codeLeft) < .5);
    assert(geometry.font.includes("IBM Plex Sans"));
    assertEquals([geometry.size, geometry.line], ["14px", "24px"]);
    await b.poll(
      "document.querySelector('[data-tool=bash] .otk-tool-toggle').getAttribute('aria-expanded')==='false' && document.querySelector('[data-tool=bash] .otk-tool-body').hidden",
    );
    await b.click("[data-tool=bash] .otk-tool-toggle");
    await b.poll(
      "!document.querySelector('[data-tool=bash] .otk-tool-body').hidden && document.querySelector('[data-tool=bash] .otk-tool-output').textContent==='reported directory'",
    );
    await b.click("[data-tool=read] .otk-tool-toggle");
    await b.poll(
      "document.querySelector('[data-tool=edit] .otk-tool-body').hidden",
    );
    await b.click("[data-tool=edit] .otk-tool-toggle");
    await b.poll(
      "!document.querySelector('[data-tool=read] .otk-tool-body').hidden && document.querySelector('[data-tool=read] .otk-tool-output').textContent==='Unrecognized read result\\n<literal>keep me</literal>'",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('[data-tool=read] .otk-tool-output literal')",
      ),
      null,
    );
    await b.click("[data-tool=read] .otk-tool-toggle");
    await b.poll(
      "document.querySelector('[data-tool=edit] .otk-tool-toggle').getAttribute('aria-expanded')==='true' && !document.querySelector('[data-tool=edit] .otk-tool-body').hidden && document.querySelector('[data-tool=edit] .otk-diff').textContent.includes('const after = true;')",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('[data-tool=bash] .otk-tool-state').textContent.includes('completed')",
      ),
      false,
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('.otk-reasoning > button').textContent.trim()",
      ),
      "Thought for 4.0s",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('[data-tool=edit] .otk-tool-target').textContent",
      ),
      "source.ts",
    );
    await b.click(".otk-copy-message");
    await b.poll(
      `navigator.clipboard.readText().then(text=>text.includes('A readable reply') && text.includes('The reply is complete.') && !text.includes('Reasoning remains available.'))`,
    );
    await b.click(".otk-reasoning > button");
    await b.poll(
      "document.querySelector('.otk-reasoning-body').textContent.includes('Reasoning remains available.')",
    );
    const footer = await b.evaluate<{ text: string }>(
      "(()=>{const e=document.querySelector('.otk-message-footer');return {text:e.textContent}})()",
    );
    for (
      const value of ["build", "test/reported-model", "6.0s", "interrupted"]
    ) assert(footer.text.includes(value), value);
    assert(footer.text.includes("76 tokens · $0.25"));
    await b.evaluate(
      "document.querySelector('.otk-turn-usage > button').focus()",
    );
    await b.poll("!!document.querySelector('.otk-turn-usage :popover-open')");
    assertEquals(
      await b.evaluate(
        "[...document.querySelector('.otk-usage-breakdown tfoot tr').children].slice(1,6).map(cell=>cell.textContent)",
      ),
      ["20", "40", "10", "4", "2"],
    );
    await b.key("Escape");
    await b.poll(
      "document.querySelector('.otk-prompt-context > span:first-child')?.textContent==='Build' && document.querySelector('.otk-prompt-context .otk-composer-provider')?.textContent==='test' && document.querySelector('.otk-prompt-context .otk-composer-model-name')?.textContent==='reported-model' && !!document.querySelector('[aria-label=\"Attach files\"]')",
    );
    const client = new WsClient(f.url);
    await client.connect();
    try {
      for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
        await client.rpc("prefs.set", { key: "theme", value: theme });
        await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
        const layout = await b.evaluate<
          {
            lane: DOMRect;
            scroll: DOMRect;
            bubble: DOMRect;
            composer: DOMRect;
            border: string;
            radius: string;
            font: string;
            hints: boolean;
          }
        >(`(()=>{const lane=document.querySelector('.otk-message-flow'),scroll=document.querySelector('.otk-messages'),bubble=document.querySelector('.otk-user-bubble'),composer=document.querySelector('.otk-composer'),s=getComputedStyle(composer);return {lane:lane.getBoundingClientRect().toJSON(),scroll:scroll.getBoundingClientRect().toJSON(),bubble:bubble.getBoundingClientRect().toJSON(),composer:composer.getBoundingClientRect().toJSON(),border:s.borderTopWidth,radius:s.borderRadius,font:getComputedStyle(document.querySelector('.otk-message-footer')).fontFamily,hints:/Enter to send|Shift\\+Enter for newline|1 \\/ 2 \\/ 3|j\\/k select/.test(document.querySelector('.otk-session-view').innerText)}})()`);
        assertEquals(
          layout.lane.width,
          await b.evaluate(
            "(()=>{const s=document.querySelector('.otk-messages'),c=getComputedStyle(s);return Math.min(736,s.clientWidth-parseFloat(c.paddingLeft)-parseFloat(c.paddingRight))})()",
          ),
        );
        assert(
          Math.abs(
            (layout.lane.left + layout.lane.right) -
              (layout.scroll.left + layout.scroll.right),
          ) < 1,
        );
        assert(
          Math.abs(layout.lane.left - layout.composer.left) < .5 &&
            Math.abs(layout.lane.right - layout.composer.right) < .5,
        );
        assert(
          layout.bubble.width <= layout.lane.width * .8 + .5 &&
            Math.abs(layout.bubble.right - layout.lane.right) < .5,
        );
        assertEquals([layout.border, layout.radius], ["1px", "20px"]);
        assert(layout.font.includes("IBM Plex Sans"));
        assertEquals(layout.hints, false);
        assertEquals(
          await b.evaluate(
            "document.querySelectorAll('.otk-role-label').length",
          ),
          0,
        );
        const rule = await b.evaluate<
          { width: string; style: string; ratio: number }
        >(`(()=>{const e=document.querySelector('.otk-work-rule'),s=getComputedStyle(e),canvas=document.createElement('canvas');canvas.width=canvas.height=1;const c=canvas.getContext('2d'),rgb=color=>{c.clearRect(0,0,1,1);c.fillStyle=getComputedStyle(document.documentElement).backgroundColor;c.fillRect(0,0,1,1);c.fillStyle=color;c.fillRect(0,0,1,1);return [...c.getImageData(0,0,1,1).data].slice(0,3)},bg=rgb('transparent'),distance=a=>a.reduce((n,v,i)=>n+Math.abs(v-bg[i]),0);return {width:s.borderTopWidth,style:s.borderTopStyle,ratio:distance(rgb(s.borderTopColor))/distance(rgb(s.color))}})()`);
        assertEquals([rule.width, rule.style], ["1px", "solid"]);
        assert(
          rule.ratio > 0 && rule.ratio < .2,
          "Work-fold hairline retains the subtle divider contract",
        );
      }
    } finally {
      await client.close();
    }
    for (const width of [1280, 1600, 2000]) {
      await b.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 1100,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await b.poll(
        "(()=>{const s=document.querySelector('.otk-messages'),c=getComputedStyle(s),lane=document.querySelector('.otk-message-flow').getBoundingClientRect(),composer=document.querySelector('.otk-composer').getBoundingClientRect();return Math.abs(lane.width-Math.min(736,s.clientWidth-parseFloat(c.paddingLeft)-parseFloat(c.paddingRight)))<.5 && Math.abs(lane.width-composer.width)<.5 && Math.abs(lane.left-composer.left)<.5})()",
      );
    }
    await b.click("[data-tool=patch] .otk-tool-toggle");
    await b.poll(
      "!document.querySelector('[data-tool=patch] .otk-tool-body').hidden",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('[data-tool=patch] .otk-tool-target').textContent",
      ),
      "new-name.ts",
    );
    assert(
      await b.evaluate(
        "document.querySelector('[data-tool=patch] .otk-diff > header')?.textContent.includes('old-name.ts')",
      ),
      "Single-file inline cards retain the rename source",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('[data-tool=patch] .otk-diff > header').textContent.includes('new-name.ts')",
      ),
      false,
    );
    await b.click(".otk-work-fold");
    await b.poll(
      "document.querySelector('.otk-work-body').hidden && document.querySelector('.otk-work-fold').getAttribute('aria-expanded')==='false'",
    );
    await b.click(".otk-work-fold");
    await b.poll(
      "!document.querySelector('.otk-work-body').hidden && document.querySelector('[data-tool=edit] .otk-diff').getBoundingClientRect().height>0",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('[data-tool=edit] .otk-diff > header')",
      ),
      null,
    );
    f.update("otk", {
      status: "retry",
      retry: {
        attempt: 2,
        message: "Provider is temporarily unavailable",
        next: Date.now() + 6000,
      },
    });
    await b.poll(
      "document.querySelector('.otk-retry-banner')?.textContent.includes('Provider is temporarily unavailable')",
    );
    const before = await b.evaluate<string>(
      "document.querySelector('.otk-retry-banner').textContent",
    );
    await b.poll(
      `document.querySelector('.otk-retry-banner').textContent!==${
        JSON.stringify(before)
      }`,
    );
    f.update("otk", { status: "idle", retry: undefined });
    await b.poll("!document.querySelector('.otk-retry-banner')");
    await openSession(b, "atmosphera");
    await b.poll("document.title==='Approval — atmosphera — OTK'");
  } finally {
    await b.close();
    await f.app.stop();
  }
});

Deno.test("composer takeovers retain a browser draft through permissions, questions and session switches while actions reach stock backend", async () => {
  const f = await browserFixture({ bash: "ask" });
  try {
    const a = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Draft and takeover" },
    });
    const other = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Other draft" },
    });
    const server = await f.sidecar(), b = await f.browser(server.url);
    await openSession(b, a.id);
    await b.type("textarea[name=prompt]", "Keep this session's unsent work");
    f.fake.queue({
      tool: {
        name: "bash",
        input: {
          command: "printf takeover-bytes",
          description: "Permission outcome",
        },
      },
    }, { chunks: ["Permission finished."] });
    await f.oc.request(`/session/${a.id}/prompt_async`, {
      method: "POST",
      body: { parts: [{ type: "text", text: "Run a separate backend turn" }] },
    });
    await b.poll(
      "!!document.querySelector('.otk-permission-dock') && document.querySelector('.otk-composer').dataset.takeover==='true' && getComputedStyle(document.querySelector('.otk-permission-dock .otk-surface')).borderTopWidth==='1px' && !!document.querySelector('.otk-prompt').closest('[hidden]') && document.querySelector('.otk-prompt button[type=submit]').disabled",
    );
    await openSession(b, other.id);
    await b.type("textarea[name=prompt]", "Other session's draft");
    await openSession(b, a.id);
    await b.poll(
      "!!document.querySelector('.otk-permission-dock') && document.querySelector('textarea[name=prompt]').value===\"Keep this session's unsent work\"",
    );
    await b.click(".otk-permission-actions .otk-primary");
    await b.poll(
      `!document.querySelector('.otk-permission-dock') && document.querySelector('[data-session="${a.id}"]').dataset.status==='idle' && !document.querySelector('.otk-prompt').closest('[hidden]') && document.querySelector('textarea[name=prompt]').value===\"Keep this session's unsent work\"`,
    );
    await b.click("[data-tool=bash] .otk-tool-toggle");
    await b.poll(
      "document.querySelector('[data-tool=bash] .otk-tool-output').textContent==='takeover-bytes'",
    );
    f.fake.queue({
      tool: {
        name: "question",
        input: {
          questions: [{
            header: "Next step",
            question: "Which path?",
            options: [{
              label: "Continue",
              description: "Use the selected path",
            }],
          }],
        },
      },
    }, { chunks: ["Answer finished."] });
    await f.oc.request(`/session/${a.id}/prompt_async`, {
      method: "POST",
      body: {
        parts: [{ type: "text", text: "Ask a separate backend question" }],
      },
    });
    await b.poll(
      "!!document.querySelector('.otk-question-dock') && !!document.querySelector('.otk-prompt').closest('[hidden]')",
    );
    await b.click(".otk-question-options button");
    await b.poll(
      "document.querySelector('.otk-question-actions .otk-primary')?.textContent.trim()==='Answer'",
    );
    await b.click(".otk-question-actions .otk-primary");
    await b.poll(
      "document.querySelector('.otk-question-dock [role=tab]:last-child').getAttribute('aria-selected')==='true'",
    );
    await b.click(".otk-question-actions .otk-primary");
    await b.poll(
      `!document.querySelector('.otk-question-dock') && document.querySelector('[data-session="${a.id}"]').dataset.status==='idle' && document.querySelector('textarea[name=prompt]').value===\"Keep this session's unsent work\"`,
    );
    const raw = await waitFor(
      () =>
        f.oc.request<
          {
            parts: {
              tool?: string;
              state?: { metadata?: { answers?: string[][] } };
            }[];
          }[]
        >(`/session/${a.id}/message`),
      (rows) =>
        rows.some((row) =>
          row.parts.some((part) =>
            part.tool === "question" && !!part.state?.metadata?.answers
          )
        ),
    );
    assert(
      raw.some((row) =>
        row.parts.some((part) =>
          part.state?.metadata?.answers?.[0]?.includes("Continue")
        )
      ),
    );
    assert(
      sentFrames(b).some(({ frame }) => frame.method === "permission.reply"),
    );
    assert(
      sentFrames(b).some(({ frame }) => frame.method === "question.reply"),
    );
    await openSession(b, other.id);
    await b.poll(
      "document.querySelector('textarea[name=prompt]').value===\"Other session's draft\"",
    );
  } finally {
    await f.stop();
  }
});
