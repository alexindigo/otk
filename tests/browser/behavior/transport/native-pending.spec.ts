// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, throughDuration, wire } from "../../fixtures/wire.ts";

test.describe("native page", () => {
  test.use({ profile: "transport-page" });
  test("transport.forty-second-page", {
    tag: ["@transport", "@duration", "@isolated"],
  }, async ({ isolatedState: state, page }, info) => {
    test.setTimeout(120_000);
    const session = await state.native<{ id: string; nativeID: string }>(
      "/session",
      "POST",
      { title: "Forty-second page" },
    );
    await state.native(`/session/${session.id}/message`, "POST", {
      noReply: true,
      parts: [{ type: "text", text: "Seed before the held native page" }],
    });
    const frames = await wire(page);
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "hold",
      sessionID: session.nativeID,
    });
    await page.goto(`${state.url}/#/local/${session.id}`);
    await expect.poll(async () =>
      (await state.observe<{ transport: { entered: boolean } }>()).transport
        .entered
    ).toBe(true);
    const observations: unknown[] = [];
    const start = performance.now();
    const inspect = async () => {
      await expect(
        page.getByRole("region", { name: "Transcript", exact: true }),
      ).toHaveAttribute("aria-busy", "true");
      await expect(page.locator(".otk-messages")).toContainText(
        "Loading messages",
      );
      await expect(
        page.locator("[role=alert],.otk-error").filter({
          hasText: /timed out|timeout|operation was aborted|could not load/i,
        }),
      ).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText("protocol mismatch");
      observations.push({ elapsed: performance.now() - start, loading: true });
    };
    await throughDuration(16_000, inspect);
    await state.native(`/session/${session.id}/message`, "POST", {
      noReply: true,
      parts: [{ type: "text", text: "Event arrived during the held page" }],
    });
    await expect.poll(() =>
      frames.received.some((frame) =>
        frame.t === "content" && frame.sessionID === session.id
      )
    ).toBe(true);
    await throughDuration(
      Math.max(0, 40_000 - (performance.now() - start)),
      inspect,
    );
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "release",
    });
    await expect(page.locator(".otk-messages")).toContainText(
      "Event arrived during the held page",
    );
    await expect(page.locator('.otk-messages [data-role="user"]')).toHaveCount(
      2,
    );
    expect(
      (await state.observe<{ transport: { reads: number } }>()).transport.reads,
    ).toBe(1);
    expect(performance.now() - start).toBeGreaterThanOrEqual(40_000);
    await info.attach("elapsed-page-contract", {
      body: JSON.stringify({
        observations,
        elapsed: performance.now() - start,
        sessionID: session.id,
      }),
      contentType: "application/json",
    });
  });
});

test.describe("native shell", () => {
  test.use({ profile: "transport-shell" });
  test("transport.native-shell-receipt", {
    tag: ["@transport", "@isolated", "@composer"],
  }, async ({ isolatedState: state, page }, info) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Reattached native command",
    });
    const frames = await wire(page);
    await openSession(state, page, session.id);
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "hold",
    });
    const input = page.locator("textarea[name=prompt]");
    await input.press("!");
    await input.fill("printf request-native-once");
    await input.press("Enter");
    await expect.poll(async () =>
      (await state.observe<{ transport: { entered: boolean } }>()).transport
        .entered
    ).toBe(true);
    await expect(page.locator("[data-tool=bash]")).toContainText(
      "request-native-once",
    );
    await expect(page.locator(".otk-operation-feedback.is-pending"))
      .toBeVisible();
    await input.fill("New draft survives the old receipt");
    frames.close();
    await expect.poll(() =>
      frames.sent.some(({ frame }) => frame.t === "request.resume")
    ).toBe(true);
    await expect(input).toHaveValue("New draft survives the old receipt");
    await expect(
      page.locator(
        ".otk-composer-dock [role=alert],.otk-prompt button[type=submit]",
      ),
    ).toHaveCount(0);
    expect(
      (await state.observe<{ transport: { effects: number } }>()).transport
        .effects,
    ).toBe(1);
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "release",
    });
    await expect(page.locator(".otk-operation-feedback.is-pending"))
      .toHaveCount(0);
    try {
      await expect(page.locator(".otk-prompt button[type=submit]"))
        .toBeVisible();
    } finally {
      await info.attach("shell-wire", {
        body: JSON.stringify({ sent: frames.sent, received: frames.received }),
        contentType: "application/json",
      });
    }
    await expect(input).toHaveValue("New draft survives the old receipt");
    expect(
      (await state.observe<{ transport: { effects: number } }>()).transport
        .effects,
    ).toBe(1);
  });
});
