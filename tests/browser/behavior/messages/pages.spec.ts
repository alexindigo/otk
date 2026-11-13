// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";
import type { MessagePage } from "@otk/protocol";
test.use({ profile: "messages-tools" });
test("messages.native-newest10-offpage-undo-cursors-live-reload", {
  tag: ["@messages", "@revert"],
}, async ({ isolatedState: state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Cursor continuity review",
    messages: Array.from(
      { length: 12 },
      (_, i) => ({ parts: [{ type: "text", text: `Earlier prompt ${i}` }] }),
    ),
  });
  for (let i = 0; i < 11; i++) {
    await state.controller.call("queueScript", {
      lease: state.lease.lease,
      chunks: [],
      tool: {
        name: "bash",
        input: { command: `printf 'step-${i}'`, description: `Read step ${i}` },
      },
    });
  }
  await state.queue(["The cursor keeps every earlier step."]);
  await state.native(`/session/${session.id}/message`, "POST", {
    agent: "build",
    model: { providerID: "fake", modelID: "scripted" },
    parts: [{ type: "text", text: "Boundary prompt outside newest ten" }],
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  const capture = await wire(page);
  await openSession(state, page, session.id);
  await expect(page.locator(".otk-message-flow")).toContainText(
    "The cursor keeps every earlier step.",
  );
  const newest = await state.product("session.messages", {
    sessionID: session.id,
  }) as MessagePage;
  // V2's terminal idle is a native control row: it owns one of the ten native slots.
  expect(newest.items).toHaveLength(
    state.controller.info!.version.startsWith("2.") ? 9 : 10,
  );
  expect(newest.items.every((m) => m.role === "assistant")).toBe(true);
  expect(newest.prompt).toBeTruthy();
  expect(newest.items.some((m) => m.id === newest.prompt!.id)).toBe(false);
  expect(newest.prompt!.model).toEqual({ provider: "fake", model: "scripted" });
  expect(newest.prompt!.agent).toBe("build");
  expect(newest.older).toBeTruthy();
  await expect(page.locator(".otk-composer-agent")).toHaveText("Build");
  await expect(page.locator(".otk-composer-model-name")).toContainText(
    "scripted",
  );
  const requests = capture.sent.filter(({ frame }) =>
    frame.method === "session.messages"
  );
  expect(requests.length).toBeGreaterThanOrEqual(1);
  expect(requests.every(({ frame }) => !("limit" in frame.params!))).toBe(true);
  await prompt(page, "/undo");
  await expect(page.locator("textarea[name=prompt]")).toHaveValue(
    "Boundary prompt outside newest ten",
  );
  await expect(page.locator(".otk-rolled-back-strip strong")).toHaveText(
    "1 prompt rolled back",
  );
  await page.locator(".otk-rollback-disclosure").click();
  await expect(page.locator(".otk-rollback-disclosure")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await page.locator(".otk-rollback-footer button").click();
  await expect(page.locator(".otk-rolled-back-strip")).toHaveCount(0);
  await expect(page.locator(".otk-message-flow")).toContainText(
    "The cursor keeps every earlier step.",
  );
  await page.reload();
  await expect(page.locator(".otk-message-flow")).toContainText(
    "The cursor keeps every earlier step.",
  );
  await page.locator(".otk-messages").evaluate((e) => e.scrollTop = 0);
  await expect(page.locator(".otk-message-flow")).toContainText(
    "Boundary prompt outside newest ten",
  );
  expect(
    capture.sent.some(({ frame }) =>
      frame.method === "session.messages" && !!frame.params?.before
    ),
  ).toBe(true);
  await state.controller.call("queueScript", {
    lease: state.lease.lease,
    chunks: ["A fresh ", "stream remains ", "aligned."],
    delay: 100,
  });
  await prompt(page, "Continue with a short reply");
  await expect(page.locator(".otk-message-flow")).toContainText(
    "A fresh stream remains aligned.",
  );
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await page.reload();
  await expect(page.locator(".otk-message-flow")).toContainText(
    "A fresh stream remains aligned.",
  );
  await page.setViewportSize({ width: 800, height: 700 });
  await page.getByRole("button", { name: "Collapse projects", exact: true })
    .click();
  await page.getByRole("button", { name: "Collapse right panel", exact: true })
    .click();
  await expect.poll(() =>
    page.evaluate(() => {
      const a = document.querySelector(".otk-message-flow")!
          .getBoundingClientRect(),
        b = document.querySelector(".otk-composer-input")!
          .getBoundingClientRect();
      return Math.abs(a.left - b.left) <= 1 && Math.abs(a.right - b.right) <= 1;
    })
  ).toBe(true);
});

test(
  "messages.native-102-step-ledger-offpage-copy",
  { tag: ["@load", "@messages"] },
  async ({ isolatedState: state, page }) => {
    test.setTimeout(180000);
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Complete reply review",
    });
    const markers = Array.from(
      { length: 102 },
      (_, i) => `Projection step ${String(i).padStart(3, "0")}.`,
    );
    for (let i = 0; i < 101; i++) {
      await state.controller.call("queueScript", {
        lease: state.lease.lease,
        chunks: [markers[i]],
        tool: {
          name: "bash",
          input: { command: "true", description: `Inspect step ${i}` },
        },
      });
    }
    await state.queue([markers[101]]);
    await state.native(`/session/${session.id}/prompt_async`, "POST", {
      agent: "build",
      model: { providerID: "fake", modelID: "scripted" },
      parts: [{
        type: "text",
        text: "Read every step before copying the complete reply",
      }],
    });
    await expect.poll(
      () =>
        state.observe<{ requests: unknown[] }>().then((o) => o.requests.length),
      { timeout: 120000 },
    ).toBe(102);
    await expect.poll(() =>
      state.native<Record<string, unknown>>("/session/status").then((s) =>
        Object.keys(s).length
      )
    ).toBe(0);
    const capture = await wire(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.context().grantPermissions([
      "clipboard-read",
      "clipboard-write",
    ]);
    await openSession(state, page, session.id);
    await expect(page.locator(".otk-message-flow")).toContainText(markers[101]);
    await expect.poll(() =>
      page.evaluate(() => {
        const pane = document.querySelector(".otk-messages")!,
          v = pane.getBoundingClientRect(),
          source = Array.from(pane.querySelectorAll(".otk-text")).find((e) =>
            e.textContent === "Projection step 101."
          ),
          footer = pane.querySelector(".otk-message-footer");
        if (!source || !footer) return false;
        const a = source.getBoundingClientRect(),
          z = footer.getBoundingClientRect();
        return a.bottom > v.top && a.top < v.bottom && z.top >= v.top &&
          z.bottom <= v.bottom + 1 &&
          pane.scrollHeight - pane.clientHeight - pane.scrollTop <= 1;
      })
    ).toBe(true);
    const trigger = page.locator(".otk-turn-usage > button");
    for (const method of ["layout.location", "sessions.seen"]) {
      await expect.poll(() => {
        const request = capture.sent.find(({ frame }) =>
          frame.method === method && frame.params?.sessionID === session.id
        )?.frame;
        return !!request &&
          capture.received.some((frame) =>
            frame.t === "request.result" &&
            frame.ref?.key === request.ref?.key &&
            (frame.outcome as { ok: boolean })?.ok
          );
      }).toBe(true);
    }
    // Rules 3/6 finish full-turn totals after request traffic yields to idle,
    // rather than requiring the digest to finish during active page acquisition.
    await expect(trigger).toContainText("102 model calls", { timeout: 30000 });
    expect(capture.sent.filter(({ frame }) => frame.method === "usage.get"))
      .toHaveLength(0);
    await expect(page.locator(".otk-composer-notice")).toHaveCount(0);
    await trigger.hover();
    await expect(page.locator(".otk-usage-breakdown tbody tr")).toHaveCount(
      102,
    );
    const details = capture.sent.filter(({ frame }) =>
      frame.method === "usage.get"
    );
    expect(details).toHaveLength(1);
    expect(typeof details[0].frame.params?.turnID).toBe("string");
    await page.keyboard.press("Escape");
    await expect(page.locator(".otk-turn-usage :popover-open")).toHaveCount(0);
    await page.locator('[data-message-command="reply.copy"]').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(markers.join("\n\n"));
    await expect(page.locator(".otk-message-footer")).toHaveCount(1);
    await expect(
      page.getByRole("list", { name: "Reply segments", exact: true }),
      // Step bookkeeping adds a leading and a trailing work group around the
      // existing 102 text segments and 101 between-text tool groups.
    ).toHaveAttribute("data-acquired-count", "205");
    expect(await page.locator(".otk-work-log").count()).toBeLessThan(101);
    expect(
      capture.sent.filter(({ frame }) => frame.method === "session.messages")
        .length,
    ).toBeGreaterThanOrEqual(11);
    await page.locator(".otk-message-content p").last().click({
      button: "right",
    });
    await page.getByRole("menuitem", {
      name: "Show usage breakdown",
      exact: true,
    }).click();
    await expect(page.locator(".otk-usage-breakdown tbody tr")).toHaveCount(
      102,
    );
    await page.keyboard.press("Escape");
    await expect(page.locator(".otk-turn-usage :popover-open")).toHaveCount(0);
    await page.setViewportSize({ width: 800, height: 700 });
    for (
      const name of ["Collapse projects", "Collapse right panel"]
    ) {
      if (
        await page.getByRole("button", { name, exact: true }).count()
      ) await page.getByRole("button", { name, exact: true }).click();
    }
    await expect.poll(() =>
      page.evaluate(() => {
        const a = document.querySelector(".otk-message-flow")!
            .getBoundingClientRect(),
          b = document.querySelector(".otk-composer-input")!
            .getBoundingClientRect();
        return Math.abs(a.left - b.left) <= 1 &&
          Math.abs(a.right - b.right) <= 1;
      })
    ).toBe(true);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      markers.join("\n\n"),
    );
  },
);
