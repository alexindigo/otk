// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { writeFile } from "node:fs/promises";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import type { TestState } from "../../fixtures/test-state.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { seed, tool } from "../../pages/attention.ts";
import { subagentLamp, subagents } from "../../pages/crumbs.ts";
import { liveFailedHelper } from "../../pages/failed-helper.ts";
import { badge, toast } from "../../pages/notifications.ts";

const tags = { tag: ["@attention", "@sessions", "@isolated"] };

test.describe("orphaned job evidence", () => {
  test.use({ profile: "attention-orphaned-jobs" });

  test("attention.orphaned-native-jobs-do-not-run-parent", tags, async ({
    isolatedState: state,
    page,
  }, info) => {
    const parent = await seed(state, "Idle parent with historical jobs");
    const v2 = parent.id.startsWith("opcv2-");
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    const transcript = page.getByRole("region", {
      name: "Transcript",
      exact: true,
    });
    const row = page.locator(
      `[data-session=${JSON.stringify(parent.id)}] .otk-status-light`,
    ).first();
    const held = await state.queue(["Completed parent run"], "held");
    await openSession(state, page, parent.id);
    const { childID } = v2
      ? await state.controller.call<{ childID: string }>("scenario", {
        lease: state.lease.lease,
        action: "seed-orphaned-job",
        sessionID: parent.nativeID,
      })
      : { childID: undefined };
    try {
      await submit(state, parent.id, "Perform the real parent run");
      await expect(stop).toBeVisible();
      await expect(row).toHaveAttribute("data-state", "working");
    } finally {
      await state.release(held.gate);
    }
    await expect(transcript).toContainText("Completed parent run");
    const active = () =>
      state.native<Record<string, { type?: string }>>("/session/status");
    await expect.poll(async () => {
      const row = (await active())[parent.nativeID];
      return !row || row.type === "idle";
    }).toBe(true);
    if (v2) {
      const list = await state.native<
        { data: { id: string; status: string }[] }
      >(
        `/experimental/job?sessionID=${parent.nativeID}`,
      );
      expect(list.data).toContainEqual(
        expect.objectContaining({ id: childID, status: "running" }),
      );
      const [running, inbox, forms, permissions, shells] = await Promise.all([
        active(),
        state.native<unknown[]>(`/session/${parent.nativeID}/inbox`),
        state.native<{ data: unknown[] }>(`/session/${parent.nativeID}/form`),
        state.native<{ data: unknown[] }>(
          `/session/${parent.nativeID}/permission`,
        ),
        state.native<{ data: { metadata: { sessionID?: string } }[] }>(
          "/shell",
        ),
      ]);
      expect(running[parent.nativeID]).toBeUndefined();
      expect(running[childID!]).toBeUndefined();
      expect(inbox).toEqual([]);
      expect(forms.data).toEqual([]);
      expect(permissions.data).toEqual([]);
      expect(
        shells.data.filter(({ metadata }) =>
          metadata.sessionID === parent.nativeID ||
          metadata.sessionID === childID
        ),
      ).toEqual([]);
      await info.attach("native-orphan-facts", {
        body: JSON.stringify({
          list,
          running,
          inbox,
          forms,
          permissions,
          shells,
        }),
        contentType: "application/json",
      });
    }
    const idle = async () => {
      await expect(row).toBeVisible();
      await expect(row).not.toHaveAttribute("data-state", "working");
      await expect(stop).toHaveCount(0);
      await expect(subagents(page)).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Running work:/ }))
        .toHaveCount(0);
      await expect(page.locator('.otk-live-link[data-state="running"]'))
        .toHaveCount(0);
      if (v2) {
        await expect(
          page.locator(toast(parent.id)).filter({ hasText: "Session done" }),
        )
          .toHaveCount(0);
      }
    };
    await idle();
    if (v2) {
      await page.reload();
      await expect(transcript).toContainText("Completed parent run");
      await idle();
    }
  });
});

test.describe("native failure receipts", () => {
  test.use({ profile: "attention-failed-helper" });

  test("attention.delivered-failed-helper-policy-agrees", tags, async ({
    isolatedState: state,
    page,
  }, info) => {
    const witness = await liveFailedHelper(state);
    await info.attach("native-delivered-failure", {
      body: JSON.stringify(witness),
      contentType: "application/json",
    });
    // Never open the child: only the parent receipt should cover its run.
    await openSession(state, page, witness.parent.id);
    const transcript = page.getByRole("region", {
      name: "Transcript",
      exact: true,
    });
    await expect(transcript).toContainText("Parent observed the result");
    await expect(subagents(page)).toHaveCount(0);

    // A separate native helper run, not invoked through a delegating tool,
    // has no parent receipt to cover its failure. No OTK state is seeded.
    const uncovered = await seed(
      state,
      "Unreported helper failure",
      witness.parent.nativeID,
    );
    const failure = await state.controller.call<{ gate: string }>(
      "queueScript",
      {
        lease: state.lease.lease,
        chunks: [],
        failHelper: true,
        gate: "held",
      },
    );
    try {
      await submit(state, uncovered.id, "Run the provider error fixture");
    } finally {
      await state.release(failure.gate);
    }
    await expect.poll(async () =>
      (await state.native<NativeMessage[]>(
        `/session/${uncovered.nativeID}/message`,
      ))
        .some(({ info }) =>
          info?.role === "assistant" && !!info.error && !!info.time?.completed
        )
    ).toBe(true);
    expect(await receipts(state, witness.parent.nativeID, uncovered.nativeID))
      .toEqual([]);
    await expect(subagents(page)).toHaveAccessibleName(
      "Subagents: 1 needs you",
    );
    await subagents(page).click();
    await expect(subagentLamp(page, uncovered.id)).toHaveAttribute(
      "data-state",
      "blocked",
    );
    await badge(page, 1);
    // Historical red contributes to the badge, even with no replayed toast.
    await page.reload();
    await expect(subagents(page)).toHaveAccessibleName(
      "Subagents: 1 needs you",
    );
    await expect(page.locator(toast(uncovered.id))).toHaveCount(0);
    await badge(page, 1);
    await openSession(state, page, uncovered.id);
    await badge(page, 0);
  });
});

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
    error?: unknown;
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

test.describe("independent helper wake", () => {
  test.use({ profile: "messages-tools" });
  test("attention.helper-rerun-keeps-delivery-bound-to-run", tags, async ({
    isolatedState: state,
    page,
  }, info) => {
    const parent = await seed(
      state,
      "Keep the first receipt on the first execution",
    );
    const v2 = parent.id.startsWith("opcv2-");
    const release = `${state.directory}/release-helper-shell`;
    const stream = await wire(page);
    await openSession(state, page, parent.id);
    await tool(state, v2 ? "subagent" : "task", {
      description: "Helper with independent wake",
      prompt: "Return one report",
      ...(v2
        ? { agent: "general", background: false }
        : { subagent_type: "general" }),
    });
    if (v2) {
      await tool(state, "shell", {
        command: `until test -f ${
          JSON.stringify(release)
        }; do sleep 0.1; done; printf shell-woke-helper`,
        workdir: state.directory,
        background: true,
        timeout: 30_000,
      });
    }
    await state.queue(["First helper report"]);
    await state.queue(["Parent got the first report"]);
    await submit(state, parent.id, "Start the helper");
    await expect(page.getByRole("region", { name: "Transcript", exact: true }))
      .toContainText("Parent got the first report");
    const children = await state.native<{ id: string }[]>(
      `/session/${parent.nativeID}/children`,
    );
    expect(children).toHaveLength(1);
    const child = children[0].id, childID = state.sessionID(child);
    const initial = await receipts(state, parent.nativeID, child);
    expect(initial).toHaveLength(1);
    if (v2) {
      // The model run completed, but its held shell is genuinely still live.
      expect(
        (await state.native<Record<string, unknown>>("/session/status"))[child],
      ).toBeUndefined();
      await expect(subagents(page)).toHaveAccessibleName(
        "Subagents: 1 running",
      );
    } else await expect(subagents(page)).toHaveCount(0);

    const sibling = await seed(
      state,
      "Unrelated active helper",
      parent.nativeID,
    );
    const siblingReply = await state.queue(["Sibling is done"], "held");
    const rerun = await state.queue(["Second helper report"], "held");
    let released = false;
    try {
      await submit(
        state,
        sibling.id,
        "Keep working while the other helper wakes",
      );
      await expect(subagents(page)).toBeVisible();
      await subagents(page).click();
      await expect(subagentLamp(page, sibling.id)).toHaveAttribute(
        "data-state",
        "working",
      );
      if (v2) await writeFile(release, "wake\n");
      else {await submit(
          state,
          childID,
          "Follow up without sending a parent receipt",
        );}
      await expect.poll(async () => {
        const active = await state.native<Record<string, { type?: string }>>(
          "/session/status",
        );
        return !!active[child] && active[child].type !== "idle";
      }).toBe(true);
      await expect(subagentLamp(page, childID)).toHaveAttribute(
        "data-state",
        "working",
      );
      await state.release(rerun.gate);
      released = true;
      await expect(subagentLamp(page, childID)).toHaveAttribute(
        "data-state",
        "finished",
      );
      await expect(subagentLamp(page, sibling.id)).toHaveAttribute(
        "data-state",
        "working",
      );
      const history = await state.native<NativeMessage[]>(
        `/session/${child}/message`,
      );
      const current = await receipts(state, parent.nativeID, child);
      expect(current).toEqual(initial);
      expect(JSON.stringify(history)).toContain("Second helper report");
      if (v2) expect(JSON.stringify(history)).toContain("shell-woke-helper");
      await info.attach("native-rerun-without-receipt", {
        body: JSON.stringify({
          kind: v2 ? "background-shell" : "follow-up equivalent",
          child,
          history,
          current,
        }),
        contentType: "application/json",
      });
      await expect(page.getByRole("group", { name: "Finished 1" }))
        .toBeVisible();
      stream.hold((frame, request) =>
        frame.t === "request.result" &&
        request?.method === "sessions.acknowledge"
      );
      await page.getByRole("button", { name: "Clear finished" }).click();
      await expect(subagentLamp(page, childID)).toHaveCount(0);
      await expect.poll(() => stream.held.length).toBe(1);
      const third = await state.queue(["Third helper report"], "held");
      try {
        await submit(
          state,
          childID,
          "Run once more before the old Clear returns",
        );
        await expect(subagentLamp(page, childID)).toHaveAttribute(
          "data-state",
          "working",
        );
      } finally {
        await state.release(third.gate);
      }
      await expect(subagentLamp(page, childID)).toHaveAttribute(
        "data-state",
        "finished",
      );
      stream.release();
      await expect(page.getByRole("button", { name: "Clear finished" }))
        .toBeEnabled();
      await expect(subagentLamp(page, childID)).toHaveAttribute(
        "data-state",
        "finished",
      );
      expect(await receipts(state, parent.nativeID, child)).toEqual(initial);
    } finally {
      stream.release();
      if (v2) await writeFile(release, "wake\n");
      if (!released) await state.release(rerun.gate);
      await state.release(siblingReply.gate);
      await info.attach("clear-publications", {
        body: JSON.stringify(
          stream.received.filter((frame) =>
            frame.t === "request.result" || frame.t === "inbox.patch"
          ),
        ),
        contentType: "application/json",
      });
    }
  });
});

test("attention.helper-resumed-results-clear-each-run", tags, async ({
  isolatedState: state,
  page,
}, info) => {
  test.setTimeout(120_000);
  const parent = await seed(state, "Parent receiving resumed helper");
  const v2 = parent.id.startsWith("opcv2-");
  const delegate = (child?: string) =>
    tool(
      state,
      v2 ? "subagent" : "task",
      {
        description: "Repeat helper execution",
        prompt: child
          ? "Report your second result"
          : "Report your first result",
        ...(v2
          ? {
            agent: "explore",
            background: true,
            ...(child ? { sessionID: child } : {}),
          }
          : { subagent_type: "general", ...(child ? { task_id: child } : {}) }),
      },
    );
  const transcript = page.getByRole("region", {
    name: "Transcript",
    exact: true,
  });
  const stream = await wire(page);
  await openSession(state, page, parent.id);
  let child: string | undefined;
  const idleClocks = new Set<number | string>();
  for (let run = 1; run <= 3; run++) {
    await delegate(child);
    const held = await state.queue([`Helper answer ${run}`], "held");
    if (v2) await state.queue([`Parent is awaiting helper ${run}`]);
    const continuation = await state.queue(
      [`Parent got result ${run}`],
      "held",
    );
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
      if (v2) {
        await expect(transcript).toContainText(
          `Parent is awaiting helper ${run}`,
        );
      }
      await subagents(page).click();
      await expect(subagentLamp(page, childID)).toHaveAttribute(
        "data-state",
        "working",
      );
      expect(await receipts(state, parent.nativeID, child)).toHaveLength(
        run - 1,
      );
      await state.release(held.gate);
      released = true;
      await expect.poll(() => receipts(state, parent.nativeID, child!))
        .toHaveLength(run);
      const received = await receipts(state, parent.nativeID, child);
      const messages = await state.native<NativeMessage[]>(
        `/session/${child}/message`,
      );
      // The browser fixture omits V2 idle rows from its V1-compatible message
      // read; pair the successful assistant identity with the native idle fact.
      const terminalIDs = messages.flatMap((m) =>
        m.info?.role === "assistant" && m.info.time?.completed
          ? [m.info.id]
          : []
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
        body: JSON.stringify({
          childID,
          terminalIDs,
          idleClocks: [...idleClocks],
          received,
        }),
        contentType: "application/json",
      });
      await expect(subagents(page)).toHaveCount(0);
    } finally {
      if (!released) await state.release(held.gate);
      await state.release(continuation.gate);
      await info.attach(`state-run-${run}`, {
        body: JSON.stringify(
          stream.received.filter((frame) =>
            frame.t === "inbox.patch" || frame.t === "index.patch"
          ),
        ),
        contentType: "application/json",
      });
    }
    await expect(transcript).toContainText(`Parent got result ${run}`);
  }
  const delivered = await receipts(state, parent.nativeID, child!);
  const beforeRestart = stream.connections().opened;
  await state.controller.call("restart", {
    lease: state.lease.lease,
    target: "sidecar",
  });
  await expect.poll(() => stream.connections().opened).toBeGreaterThan(
    beforeRestart,
  );
  await expect(transcript).toContainText("Parent got result 3");
  expect(await receipts(state, parent.nativeID, child!)).toEqual(delivered);
  await expect(subagents(page)).toHaveCount(0);
});
