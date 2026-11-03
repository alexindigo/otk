// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import type { IndexOp } from "@otk/protocol";

test.use({ profile: "transport-deleted-seen" });
test("sessions.deleted-seen-does-not-retain-attention", {
  tag: ["@sessions", "@attention"],
}, async ({ isolatedState: state, page }) => {
  const session = await state.native<{ id: string; nativeID: string }>(
    "/session",
    "POST",
    { title: "Deleted viewed session" },
  );
  const frames = await wire(page);
  // Keep the automatic seen continuation behind its actual visit receipt while
  // the selected transcript becomes ready, then arm the native identity gate.
  frames.hold((frame, request) =>
    frame.t === "request.result" && request?.method === "projects.visit"
  );
  await openSession(state, page, session.id);
  await expect.poll(() => frames.held.length).toBeGreaterThan(0);
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "hold",
    sessionID: session.nativeID,
  });
  frames.release();
  await expect.poll(async () =>
    (await state.observe<{ transport: { entered: boolean } }>()).transport
      .entered
  ).toBe(true);
  await expect.poll(() =>
    frames.sent.some(({ frame }) =>
      frame.method === "sessions.seen" && frame.params?.sessionID === session.id
    )
  ).toBe(true);
  const tab = page.locator(`[data-tab="${session.id}"]`);
  await tab.click({ button: "right" });
  const remove = page.locator('[data-context-command="session.delete"]');
  await remove.click();
  await expect(remove).toHaveText("Press again to delete");
  await remove.click();
  await expect(page).toHaveURL(/#project\//);
  await expect.poll(() =>
    frames.received.some((frame) =>
      frame.t === "request.result" && frame.outcome &&
      (frame.outcome as { ok: boolean }).ok &&
      frames.sent.some(({ frame: sent }) =>
        sent.method === "session.delete" && sent.ref?.key === frame.ref?.key
      )
    )
  ).toBe(true);
  await expect.poll(() =>
    frames.received.some((frame) =>
      frame.t === "index.patch" &&
      (frame.ops as IndexOp[]).some((op) =>
        op.op === "upsert"
          ? op.entry.id === session.id && !!op.entry.deleted
          : op.op === "digest" && op.id === session.id && !!op.deleted
      )
    )
  ).toBe(true);
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "release",
  });
  await expect.poll(() =>
    frames.received.some((frame) =>
      frame.t === "request.result" && frame.outcome &&
      !(frame.outcome as { ok: boolean }).ok &&
      frames.sent.some(({ frame: sent }) =>
        sent.method === "sessions.seen" && sent.ref?.key === frame.ref?.key
      )
    )
  ).toBe(true);
  await expect(tab).toHaveCount(0);
  await expect(
    page.locator('.otk-project-tabs .otk-status-light[data-state="blocked"]'),
  ).toHaveCount(0);
  await state.product("layout.patch", {
    leftCollapsed: true,
    rightCollapsed: true,
  });
  await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
    "data-collapsed",
    "true",
  );
  const baselines = frames.received.filter((frame) =>
    frame.t === "index.snapshot"
  ).length;
  await page.reload();
  await expect.poll(() =>
    frames.received.filter((frame) => frame.t === "index.snapshot").length
  ).toBeGreaterThan(baselines);
  await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
    "data-collapsed",
    "true",
  );
  await expect(page.locator(".otk-right-panel")).toBeHidden();
  await expect(page).toHaveURL(/#project\//);
  await expect(tab).toHaveCount(0);
  await expect(page.locator('[data-rollup="blocked"]')).toHaveCount(0);
  await expect(
    page.locator('.otk-project-tabs .otk-status-light[data-state="blocked"]'),
  ).toHaveCount(0);
});
