// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import type { TestState } from "../../fixtures/test-state.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { seed, tool } from "../../pages/attention.ts";
import { subagentLamp, subagents } from "../../pages/crumbs.ts";

const tags = { tag: ["@attention", "@sessions", "@isolated"] };
const submit = (state: TestState, sessionID: string, text: string) =>
  state.product("session.prompt", {
    sessionID,
    mode: "normal",
    parts: [{ kind: "text", text }],
  });

interface NativePart {
  id?: string;
  type?: string;
  name?: string;
  tool?: string;
  synthetic?: boolean;
  text?: string;
  state?: {
    status?: string;
    output?: string;
    metadata?: { sessionID?: string; sessionId?: string; status?: string };
    content?: { type?: string; text?: string }[];
  };
}
interface NativeMessage {
  id?: string;
  type?: string;
  metadata?: { source?: string; state?: string; childID?: string };
  content?: NativePart[];
  parts?: NativePart[];
  info?: {
    id: string;
    role: string;
    type?: string;
    metadata?: NativeMessage["metadata"];
    time?: { completed?: number };
  };
}

async function receipts(state: TestState, parent: string, child: string) {
  const messages = await state.native<NativeMessage[]>(
    `/session/${parent}/message`,
  );
  const result: string[] = [];
  for (const message of messages) {
    const nativeMessage = message.info ?? message;
    if (
      nativeMessage.type === "synthetic" &&
      nativeMessage.metadata?.source === "subagent" &&
      nativeMessage.metadata.childID === child &&
      nativeMessage.metadata.state === "completed"
    ) result.push(nativeMessage.id!);
    for (const part of message.parts ?? message.content ?? []) {
      const native = part.state;
      if (
        part.type === "text" && part.synthetic === true &&
        part.text?.includes(`<task id="${child}" state="completed">`)
      ) result.push(part.id!);
      if (part.type !== "tool" || native?.status !== "completed") continue;
      if (
        part.tool === "task" && native.metadata?.sessionId === child &&
        native.output?.includes(`<task id="${child}" state="completed">`)
      ) result.push(part.id!);
      if (
        part.name === "subagent" && native.metadata?.sessionID === child &&
        native.metadata.status === "completed" &&
        native.content?.some((content) => content.type === "text")
      ) result.push(part.id!);
    }
  }
  return result;
}

test("attention.helper-resumed-results-clear-each-run", tags, async ({
  isolatedState: state,
  page,
}, info) => {
  test.setTimeout(120_000);
  const parent = await seed(state, "Parent receiving resumed helper");
  const v2 = parent.id.startsWith("opcv2-");
  const delegate = (child?: string) => tool(
    state,
    v2 ? "subagent" : "task",
    {
      description: "Repeat helper execution",
      prompt: child ? "Report your second result" : "Report your first result",
      ...(v2
        ? {
          agent: "explore",
          background: true,
          ...(child ? { sessionID: child } : {}),
        }
        : { subagent_type: "general", ...(child ? { task_id: child } : {}) }),
    },
  );
  const transcript = page.getByRole("region", { name: "Transcript", exact: true });
  const stream = await wire(page);
  await openSession(state, page, parent.id);
  let child: string | undefined;
  const idleClocks = new Set<number | string>();
  for (let run = 1; run <= 3; run++) {
    await delegate(child);
    const held = await state.queue([`Helper answer ${run}`], "held");
    if (v2) await state.queue([`Parent is awaiting helper ${run}`]);
    const continuation = await state.queue([`Parent got result ${run}`], "held");
    let released = false;
    try {
      await submit(state, parent.id, `Delegate run ${run}`);
      await expect(subagents(page)).toBeVisible();
      const children = await state.native<{ id: string }[]>(
        `/session/${parent.nativeID}/children`,
      );
      expect(children).toHaveLength(1);
      child ??= children[0].id;
      expect(children[0].id).toBe(child);
      const childID = state.sessionID(child);
      if (v2) await expect(transcript).toContainText(`Parent is awaiting helper ${run}`);
      await subagents(page).click();
      await expect(subagentLamp(page, childID)).toHaveAttribute(
        "data-state",
        "working",
      );
      expect(await receipts(state, parent.nativeID, child)).toHaveLength(run - 1);
      await state.release(held.gate);
      released = true;
      await expect.poll(() => receipts(state, parent.nativeID, child!))
        .toHaveLength(run);
      const received = await receipts(state, parent.nativeID, child);
      const messages = await state.native<NativeMessage[]>(`/session/${child}/message`);
      // The browser fixture omits V2 idle rows from its V1-compatible message
      // read; pair the successful assistant identity with the native idle fact.
      const terminalIDs = messages.flatMap((m) =>
        m.info?.role === "assistant" && m.info.time?.completed ? [m.info.id] : []
      );
      if (v2) {
        const session = await state.native<{
          outcome?: string;
          time: { idle?: number | string };
        }>(`/session/${child}`);
        expect(session.outcome).toBe("succeeded");
        expect(session.time.idle).toBeTruthy();
        idleClocks.add(session.time.idle!);
        expect(idleClocks.size).toBe(run);
      }
      expect(new Set(terminalIDs).size).toBe(run);
      expect(new Set(received).size).toBe(run);
      await info.attach(`native-run-${run}`, {
        body: JSON.stringify({ childID, terminalIDs, idleClocks: [...idleClocks], received }),
        contentType: "application/json",
      });
      await expect(subagents(page)).toHaveCount(0);
    } finally {
      if (!released) await state.release(held.gate);
      await state.release(continuation.gate);
      await info.attach(`state-run-${run}`, {
        body: JSON.stringify(stream.received.filter((frame) =>
          frame.t === "inbox.patch" || frame.t === "index.patch"
        )),
        contentType: "application/json",
      });
    }
    await expect(transcript).toContainText(`Parent got result ${run}`);
  }
});
