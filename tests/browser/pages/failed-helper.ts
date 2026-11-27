// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "@playwright/test";
import type { TestState } from "../fixtures/test-state.ts";
import { seed, tool } from "./attention.ts";

interface NativeMessage {
  info: {
    id: string;
    role: string;
    error?: unknown;
    metadata?: { source?: string; childID?: string; state?: string };
    time?: { completed?: number | string };
  };
  parts: {
    id?: string;
    type: string;
    synthetic?: boolean;
    text?: string;
    tool?: string;
    state?: {
      status?: string;
      output?: string;
      metadata?: { sessionId?: string };
    };
  }[];
}

const messages = (state: TestState, id: string) =>
  state.native<NativeMessage[]>(`/session/${id}/message`);

const submit = (state: TestState, sessionID: string, text: string) =>
  state.product("session.prompt", {
    sessionID,
    mode: "normal",
    parts: [{ kind: "text", text }],
  });

/** Only native HTTP facts; never writes Inbox, attention, or digest state. */
export async function liveFailedHelper(state: TestState) {
  const parent = await seed(state, "Parent of failed helper");
  const v2 = parent.id.startsWith("opcv2-");
  await tool(state, v2 ? "subagent" : "task", {
    description: "Scripted helper failure",
    prompt: "Run the provider error fixture",
    background: true,
    ...(v2 ? { agent: "explore" } : { subagent_type: "general" }),
  });
  const { gate } = await state.controller.call<{ gate: string }>(
    "queueScript",
    {
      lease: state.lease.lease,
      chunks: [],
      failHelper: true,
      gate: "held",
    },
  );
  const initial = "Parent waiting for failure result";
  await state.queue([initial]);
  await state.queue(["Parent observed the result"]);
  const children = () =>
    state.native<{ id: string }[]>(`/session/${parent.nativeID}/children`);
  try {
    await submit(state, parent.id, "Delegate a failing child");
    await expect.poll(async () => (await children()).length).toBe(1);
    await expect.poll(async () =>
      (await messages(state, parent.nativeID)).some(({ info, parts }) =>
        info.role === "assistant" && info.time?.completed &&
        parts.some(({ text }) => text === initial)
      )
    ).toBe(true);
  } finally {
    await state.release(gate);
  }
  const child = (await children())[0].id;
  const failure = async () =>
    (await messages(state, child)).reverse().find(({ info }) =>
      info.role === "assistant" && info.error && info.time?.completed
    )?.info;
  const receipt = async () => {
    const rows = await messages(state, parent.nativeID);
    return v2
      ? rows.find(({ info }) =>
        info.role === "synthetic" &&
        info.metadata?.source === "subagent" &&
        info.metadata.childID === child &&
        info.metadata.state === "error"
      )?.info.id
      : rows.flatMap(({ parts }) => parts).find((part) =>
        part.type === "text" && part.synthetic === true &&
        part.text?.includes(`<task id="${child}" state="error">`)
      )?.id;
  };
  await expect.poll(failure).toBeTruthy();
  await expect.poll(receipt).toBeTruthy();
  await expect.poll(async () =>
    (await messages(state, parent.nativeID)).some(({ info, parts }) =>
      info.role === "assistant" && info.time?.completed &&
      parts.some(({ text }) => text === "Parent observed the result")
    )
  ).toBe(true);
  const terminal = (await failure())!;
  // Do not infer delivery from a launch acknowledgement or the parent's prose.
  return {
    parent,
    child: state.sessionID(child),
    terminal,
    result: (await receipt())!,
  };
}

export async function liveResumedHelper(state: TestState) {
  const parent = await seed(state, "Parent of resumed helper");
  const v2 = parent.id.startsWith("opcv2-");
  const children = () =>
    state.native<{ id: string }[]>(`/session/${parent.nativeID}/children`);
  let child: string | undefined;
  const runs: { terminalID: string; receiptID: string }[] = [];
  for (const run of [1, 2]) {
    await tool(state, v2 ? "subagent" : "task", {
      description: "Resumable helper fixture",
      prompt: `Return result number ${run}`,
      ...(v2
        ? {
          agent: "explore",
          background: true,
          ...(child ? { sessionID: child } : {}),
        }
        : { subagent_type: "general", ...(child ? { task_id: child } : {}) }),
    });
    const hold = await state.queue([`Child result ${run}`], "held");
    if (v2) await state.queue([`Parent initial answer ${run}`]);
    const parentAnswer = `Parent returned result ${run}`;
    await state.queue([parentAnswer]);
    try {
      await submit(state, parent.id, `Delegate run ${run}`);
      await expect.poll(async () => (await children()).length).toBe(1);
      const id = (await children())[0].id;
      child ??= id;
      expect(id).toBe(child);
      if (v2) {
        await expect.poll(async () =>
          (await messages(state, parent.nativeID)).some(({ parts }) =>
            parts.some(({ text }) => text === `Parent initial answer ${run}`)
          )
        ).toBe(true);
      }
    } finally {
      await state.release(hold.gate);
    }
    const receipts = async () => {
      const history = await messages(state, parent.nativeID);
      return v2
        ? history.filter(({ info }) =>
          info.role === "synthetic" &&
          info.metadata?.source === "subagent" &&
          info.metadata.childID === child &&
          info.metadata.state === "completed"
        ).map(({ info }) => info.id)
        : history.flatMap(({ parts }) =>
          parts.filter(({ tool, state }) =>
            tool === "task" && state?.status === "completed" &&
            state.metadata?.sessionId === child &&
            state.output?.includes(`<task id="${child}" state="completed">`)
          )
        ).map(({ id }) => id!);
    };
    await expect.poll(receipts).toHaveLength(run);
    const terminals = (await messages(state, child!)).filter(({ info }) =>
      info.role === "assistant" && info.time?.completed && !info.error
    ).map(({ info }) => info.id);
    expect(terminals).toHaveLength(run);
    const seen = await receipts();
    const terminalID = terminals.find((id) =>
      !runs.some((r) => r.terminalID === id)
    );
    const receiptID = seen.find((id) => !runs.some((r) => r.receiptID === id));
    expect(terminalID).toBeTruthy();
    expect(receiptID).toBeTruthy();
    runs.push({ terminalID: terminalID!, receiptID: receiptID! });
    await expect.poll(async () =>
      (await messages(state, parent.nativeID)).some(({ parts }) =>
        parts.some(({ text }) => text === parentAnswer)
      )
    ).toBe(true);
  }
  return { parent, child: state.sessionID(child!), runs };
}
