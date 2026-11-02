// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { heapPort } from "../../fixtures/heap.ts";
import { measureSessionHeap } from "../../../support/heap.ts";

test.use({ profile: "transport-cooling" });
test("transport.scope-cooling", {
  tag: ["@transport", "@contracts", "@isolated", "@messages"],
}, async ({ isolatedState: state, page }, info) => {
  test.setTimeout(180_000);
  const { cooling } = await state.observe<
    {
      cooling: {
        a: { id: string; nativeID: string };
        b: { id: string; nativeID: string };
      };
    }
  >();
  const frames = await wire(page);
  await openSession(state, page, cooling.b.id);
  await page.evaluate(() => document.fonts.ready);
  const port = await heapPort(page.context(), page);
  const samples: unknown[] = [];
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      await openSession(state, page, cooling.a.id);
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "hold",
        sessionID: cooling.a.nativeID,
      });
      await expect.poll(async () =>
        (await state.observe<{ coolingSourceLoaded: boolean }>())
          .coolingSourceLoaded
      ).toBe(true);
      await expect.poll(async () =>
        (await state.observe<{ coolingResources: { messages: number } }>())
          .coolingResources?.messages ?? 0
      ).toBeGreaterThan(0);
      await expect.poll(() =>
        page.locator("[data-role=assistant] .otk-text").textContent().then((
          text,
        ) => text?.length ?? 0)
      ).toBeGreaterThanOrEqual(2097152);
      const loadedResources = (await state.observe<
        { coolingResources: { messages: number; subscribed: boolean } }
      >()).coolingResources;
      expect(loadedResources.messages).toBeGreaterThan(0);
      expect(loadedResources.subscribed).toBe(true);
      const loaded = await measureSessionHeap(
        port,
        cooling.a.id,
        "OTK_LARGE_SESSION_A_",
      );
      const unsubscribed = () =>
        frames.sent.filter(({ frame }) =>
          frame.t === "unsubscribe" && frame.sessionID === cooling.a.id
        ).length;
      const before = unsubscribed();
      await openSession(state, page, cooling.b.id);
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "hold",
        sessionID: cooling.b.nativeID,
      });
      await expect(page.locator(".otk-messages")).toContainText(
        "Small session text",
      );
      await expect.poll(unsubscribed).toBeGreaterThan(before);
      await expect.poll(async () =>
        (await state.observe<{ coolingResources: unknown }>()).coolingResources
      ).toEqual({
        temperature: "cold",
        messages: 0,
        messageRecords: 0,
        replies: 0,
        replyRecords: 0,
        content: 0,
        recovering: 0,
        pageLoading: false,
        subscribed: false,
        readLeases: 0,
      });
      const releasedResources =
        (await state.observe<{ coolingResources: unknown }>()).coolingResources;
      await page.evaluate(() =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
      );
      const released = await measureSessionHeap(
        port,
        cooling.a.id,
        "OTK_LARGE_SESSION_A_",
      );
      samples.push({
        cycle,
        loaded,
        released,
        loadedResources,
        releasedResources,
      });
    }
    expect(
      frames.sent.some(({ frame }) =>
        frame.t === "unsubscribe" && frame.sessionID === cooling.a.id
      ),
    ).toBe(true);
    await expect(page.locator("body")).not.toContainText(
      "OTK_LARGE_SESSION_A_",
    );
    await info.attach("three-cycle-content-identities", {
      body: JSON.stringify(samples),
      contentType: "application/json",
    });
  } finally {
    await port.close();
  }
});
