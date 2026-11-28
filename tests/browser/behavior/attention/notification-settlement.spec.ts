// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import type { TestState } from "../../fixtures/test-state.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { seed, tool } from "../../pages/attention.ts";
import { toast } from "../../pages/notifications.ts";
import type { Page } from "@playwright/test";

const tags = { tag: ["@attention", "@isolated"] };
const submit = (state: TestState, id: string, text: string) =>
  state.product("session.prompt", {
    sessionID: id,
    mode: "normal",
    parts: [{ kind: "text", text }],
  });
async function active(state: TestState, id: string) {
  const list = await state.native<Record<string, { type?: string }>>(
    "/session/status",
  );
  const row = list[id.replace(/^opcv[12]-/, "")];
  return !!row && row.type !== "idle";
}
const requests = async (state: TestState) =>
  (await state.observe<{ requests: unknown[] }>({ fields: ["requests"] }))
    .requests.length;
async function hold(state: TestState, text: string) {
  const { gate } = await state.queue([text], "held");
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await state.release(gate);
  };
}

async function observe(page: Page, state: TestState, id: string) {
  const observer = await seed(state, "Notification observer");
  const stream = await wire(page);
  await page.addInitScript((selector) => {
    const seen = new Set<Element>();
    Reflect.set(window, "settlementToasts", seen);
    new MutationObserver(() => {
      for (const node of Array.from(document.querySelectorAll(selector))) {
        if (node.textContent?.includes("Session done")) seen.add(node);
      }
    }).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }, toast(id));
  await openSession(state, page, observer.id);
  return {
    stream,
    note: page.locator(toast(id)),
    count: () =>
      page.evaluate(() => Reflect.get(window, "settlementToasts").size),
    terminal: () =>
      stream.received.some((frame) =>
        frame.t === "index.patch" &&
        (frame.ops as {
          entry?: { id: string; activity?: { outcome?: string } };
        }[]).some(({ entry }) =>
          entry?.id === id && entry.activity?.outcome === "succeeded"
        )
      ),
  };
}

test(
  "attention.settlement-holds-through-running-helper-and-native-result-continuation",
  tags,
  async ({ isolatedState: state, page }) => {
    const parent = await seed(state, "Parent receiving helper result");
    const v2 = parent.id.startsWith("opcv2-");
    const observed = await observe(page, state, parent.id);
    await tool(state, v2 ? "subagent" : "task", {
      description: "Held helper",
      prompt: "Return a result to the parent",
      ...(v2
        ? { agent: "explore", background: true }
        : { subagent_type: "general" }),
    });
    // V2 launches a separate execution and later wakes the parent. In V1 the
    // task is synchronous and the result continues the existing execution.
    const child = await hold(state, "Native helper result");
    if (v2) await state.queue(["Parent first reply"]);
    const next = await hold(state, "Parent integrated the result");
    try {
      await submit(state, parent.id, "Delegate to a helper");
      await expect.poll(() => requests(state)).toBeGreaterThanOrEqual(
        v2 ? 3 : 2,
      );
      if (v2) {
        await expect.poll(observed.terminal).toBe(true);
        await expect.poll(() => active(state, parent.id)).toBe(false);
      }
      await expect(observed.note).toHaveCount(0);
      await child();
      await expect.poll(() => requests(state)).toBe(v2 ? 4 : 3);
      await expect.poll(() => active(state, parent.id)).toBe(true);
      await expect(observed.note).toHaveCount(0);
      expect(await observed.count()).toBe(0);
    } finally {
      await child();
      await next();
    }
    await expect(observed.note).toContainText("Session done");
    expect(await observed.count()).toBe(1);
  },
);

test(
  "attention.settlement-waits-for-queued-input",
  tags,
  async ({ isolatedState: state, page }) => {
    const target = await seed(state, "Queued next input");
    const observed = await observe(page, state, target.id);
    const first = await hold(state, "First reply");
    const second = await hold(state, "Second reply");
    try {
      await submit(state, target.id, "First input");
      await expect.poll(() => requests(state)).toBe(1);
      await submit(state, target.id, "Queued input");
      await first();
      await expect.poll(() => requests(state)).toBe(2);
      await expect.poll(() => active(state, target.id)).toBe(true);
      await expect(observed.note).toHaveCount(0);
      expect(await observed.count()).toBe(0);
    } finally {
      await first();
      await second();
    }
    await expect(observed.note).toContainText("Session done");
    expect(await observed.count()).toBe(1);
  },
);

test(
  "attention.settlement-notifies-once-and-retracts-when-work-restarts",
  tags,
  async ({ isolatedState: state, page }, info) => {
    const target = await seed(state, "Plain settlement");
    const observed = await observe(page, state, target.id);
    // Delay only the accepted owner publication, not native/index evidence.
    // A browser that still infers completion from the index alerts anyway.
    observed.stream.hold((frame) => frame.t === "inbox.settlement");
    try {
      await state.queue(["First completed reply"]);
      await submit(state, target.id, "Plain input");
      await expect.poll(observed.terminal).toBe(true);
      await expect.poll(async () =>
        observed.stream.held.length || await observed.count()
      ).toBeGreaterThan(0);
      expect(await observed.count()).toBe(0);
    } finally {
      observed.stream.release();
      await info.attach("settlement-release", {
        body: JSON.stringify(
          observed.stream.received.filter((frame) =>
            frame.t === "inbox.snapshot" || frame.t === "inbox.patch" ||
            frame.t === "inbox.settlement"
          ),
        ),
        contentType: "application/json",
      });
    }
    await expect(observed.note).toContainText("Session done");
    expect(await active(state, target.id)).toBe(false);
    expect(await observed.count()).toBe(1);
    const second = await state.queue(["Second completed reply"], "held");
    try {
      await submit(state, target.id, "Restart after settlement");
      await expect.poll(() => active(state, target.id)).toBe(true);
      await expect(observed.note).toHaveCount(0);
      expect(await observed.count()).toBe(1);
    } finally {
      await state.release(second.gate);
    }
    await expect(observed.note).toContainText("Session done");
    expect(await observed.count()).toBe(2);
  },
);
