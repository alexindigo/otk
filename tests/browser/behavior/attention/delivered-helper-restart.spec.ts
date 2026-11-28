// SPDX-License-Identifier: LGPL-3.0-only
import type { InboxSnapshot, ServerFrame } from "@otk/protocol";
import type { Page } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import type { TestState } from "../../fixtures/test-state.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { seed, tool } from "../../pages/attention.ts";
import { subagents } from "../../pages/crumbs.ts";
import {
  liveFailedHelper,
  liveResumedHelper,
} from "../../pages/failed-helper.ts";
import { viewByUrl } from "../../pages/sessions.ts";

interface NativeSession {
  id: string;
  nativeID: string;
  directory: string;
}

function blockedControls(state: TestState) {
  const native = <T>(path: string) =>
    state.controller.call<T>("nativeRequest", {
      lease: state.lease.lease,
      project: "secondary",
      path,
      method: "GET",
    });
  const create = (title: string, parentID?: string) =>
    state.controller.call<NativeSession>("nativeRequest", {
      lease: state.lease.lease,
      project: "secondary",
      path: "/session",
      method: "POST",
      body: { title, ...(parentID ? { parentID } : {}) },
    });
  const submit = (sessionID: string, text: string) =>
    state.product("session.prompt", {
      sessionID,
      mode: "normal",
      parts: [{ kind: "text", text }],
    });
  return { native, create, submit };
}

function observeInbox(page: Page, references: string[]) {
  return wire(page, (frame) => {
    if (frame.t === "hello" && frame.view) {
      return { ...frame, view: { ...frame.view as object, references } };
    }
    return frame.t === "view" ? { ...frame, references } : frame;
  }).then((capture) => ({
    ...capture,
    inbox() {
      const inbox: Pick<
        InboxSnapshot,
        "entities" | "summaries"
      > = {
        entities: {},
        summaries: {},
      };
      for (const frame of capture.received as unknown as ServerFrame[]) {
        if (frame.t === "inbox.snapshot") {
          inbox.entities = { ...frame.inbox.entities };
          inbox.summaries = { ...frame.inbox.summaries };
        } else if (frame.t === "inbox.patch") {
          for (const op of frame.ops) {
            if (op.op === "entity.upsert") {
              inbox.entities![`${op.value.kind}:${op.value.id}`] = op.value;
            }
            if (op.op === "entity.remove") delete inbox.entities![op.key];
          }
        } else if (frame.t === "inbox.summaries") {
          for (const summary of frame.summaries) {
            inbox.summaries![summary.directory] = summary;
          }
          for (const directory of frame.remove ?? []) {
            delete inbox.summaries![directory];
          }
        }
      }
      return inbox;
    },
  }));
}

test.use({ profile: "attention-failed-helper" });

test("attention.delivered-native-helpers-stay-clear-after-sidecar-restart", {
  tag: ["@attention", "@sessions", "@isolated"],
}, async ({ isolatedState: state, page, browser }, info) => {
  test.setTimeout(120_000);
  const references: string[] = [];
  const warm = await observeInbox(page, references);
  const anchor = await seed(state, "Neutral restart observer");
  await state.product("layout.patch", { discoveredCollapsed: false });
  await openSession(state, page, anchor.id);

  const row = (view: Page, directory: string) =>
    view.locator(
      `[data-server=local][data-project=${JSON.stringify(directory)}]`,
    );
  const rollup = async (
    view: Page,
    directory: string,
    status: "none" | "blocked",
  ) => {
    const project = row(view, directory);
    await expect(project).toHaveAttribute("data-rollup", status);
    await expect(project.getByRole("img", {
      name: status === "none" ? "No known activity" : "Needs you",
      exact: true,
    })).toBeVisible();
  };
  await rollup(page, state.directory, "none");

  const failed = await liveFailedHelper(state);
  const resumed = await liveResumedHelper(state);
  await info.attach("delivered-native-runs", {
    body: JSON.stringify({ failed, resumed }),
    contentType: "application/json",
  });
  const parents = [
    [failed.parent.id, "Parent observed the result"],
    [resumed.parent.id, "Parent returned result 2"],
  ] as const;
  const inspectParent = async (
    view: Page,
    capture: typeof warm,
    id: string,
    text: string,
  ) => {
    await viewByUrl(state, view, id);
    const transcript = view.getByRole("region", {
      name: "Transcript",
      exact: true,
    });
    await expect(transcript).toHaveAttribute("aria-busy", "false");
    await expect(transcript).toContainText(text);
    // Only parents are read; seeing a parent's own reply must not mask a child.
    await expect.poll(() => {
      const parent = capture.inbox().entities?.[`session:${id}`];
      return (parent?.terminal ?? 0) > 0 && parent?.counts.unseen === 0;
    }).toBe(true);
    await expect(subagents(view)).toHaveCount(0);
  };
  references.push(failed.child, resumed.child);
  for (const [id, text] of parents) await inspectParent(page, warm, id, text);
  await viewByUrl(state, page, anchor.id);
  await rollup(page, state.directory, "none");

  // Separate project: its real red activity cannot mask the historical rollup.
  const control = blockedControls(state);
  const owner = await control.create("Parent with no delivery receipts");
  const uncovered = await control.create("Undelivered failure", owner.nativeID);
  const pending = await control.create("Pending input", owner.nativeID);
  const { gate } = await state.controller.call<{ gate: string }>(
    "queueScript",
    {
      lease: state.lease.lease,
      chunks: [],
      failHelper: true,
      gate: "held",
    },
  );
  try {
    await control.submit(uncovered.id, "Run the provider error fixture");
  } finally {
    await state.release(gate);
  }
  const terminals = [failed.child, resumed.child, uncovered.id];
  references.push(uncovered.id, pending.id);
  await viewByUrl(state, page, anchor.id);
  const settledTerminals = (capture: typeof warm) => {
    const { entities } = capture.inbox();
    return terminals.map((id) => {
      const entity = entities?.[`session:${id}`];
      return { terminal: entity?.terminal ?? 0, outcome: entity?.outcome };
    });
  };
  await expect.poll(() => settledTerminals(warm)).toEqual(
    ["failed", "succeeded", "failed"].map((outcome) => ({
      terminal: expect.any(Number),
      outcome,
    })),
  );
  const beforeRestart = settledTerminals(warm);
  expect(beforeRestart.every(({ terminal }) => terminal > 0)).toBe(true);
  // No parent prompt/tool ran in this project, so this failure has no receipt.
  expect(await control.native(`/session/${owner.nativeID}/message`)).toEqual(
    [],
  );

  await tool(state, "bash", {
    command: "printf pending_input",
    description: "Keep real input pending across sidecar restart",
  });
  await state.queue(["Permission answered"]);
  await control.submit(
    pending.id,
    "Ask for permission without opening the helper",
  );
  const permissions = () =>
    state.product("permission.list", { sessionID: pending.id });
  await expect.poll(permissions).toHaveLength(1);
  const [{ id: permissionID }] = await permissions();
  try {
    const assertRed = async (view: Page, capture: typeof warm) => {
      // Both controls must be individually red, not merely the winning project lamp.
      await expect.poll(() => {
        const { entities } = capture.inbox();
        return [uncovered.id, pending.id].map((id) =>
          entities?.[`session:${id}`]?.state
        );
      }).toEqual(["blocked", "blocked"]);
      await rollup(view, owner.directory, "blocked");
    };
    await assertRed(page, warm);
    await rollup(page, state.directory, "none");
    const instance = (capture: typeof warm) =>
      (capture.received.find(({ t }) => t === "welcome")?.sidecar as
        | { instance: string }
        | undefined)?.instance;
    const oldInstance = instance(warm);
    expect(oldInstance).toBeTruthy();
    await page.close();
    await state.controller.call("restart", {
      lease: state.lease.lease,
      target: "sidecar",
    });

    const cold = await (await state.newContext(browser)).newPage();
    const coldWire = await observeInbox(cold, references);
    await viewByUrl(state, cold, anchor.id);
    // Cold readiness is positive history and project authority, not an empty
    // popover during startup. This read-only fence never visits any child.
    await expect.poll(() => settledTerminals(coldWire), { timeout: 30_000 })
      .toEqual(
        beforeRestart,
      );
    await expect.poll(() => {
      const { summaries } = coldWire.inbox();
      return [state.directory, owner.directory].map((path) =>
        summaries?.[path]?.authority
      );
    }).toEqual(["current", "current"]);

    await expect.poll(() => instance(coldWire)).toBeTruthy();
    expect(instance(coldWire)).not.toBe(oldInstance);
    await expect.poll(() =>
      coldWire.received.some(({ t }) => t === "view.ready")
    )
      .toBe(true);
    await rollup(cold, state.directory, "none");
    await assertRed(cold, coldWire);
    expect((await permissions()).map(({ id }) => id)).toEqual([permissionID]);
    for (const [id, text] of parents) {
      await inspectParent(cold, coldWire, id, text);
    }
    await rollup(cold, state.directory, "none");

    const children = new Set([...terminals, pending.id]);
    expect(
      [warm, coldWire].flatMap(({ sent }) =>
        sent.filter(({ frame }) =>
          frame.method === "sessions.acknowledge" ||
          ((frame.method === "sessions.seen" ||
            frame.method === "sessions.opened") &&
            children.has(frame.params?.sessionID ?? ""))
        )
      ),
    ).toEqual([]);
  } finally {
    await state.product("permission.reply", {
      sessionID: pending.id,
      requestID: permissionID,
      reply: "once",
    });
    await expect.poll(async () =>
      JSON.stringify(
        await control.native(`/session/${pending.nativeID}/message`),
      )
    ).toContain("Permission answered");
  }
});
