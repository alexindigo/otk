// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";

test.use({ profile: "transport-reconnect" });
test("transport.unsolicited-reconnect-retains-unfinished-text-and-next-chunk", {
  tag: ["@transport", "@messages", "@contracts"],
}, async ({ isolatedState: state, page }, info) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Retained stream",
  });
  const frames = await wire(page);
  await openSession(state, page, session.id);
  const chunks = [
    "# Retained stream\n\n",
    "The next chunk appends.\n\n",
    "Finished.",
  ];
  const gate = await state.queue(chunks, "stepped");
  await page.locator("textarea[name=prompt]").fill("Keep the streamed source");
  await page.locator("textarea[name=prompt]").press("Enter");
  await state.release(gate.gate);
  const text = page.locator("[data-role=assistant] .otk-text");
  await expect(text).toContainText("Retained stream");
  await page.evaluate(() => {
    const lost: string[] = [];
    let frame = 0, samples = 0;
    const sample = () => {
      const value = document.querySelector("[data-role=assistant] .otk-text")
        ?.textContent ?? "";
      if (!value.includes("Retained stream")) lost.push(value);
      samples++;
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    Object.assign(globalThis, {
      streamRetentionProof: () => {
        cancelAnimationFrame(frame);
        return { samples, lost };
      },
    });
  });
  const since = frames.received.length;
  const observations: string[] = [];
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "disconnect",
  });
  await expect.poll(async () => {
    observations.push(await text.textContent() ?? "");
    const recent = frames.received.slice(since);
    const reconnect = recent.findIndex((frame) =>
      frame.t === "harness" && frame.state === "reconnecting"
    );
    return reconnect >= 0 &&
      recent.slice(reconnect + 1).some((frame) =>
        frame.t === "harness" && frame.state === "connected"
      );
  }).toBe(true);
  await expect(text).toContainText("Retained stream");
  expect(observations.every((value) => value.includes("Retained stream")))
    .toBe(true);
  await info.attach("retained-stream-reconnect", {
    body: JSON.stringify({
      observations,
      frames: frames.received.slice(since),
    }),
    contentType: "application/json",
  });
  await page.screenshot({
    path: info.outputPath("retained-stream-after-reconnect.png"),
    fullPage: true,
  });
  await state.release(gate.gate);
  await expect(text).toContainText("The next chunk appends.");
  await expect(text).toContainText("Retained stream");
  const proof = await page.evaluate<{ samples: number; lost: string[] }>(
    "streamRetentionProof()",
  );
  expect(proof.samples).toBeGreaterThan(0);
  expect(proof.lost).toEqual([]);
  await info.attach("retained-stream-frames", {
    body: JSON.stringify(proof),
    contentType: "application/json",
  });
  await page.screenshot({
    path: info.outputPath("retained-stream-next-chunk.png"),
    fullPage: true,
  });
  await state.release(gate.gate);
  await expect(text).toContainText("Finished.");
  await expect(page.locator(`[data-session="${session.id}"]`))
    .toHaveAttribute("data-status", "idle");
  expect(
    frames.received.slice(since).filter((frame) =>
      frame.t === "harness" && frame.state === "reconnecting"
    ),
  ).toHaveLength(1);
});
