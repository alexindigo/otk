// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { AssistantMessage, Message } from "@otk/protocol";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import {
  browserFixture,
  openSession,
  sentFrames,
} from "../support/browser-fixture.ts";
import { waitFor } from "../support/opencode.ts";

const prose =
  "A readable reply stays in a left-aligned reading column while source and diffs can use the whole centre. "
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

Deno.test("reading column, open renderer summaries, default edit diffs, reply metadata, reported composer settings, retry and tab title", async () => {
  const root = await fixture();
  const base = {
    callID: "call",
    status: "completed" as const,
    awaitingPermission: false,
    time: {},
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
            path: "source.ts",
            diagnostics: [],
            files: [{
              path: "source.ts",
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
  try {
    await b.send("Emulation.setDeviceMetricsOverride", {
      width: 2000,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await b.goto(f.url);
    await openSession(b, "otk");
    await b.poll(
      "document.querySelectorAll('.otk-message-footer').length===1 && document.title==='Execution — otk — OTK'",
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
    assert(geometry.prose <= 760 && geometry.code > geometry.prose);
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
      "Thought · 4.0s",
    );
    await b.click(".otk-reasoning > button");
    await b.poll(
      "document.querySelector('.otk-reasoning-body').textContent.includes('Reasoning remains available.')",
    );
    const footer = await b.evaluate<{ text: string; title: string }>(
      "(()=>{const e=document.querySelector('.otk-message-footer');return {text:e.textContent,title:e.title}})()",
    );
    for (
      const value of ["build", "test/reported-model", "6.0s", "interrupted"]
    ) assert(footer.text.includes(value), value);
    for (
      const value of [
        "Input 20",
        "output 40",
        "reasoning 10",
        "cache read 4",
        "cache write 2",
        "$0.25",
      ]
    ) assert(footer.title.includes(value), value);
    await b.poll(
      "document.querySelector('.otk-prompt-context').textContent.includes('build') && document.querySelector('.otk-prompt-context').textContent.includes('test/reported-model') && !!document.querySelector('[aria-label=\"Attach files\"]')",
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
      "!!document.querySelector('.otk-permission-dock') && document.querySelector('.otk-composer').dataset.takeover==='true' && getComputedStyle(document.querySelector('.otk-composer')).borderTopWidth==='1px' && !!document.querySelector('.otk-prompt').closest('[hidden]') && document.querySelector('.otk-prompt button[type=submit]').disabled",
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
