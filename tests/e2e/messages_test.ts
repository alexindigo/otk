// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assertEquals } from "@std/assert";
import type { Message, UserMessage } from "@otk/protocol";
import {
  legacyStaticMessages,
  visualReply,
  visualText,
} from "../support/legacy-message-scene.ts";
const user = (id: string, text: string): UserMessage => ({
  id,
  sessionID: "tstv1-core",
  role: "user",
  time: { created: id === "queued" ? 7000 : 1 },
  parts: [visualText(id + "-text", text)],
});
test("R8 revert RPC restores files, hides reverted turns and persists a joined counted strip on reload", async () => {
  await legacyStaticMessages(
    "otk-dark",
    () => [user("prompt", "Review the file changes")],
    async ({ b, capture }) => {
      await b.poll(
        "document.querySelector('.otk-rolled-back-strip')?.textContent.includes('1 prompt rolled back')",
      );
      await capture("reverted-strip");
      await b.click(".otk-rollback-disclosure");
      await b.poll(
        "document.querySelector('.otk-rollback-details')?.textContent.includes('revert.txt')",
      );
      await capture("reverted-strip-details");
    },
    {
      configure: (f) =>
        Object.assign(f.session, {
          revert: {
            messageID: "prompt",
            messageCount: 1,
            files: [{ path: "revert.txt", additions: 1, deletions: 1 }],
          },
        }),
    },
  );
});
test("real harness history renders file/agent chips and compaction divider", async () => {
  await legacyStaticMessages(
    "otk-dark",
    () => [{
      ...user("prompt", "Historical parts"),
      parts: [
        visualText("text", "Historical parts"),
        {
          id: "file",
          kind: "file",
          mime: "text/plain",
          name: "fixture.txt",
          url: "file:///fixture.txt",
        },
        { id: "agent", kind: "agent", name: "general" },
        { id: "compaction", kind: "compaction" },
      ],
    }],
    async ({ b, capture }) => {
      await b.poll(
        "document.querySelector('.otk-messages').textContent.includes('File: fixture.txt')&&document.querySelector('.otk-messages').textContent.includes('Agent: general')&&!!document.querySelector('.otk-compaction-divider')",
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('.otk-compaction-divider').closest('.otk-user-bubble')===null",
        ),
        true,
      );
      await capture("chips-compaction");
    },
  );
});
test("message details show configured agent colour, queued-to-answered transition and no step scaffolds", async () => {
  const states = (
    done: boolean,
  ): Message[] => [
    user("prompt", "First prompt"),
    visualReply("first", [visualText("first-text", "First reply continues.")], {
      agentColor: "#6bacff",
      time: { created: 2, ...(done ? { completed: 6000 } : {}) },
    }),
    user("queued", "Queued prompt"),
    ...(done
      ? [
        visualReply("last", [
          visualText("last-text", "Queued prompt answered."),
        ], { replyTo: "queued", agentColor: "#6bacff" }),
      ]
      : []),
  ];
  await legacyStaticMessages(
    "otk-dark",
    () => states(false),
    async ({ b, replace, capture, status }) => {
      for (const done of [false, true]) {
        if (done) {
          status("idle");
          await replace(states(true));
        }
        await b.poll(
          done
            ? "!document.querySelector('.otk-queued')"
            : "!!document.querySelector('.otk-queued')",
        );
        await b.click(".otk-message-agent");
        assertEquals(
          await b.evaluate(
            "getComputedStyle(document.querySelector('.otk-message-agent')).color",
          ),
          "rgb(107, 172, 255)",
        );
        assertEquals(
          await b.evaluate(
            "getComputedStyle(document.querySelector('[data-role=user]')).borderLeftWidth",
          ),
          "0px",
        );
        await capture(done ? "message-answered" : "message-queued");
      }
    },
    {
      configure: (f) =>
        f.app.index.upsert({
          ...f.app.index.get("tstv1-core")!,
          status: "busy",
        }),
    },
  );
});
