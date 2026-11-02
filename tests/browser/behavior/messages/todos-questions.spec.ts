// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession } from "../../fixtures/wire.ts";
import { expandTool, prompt, toolScript } from "../../pages/transcript.ts";

test(
  "messages.native-todos-readonly-questions",
  { tag: ["@messages"] },
  async ({ state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Todos and questions",
    });
    await openSession(state, page, session.id);
    const todos = ["pending", "in_progress", "completed", "cancelled"].map(
      (status) => ({ content: `${status} item`, status, priority: "medium" }),
    );
    await toolScript(state, "todowrite", { todos }, "Todos recorded.");
    await prompt(page, "Record the checklist");
    await expandTool(page, "[data-tool=todo]");
    await expect(page.locator(".otk-todos li")).toHaveCount(4);
    expect(
      await page.locator(".otk-todos li").evaluateAll((elements) =>
        elements.map((element) => (element as HTMLElement).dataset.todoStatus)
      ),
    ).toEqual(todos.map((todo) => todo.status));
    await expect(page.locator(`[data-session="${session.id}"]`))
      .toHaveAttribute("data-status", "idle");
    await toolScript(state, "question", {
      questions: [{
        header: "Choice",
        question: "Which rendering?",
        options: [{ label: "Typed", description: "OTK shapes" }, {
          label: "Raw",
          description: "Harness types",
        }],
        multiple: false,
      }],
    }, "Typed answer recorded.");
    await prompt(page, "Ask the scripted question");
    let pending: { id: string }[] = [];
    await expect.poll(async () => {
      pending = await state.native<{ id: string }[]>("/question");
      return pending.length;
    }).toBe(1);
    await expandTool(page, "[data-tool=question]");
    await expect(page.locator(".otk-questions")).toContainText(
      "Awaiting answer",
    );
    await expect(page.locator(".otk-questions button,.otk-questions input"))
      .toHaveCount(0);
    await state.native(`/question/${pending[0].id}/reply`, "POST", {
      answers: [["Typed"]],
    });
    await expect(page.locator(".otk-questions dd")).toHaveText("Typed");
    await expect(page.locator(`[data-session="${session.id}"]`))
      .toHaveAttribute("data-status", "idle");
  },
);
