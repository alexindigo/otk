// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import type { Info, RawPart } from "@otk/harness-opencode1";
test("R5 task progress, real child navigation, parent/history and sibling cycle preserve navigation ownership", async () => {
  const f = await browserFixture({ bash: "ask", task: "allow" });
  try {
    const root = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Subagents" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, root.id);
    f.fake.queue(
      {
        tool: {
          name: "task",
          input: {
            subagent_type: "general",
            description: "First inspection",
            prompt: "Run the child probe",
          },
        },
      },
      {
        tool: {
          name: "bash",
          input: {
            command: "echo child_one",
            description: "Child current command",
          },
        },
      },
      { chunks: ["First child completed."] },
      { chunks: ["First parent completed."] },
    );
    await browser.type("textarea[name=prompt]", "Delegate first");
    await browser.key("Enter");
    await browser.poll(
      "document.querySelector('[data-tool=task] .otk-tool-state')?.textContent.includes('First inspection') && document.querySelector('[data-tool=task] .otk-task-card')?.textContent.includes('Open task') && document.querySelector('[data-tool=task] .otk-task-card')?.textContent.includes('bash') && !!document.querySelector('.otk-permission-dock')",
    );
    await browser.screenshot(join(f.oc.root, "r5-live-task.png"));
    await browser.click(".otk-permission-actions > button:first-child");
    await browser.poll(
      `document.querySelector('[data-tool=task][data-tool-status=completed]')?.textContent.includes('1 tool call') && !document.querySelector('[data-tool=task][data-tool-status=completed]')?.textContent.includes('1 tool calls') && document.querySelector('[data-session="${root.id}"]').dataset.status==='idle'`,
      60000,
    );
    f.fake.queue(
      {
        tool: {
          name: "task",
          input: {
            subagent_type: "general",
            description: "Second inspection",
            prompt: "Answer the second child probe",
          },
        },
      },
      { chunks: ["Second child completed."] },
      { chunks: ["Second parent completed."] },
    );
    await browser.type("textarea[name=prompt]", "Delegate second");
    await browser.key("Enter");
    await browser.poll(
      "document.querySelectorAll('[data-tool=task][data-tool-status=completed]').length===2",
      60000,
    );
    await browser.poll(
      `document.querySelector('[data-session="${root.id}"]').dataset.status==='idle'`,
    );
    const children = await f.oc.request<{ id: string; title: string }[]>(
      `/session/${root.id}/children`,
    );
    assertEquals(children.length, 2);
    const first = children.find((child) =>
        child.title.includes("First inspection")
      )!,
      second = children.find((child) =>
        child.title.includes("Second inspection")
      )!;
    await browser.type("textarea[name=prompt]", "Unsent parent work");
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value==='Unsent parent work' && !document.querySelector('.otk-prompt button[type=submit]').disabled",
    );
    await browser.click(".otk-task-card");
    await browser.poll(
      `location.hash==='#/local/${root.id}/${first.id}' && document.querySelector('.otk-subagent-bar')?.textContent.includes('First inspection') && !document.querySelector('.otk-prompt')`,
    );
    await browser.click(".otk-subagent-bar button:nth-child(3)");
    await browser.poll(
      `location.hash.endsWith('/${second.id}') && document.querySelector('.otk-subagent-bar').textContent.includes('Second inspection')`,
    );
    await browser.click(".otk-subagent-bar button:nth-child(2)");
    await browser.poll(
      `location.hash.endsWith('/${first.id}') && document.querySelector('.otk-subagent-bar')?.textContent.includes('First inspection')`,
    );
    await browser.click(".otk-subagent-bar button:first-child");
    await browser.poll(
      `location.hash==='#/local/${root.id}' && document.querySelector('textarea[name=prompt]').value==='Unsent parent work'`,
    );
    await browser.evaluate("history.back()");
    await browser.poll(
      `location.hash.endsWith('/${first.id}') && document.querySelector('.otk-subagent-bar')?.textContent.includes('First inspection') && !document.querySelector('.otk-prompt')`,
    );
    await browser.screenshot(join(f.oc.root, "r5-child-view.png"));
    await browser.evaluate("history.forward()");
    await browser.poll(
      `location.hash==='#/local/${root.id}' && !!document.querySelector('.otk-prompt')`,
    );
    await browser.poll(
      "document.querySelector('[data-tool=task][data-tool-status=completed] .otk-task-card')?.textContent.includes('1 tool call')",
    );
    const parent = await f.oc.request<{ info: Info; parts: RawPart[] }[]>(
        `/session/${root.id}/message`,
      ),
      child = await f.oc.request<{ info: Info; parts: RawPart[] }[]>(
        `/session/${first.id}/message`,
      );
    await Deno.writeTextFile(
      join(f.oc.root, "recorded-tasks.json"),
      JSON.stringify({ parent, child }, null, 2),
    );
    const frames = await browser.evaluate<string>(
      "document.querySelector('[data-tool=task][data-tool-status=completed] .otk-task-card').textContent",
    );
    assert(
      frames.includes("1 tool call") && !frames.includes("1 tool calls") &&
        /\ds/.test(frames),
    );
    await browser.screenshot(join(f.oc.root, "r5-parent-tasks.png"));
  } finally {
    await f.stop();
  }
});
