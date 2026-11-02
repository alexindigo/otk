// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assertEquals } from "@std/assert";
import {
  legacyStaticMessages,
  visualReply,
} from "../support/legacy-message-scene.ts";
import type { QuestionCall } from "@otk/protocol";

test("R4 todo checklist states and read-only question answers from real opencode", async () => {
  const question: QuestionCall = {
    tool: "question",
    callID: "question",
    status: "running",
    awaitingPermission: false,
    time: { start: 2000 },
    questions: [{
      text: "Which rendering?",
      options: [
        { label: "Typed", description: "OTK shapes" },
        { label: "Raw", description: "Harness types" },
      ],
    }],
  };
  const snapshot = (answered: boolean) => [visualReply("reply", [
    {
      id: "todo",
      kind: "tool",
      call: {
        tool: "todo",
        callID: "todo",
        status: "completed",
        awaitingPermission: false,
        time: { start: 1000, end: 2000 },
        items: ["pending", "in_progress", "completed", "cancelled"].map((
          status,
        ) => ({
          content: `${status} item`,
          status: status as
            | "pending"
            | "in_progress"
            | "completed"
            | "cancelled",
          priority: "medium",
        })),
      },
    },
    {
      id: "question",
      kind: "tool",
      call: answered
        ? {
          ...question,
          status: "completed",
          time: { start: 2000, end: 3000 },
          questions: [{ ...question.questions[0], answer: ["Typed"] }],
        }
        : question,
    },
  ])];
  await legacyStaticMessages(
    "otk-dark",
    () => snapshot(false),
    async ({ b, replace, capture }) => {
      for (const answered of [false, true]) {
        if (answered) await replace(snapshot(true));
        for (const tool of ["todo", "question"]) {
          await b.click(
            `[data-tool=${tool}] .otk-tool-toggle`,
          );
        }
        await b.poll("document.querySelectorAll('.otk-todos li').length===4");
        assertEquals(
          await b.evaluate(
            "[...document.querySelectorAll('.otk-todos li')].map(e=>e.dataset.todoStatus)",
          ),
          ["pending", "in_progress", "completed", "cancelled"],
        );
        await b.poll(
          answered
            ? "document.querySelector('.otk-questions dd')?.textContent==='Typed'"
            : "document.querySelector('.otk-questions')?.textContent.includes('Awaiting answer')",
        );
        assertEquals(
          await b.evaluate(
            "document.querySelectorAll('.otk-questions button,.otk-questions input').length",
          ),
          0,
        );
        await capture(
          answered ? "todos-question-answered" : "question-pending",
        );
      }
    },
  );
});
