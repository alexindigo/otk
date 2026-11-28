// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { prompt, reply } from "../../pages/composer.ts";

test.use({ profile: "isolated" });

test("composer.pending-send-survives-reconnect-and-sidecar-restart", {
  tag: ["@composer", "@messages", "@transport", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Pending across restart",
  });
  const frames = await wire(page);
  await openSession(state, page, session.id);
  frames.hold((frame, request) =>
    frame.t === "content" && frame.sessionID === session.id ||
    frame.t === "load.chunk" &&
      (frame.data as { kind?: string })?.kind === "message-page" ||
    request?.method === "session.messages" ||
    request?.method === "session.prompt" && frame.t === "request.result"
  );
  await state.queue(["The restart kept one prompt."]);
  await prompt(page).fill(
    "Keep this pending entry through reconnect and restart.",
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const pending = page.locator('[data-send-state="pending"]');
  await expect(pending).toBeInViewport();
  await expect(prompt(page)).toHaveValue("");
  const id = await pending.getAttribute("data-message");
  const entry = page.locator(`[data-message="${id}"]`);
  const key = await entry.getAttribute("data-send-key");
  const before = frames.connections().opened;
  frames.held.splice(0); // Bytes from the lost socket cannot be replayed to its successor.
  frames.close();
  await expect.poll(() => frames.connections().opened).toBeGreaterThan(before);
  await expect(entry).toHaveAttribute("data-send-key", key!);
  frames.held.splice(0);
  await state.controller.call("restart", {
    lease: state.lease.lease,
    target: "sidecar",
  });
  await expect.poll(() =>
    frames.received.filter((f) => f.t === "welcome").length
  ).toBeGreaterThan(1);
  await expect(entry).toContainText("Keep this pending entry");
  frames.release();
  await reply(state, page, session.id, "The restart kept one prompt.");
  await expect(entry).toHaveAttribute("data-send-state", "committed");
  await expect(entry).toHaveAttribute("data-send-key", key!);
  await expect(entry).toHaveCount(1);
  expect(
    new Set(
      frames.sent.filter(({ frame }) => frame.method === "session.prompt").map((
        { frame },
      ) => frame.ref!.key),
    ).size,
  ).toBe(1);
});

test("composer.pending-native-message-commits-before-send-acknowledgement", {
  tag: ["@composer", "@messages", "@transport", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Native before acknowledgement",
  });
  const frames = await wire(page);
  await openSession(state, page, session.id);
  frames.hold((frame, request) =>
    request?.method === "session.prompt" && frame.t === "request.result"
  );
  await state.queue(["Native identity arrived first."]);
  await prompt(page).fill("Commit by identity, never by text.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const entry = page.locator("[data-send-key]");
  await expect.poll(() =>
    frames.sent.some(({ frame }) => frame.method === "session.prompt")
  ).toBe(true);
  await expect(prompt(page)).toHaveValue("");
  await expect(entry).toHaveAttribute("data-send-state", "committed");
  await expect(entry).toHaveCount(1);
  const key = await entry.getAttribute("data-send-key");
  expect(
    frames.sent.find(({ frame }) => frame.method === "session.prompt")!.frame
      .ref!.key,
  ).toBe(key);
  frames.release();
  await expect(prompt(page)).toHaveValue("");
  await reply(state, page, session.id, "Native identity arrived first.");
  await expect(entry).toHaveCount(1);
});
