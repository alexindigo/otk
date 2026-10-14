// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { waitFor } from "../support/opencode.ts";
import type { RawPart } from "@otk/harness-opencode1";
Deno.test("R4 todo checklist states and read-only question answers from real opencode", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Todos and questions" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    const todos = ["pending", "in_progress", "completed", "cancelled"].map((
      status,
    ) => ({ content: `${status} item`, status, priority: "medium" }));
    f.fake.queue({ tool: { name: "todowrite", input: { todos } } }, {
      chunks: ["Todos recorded."],
    });
    await browser.type("textarea[name=prompt]", "Record the checklist");
    await browser.key("Enter");
    await browser.poll(
      "document.querySelectorAll('.otk-todos li').length === 4",
    );
    assertEquals(
      await browser.evaluate(
        "[...document.querySelectorAll('.otk-todos li')].map(el=>el.dataset.todoStatus)",
      ),
      todos.map((item) => item.status),
    );
    await browser.poll(
      `document.querySelector('[data-session="${session.id}"]').dataset.status === 'idle'`,
    );
    f.fake.queue({
      tool: {
        name: "question",
        input: {
          questions: [{
            header: "Choice",
            question: "Which rendering?",
            options: [{ label: "Typed", description: "OTK shapes" }, {
              label: "Raw",
              description: "Harness types",
            }],
            multiple: false,
          }],
        },
      },
    }, { chunks: ["Typed answer recorded."] });
    await browser.type("textarea[name=prompt]", "Ask the scripted question");
    await browser.key("Enter");
    const pending = await waitFor(
      () => f.oc.request<{ id: string }[]>("/question"),
      (items) => items.length === 1,
    );
    await browser.poll(
      "document.querySelector('.otk-questions')?.textContent.includes('Awaiting answer')",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelectorAll('.otk-questions button, .otk-questions input').length",
      ),
      0,
    );
    await browser.screenshot(join(f.oc.root, "r4-question-pending.png"));
    await f.oc.request(`/question/${pending[0].id}/reply`, {
      method: "POST",
      body: { answers: [["Typed"]] },
    });
    await browser.poll(
      "document.querySelector('.otk-questions dd')?.textContent === 'Typed'",
    );
    await browser.poll(
      `document.querySelector('[data-session="${session.id}"]').dataset.status === 'idle'`,
    );
    const raw = await f.oc.request<{ parts: RawPart[] }[]>(
      `/session/${session.id}/message`,
    );
    await Deno.writeTextFile(
      join(f.oc.root, "recorded-todo-question-parts.json"),
      JSON.stringify(
        raw.flatMap((m) => m.parts).filter((p) =>
          p.type === "tool" || p.type === "reasoning"
        ),
        null,
        2,
      ),
    );
    await browser.screenshot(join(f.oc.root, "r4-todos-question-answered.png"));
  } finally {
    await f.stop();
  }
});
