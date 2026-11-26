// SPDX-License-Identifier: LGPL-3.0-only
import { send } from "../../pages/primary-action.ts";
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { prompt, readyChips, reply, upload } from "../../pages/composer.ts";
import {
  captureParagraph,
  paragraphTop,
} from "../../pages/paragraph-source.ts";

test("composer.plain-send-does-not-await-unreferenced-catalogs", {
  tag: ["@composer", "@messages", "@readiness"],
}, async ({ state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Independent plain send",
  });
  const frames = await wire(page);
  frames.hold((frame) =>
    frame.t === "catalog.chunk" &&
    ["commands", "skills", "agents", "models"].includes(String(frame.kind))
  );
  await openSession(state, page, session.id);
  await expect.poll(() =>
    [...new Set(frames.held.map(({ frame }) => frame.kind))].sort()
  )
    .toEqual(["agents", "commands", "models", "skills"]);
  await state.queue(["Plain reply without catalog readiness."]);
  try {
    await prompt(page).fill("An ordinary prompt with no catalog reference.");
    await send(page).click();
    await expect(page.locator('[data-role="user"]')).toContainText(
      "An ordinary prompt with no catalog reference.",
    );
    await expect(page.locator(".otk-messages")).toContainText(
      "Plain reply without catalog readiness.",
    );
    expect(frames.sent.filter(({ frame }) => frame.method === "session.prompt"))
      .toHaveLength(1);
    expect(frames.held.length).toBeGreaterThan(0);
  } finally {
    frames.release();
  }
});

test(
  "composer.busy-image-send-keeps-queued-prompt-and-all-later-live-ops-visible",
  {
    tag: ["@composer", "@messages"],
  },
  async ({ state, page }, info) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Busy pasted image stream",
    });
    const frames = await wire(page);
    await state.queue([
      Array.from({ length: 40 }, (_, i) => `Preceding visible paragraph ${i}.`)
        .join("\n\n") + "\n\nThe preceding reply remains visible.",
    ]);
    await state.native(`/session/${session.id}/prompt_async`, "POST", {
      parts: [{ type: "text", text: "Preceding prompt" }],
    });
    await openSession(state, page, session.id);
    await expect(
      page.getByText("The preceding reply remains visible.", { exact: true }),
    ).toBeInViewport();
    await expect(page.locator(`[data-session="${session.id}"]`))
      .toHaveAttribute("data-status", "idle");
    const first = await state.queue(["Busy first reply completes."], "held");
    await state.native(`/session/${session.id}/prompt_async`, "POST", {
      parts: [{ type: "text", text: "Work while the image is queued" }],
    });
    await expect(page.locator(`[data-session="${session.id}"]`))
      .toHaveAttribute("data-status", "busy");
    const image = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 1024;
      canvas.height = 768;
      canvas.getContext("2d")!.fillRect(0, 0, 1024, 768);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    try {
      // Native drains queued user inputs as one prompt batch, not one model call per input.
      await state.queue(["The queued image reply arrives live."]);
      await state.native(`/session/${session.id}/prompt_async`, "POST", {
        parts: [{ type: "text", text: "External client queues before OTK" }],
      });
      await upload(page, [{
        name: "pasted-image.png",
        mime: "image/png",
        bytes: image,
      }], "paste");
      await expect(readyChips(page)).toHaveCount(1);
      await prompt(page).fill(
        "Busy image prompt must remain in the live stream.",
      );
      await send(page).click();
      await expect(prompt(page)).toHaveValue("");
      // Draft custody transfers at dispatch, before native queue admission.
      // Establish the requested native order before sending from the other
      // client; the empty editor is not a delivery acknowledgement.
      await expect.poll(() => {
        const sent = frames.sent.find(({ frame }) =>
          frame.method === "session.prompt"
        )?.frame;
        return !!sent &&
          frames.received.some((frame) =>
            frame.t === "request.result" && frame.ref?.key === sent.ref?.key &&
            (frame.outcome as { ok: boolean }).ok
          );
      }).toBe(true);
      await state.native(`/session/${session.id}/prompt_async`, "POST", {
        parts: [{ type: "text", text: "External client queues after OTK" }],
      });
      await expect.soft(
        page.getByText("Busy image prompt must remain in the live stream.", {
          exact: true,
        }),
      ).toBeInViewport();
      await state.release(first.gate);
      await reply(
        state,
        page,
        session.id,
        "The queued image reply arrives live.",
      );
      await expect.soft(
        page.getByText("The queued image reply arrives live.", { exact: true }),
      ).toBeInViewport();
      await state.queue(["Later external live output still applies."]);
      await state.native(`/session/${session.id}/prompt_async`, "POST", {
        parts: [{ type: "text", text: "A later external prompt" }],
      });
      await reply(
        state,
        page,
        session.id,
        "Later external live output still applies.",
      );
      await expect(
        page.getByText("Later external live output still applies.", {
          exact: true,
        }),
      ).toBeInViewport();
    } finally {
      await info.attach("busy-image-boundaries", {
        body: JSON.stringify({
          sent: frames.sent.map(({ frame }) => ({
            t: frame.t,
            method: frame.method,
            sessionID: frame.sessionID,
            params: frame.method === "session.prompt"
              ? { sessionID: frame.params?.sessionID }
              : frame.params,
          })),
          received: frames.received.map((frame) => ({
            t: frame.t,
            sessionID: frame.sessionID,
            clock: frame.clock,
            event: frame.t === "content"
              ? {
                op: (frame.event as { op?: string })?.op,
                messageID: (frame.event as { message?: { id?: string } })
                  ?.message?.id,
              }
              : undefined,
          })),
        }),
        contentType: "application/json",
      });
    }
  },
);

test(
  "composer.pending-send-commits-in-place-with-bounded-failure-and-retry",
  {
    tag: ["@composer", "@messages"],
  },
  async ({ state, page }, info) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Pending prompt delivery",
    });
    const frames = await wire(page);
    await openSession(state, page, session.id);
    frames.hold((frame, request) =>
      frame.t === "content" && frame.sessionID === session.id ||
      frame.t === "load.chunk" &&
        (frame.data as { kind?: string })?.kind === "message-page" ||
      request?.method === "session.messages"
    );
    await state.queue(["The accepted response is retained."]);
    await prompt(page).fill(
      "Show this prompt **right away**, then commit the same message.",
    );
    const start = performance.now();
    await send(page).click();
    const entry = page.locator('[data-send-state="pending"]');
    await expect(entry).toContainText("Show this prompt right away");
    const sendLatency = performance.now() - start;
    await info.attach("send-boundary-marks", {
      body: JSON.stringify({ sendLatencyMs: sendLatency }),
      contentType: "application/json",
    });
    expect(sendLatency).toBeLessThan(1000);
    await expect(entry.locator(".otk-send-meta")).toContainText("Sending");
    await expect(entry.getByRole("img", { name: "Sending", exact: true }))
      .toHaveCount(0);
    await expect(entry.locator(".otk-activity-indicator"))
      .toHaveAttribute("aria-hidden", "true");
    const messageID = await entry.getAttribute("data-message");
    const receipt = page.locator(`[data-message="${messageID}"]`);
    await receipt.evaluate((element) => {
      (window as unknown as { pendingEntry: Element }).pendingEntry = element;
    });
    const before = await receipt.locator(".otk-user-bubble").boundingBox();
    const dock = await page.locator(".otk-prompt").boundingBox();
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await page.screenshot({
        path: info.outputPath(`pend-pending-${theme}.png`),
        fullPage: true,
        animations: "disabled",
      });
    }
    await expect(page.getByRole("button", {
      name: "Retry",
      exact: true,
    })).toBeInViewport({ timeout: 20_000 });
    const pane = page.getByRole("region", { name: "Transcript", exact: true });
    const action = page.getByRole("button", {
      name: "Retry",
      exact: true,
    });
    const bounds = await pane.boundingBox(),
      button = await action.boundingBox();
    expect(button!.x).toBeGreaterThanOrEqual(bounds!.x);
    expect(button!.x + button!.width).toBeLessThanOrEqual(
      bounds!.x + bounds!.width,
    );
    expect(
      await pane.evaluate((element) =>
        element.scrollWidth - element.clientWidth
      ),
    ).toBeLessThan(2);
    await expect(receipt).toHaveAttribute("data-send-state", "failed");
    await expect(receipt).toContainText("not been observed");
    const failed = await receipt.locator(".otk-user-bubble").boundingBox();
    expect(Math.abs(failed!.y - before!.y)).toBeLessThan(1);
    await expect(receipt.locator(".otk-failure-target")).toHaveCount(0);
    await expect(receipt.locator("[aria-expanded]")).toHaveCount(1);
    const failure = await receipt.locator(".otk-send-failure").boundingBox();
    expect(Math.abs(failure!.x + failure!.width - failed!.x - failed!.width))
      .toBeLessThan(1);
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await page.screenshot({
        path: info.outputPath(`pend-failed-${theme}.png`),
        fullPage: true,
        animations: "disabled",
      });
    }
    expect(frames.sent.filter(({ frame }) => frame.method === "session.prompt"))
      .toHaveLength(1);
    await action.click();
    await expect(receipt).toHaveAttribute("data-send-state", "pending");
    frames.release();
    await reply(state, page, session.id, "The accepted response is retained.");
    await expect(page.locator(`[data-message="${messageID}"]`)).toHaveCount(1);
    await expect(receipt).toHaveAttribute("data-send-state", "committed");
    expect(
      await receipt.evaluate((element) =>
        element ===
          (window as unknown as { pendingEntry: Element }).pendingEntry
      ),
    ).toBe(true);
    const after = await receipt.locator(".otk-user-bubble").boundingBox();
    expect(Math.abs(after!.width - before!.width)).toBeLessThan(1);
    expect(Math.abs(after!.height - before!.height)).toBeLessThan(1);
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(1);
    expect(Math.abs(after!.x - before!.x)).toBeLessThan(1);
    const afterDock = await page.locator(".otk-prompt").boundingBox();
    expect(afterDock).toEqual(dock);
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await page.screenshot({
        path: info.outputPath(`pend-committed-${theme}.png`),
        fullPage: true,
        animations: "disabled",
      });
    }
    expect(frames.sent.filter(({ frame }) => frame.method === "session.prompt"))
      .toHaveLength(1);
  },
);

test("composer.own-send-follows-latest-from-a-reader-anchor", {
  tag: ["@composer", "@messages"],
}, async ({ state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Send follows the conversation",
  });
  await state.queue(["Earlier paragraph.\n\n".repeat(50) + "Earlier end."]);
  await state.native(`/session/${session.id}/prompt_async`, "POST", {
    parts: [{ type: "text", text: "Earlier prompt" }],
  });
  await openSession(state, page, session.id);
  await expect(page.getByText("Earlier end.", { exact: true })).toBeVisible();
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  const pane = page.getByRole("region", { name: "Transcript", exact: true });
  await pane.hover();
  await page.mouse.wheel(0, -350);
  await expect.poll(() =>
    pane.evaluate((element) =>
      element.scrollHeight - element.clientHeight - element.scrollTop
    )
  ).toBeGreaterThan(100);
  await state.queue(["Newest visible response."]);
  await prompt(page).fill("Newest visible prompt.");
  await send(page).click();
  await reply(state, page, session.id, "Newest visible response.");
  await expect.poll(() =>
    pane.evaluate((element) =>
      element.scrollHeight - element.clientHeight - element.scrollTop
    )
  ).toBeLessThan(3);
  await expect(pane.getByText("Newest visible prompt.", { exact: true }))
    .toBeInViewport();
  await expect(pane.getByText("Newest visible response.", { exact: true }))
    .toBeInViewport();
});

test(
  "messages.append-below-near-tail-anchor-exposes-one-new-messages-control",
  {
    tag: ["@messages"],
  },
  async ({ state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "New messages near the tail",
    });
    await state.queue(["Existing paragraph.\n\n".repeat(45) + "Existing end."]);
    await state.native(`/session/${session.id}/prompt_async`, "POST", {
      parts: [{ type: "text", text: "Existing prompt" }],
    });
    await openSession(state, page, session.id);
    await expect(page.getByText("Existing end.", { exact: true }))
      .toBeVisible();
    await expect(page.locator(`[data-session="${session.id}"]`))
      .toHaveAttribute("data-status", "idle");
    const pane = page.getByRole("region", { name: "Transcript", exact: true });
    await pane.hover();
    await page.mouse.wheel(0, -120);
    await expect.poll(() =>
      pane.evaluate((element) =>
        element.scrollHeight - element.clientHeight - element.scrollTop
      )
    ).toBeGreaterThan(50);
    const before = await pane.evaluate((element) => ({
      top: element.scrollTop,
      distance: element.scrollHeight - element.clientHeight - element.scrollTop,
      height: element.clientHeight,
    }));
    expect(before.distance).toBeLessThan(before.height);
    const source = await captureParagraph(pane);
    await state.queue(["External newest response."]);
    await state.native(`/session/${session.id}/prompt_async`, "POST", {
      parts: [{ type: "text", text: "External newest prompt." }],
    });
    const jump = page.getByRole("button", {
      name: /New messages.*Jump to latest/,
    });
    await expect(jump).toBeVisible();
    await expect(jump).toHaveCount(1);
    await expect.poll(async () =>
      Math.abs(await paragraphTop(pane, source) - source.top)
    )
      .toBeLessThan(1);
    await jump.click();
    await reply(state, page, session.id, "External newest response.");
    await expect(pane.getByText("External newest response.", { exact: true }))
      .toBeInViewport();
    await expect(jump).toHaveCount(0);
  },
);

test(
  "messages.dropped-publication-and-reconnect-converge-on-one-native-prompt",
  {
    tag: ["@messages", "@composer", "@transport"],
  },
  async ({ state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Clock gap recovery",
    });
    const frames = await wire(page);
    await openSession(state, page, session.id);
    let dropped = false;
    frames.hold((frame) => {
      const event = frame.event as { op?: string } | undefined;
      if (
        !dropped && frame.t === "content" && frame.sessionID === session.id &&
        event?.op === "message.upsert"
      ) {
        dropped = true;
        return true;
      }
      return false;
    });
    await state.queue(["Gap recovery preserves the complete final prose."]);
    await prompt(page).fill("Recover exactly this native prompt.");
    await send(page).click();
    await expect(prompt(page)).toHaveValue("");
    await reply(
      state,
      page,
      session.id,
      "Gap recovery preserves the complete final prose.",
    );
    expect(dropped).toBe(true);
    const accepted = frames.received.find((frame) => {
      if (
        frame.t !== "request.result" || !(frame.outcome as { ok?: boolean })?.ok
      ) return false;
      return frames.sent.some(({ frame: request }) =>
        request.method === "session.prompt" &&
        request.ref?.key === frame.ref?.key
      );
    });
    const messageID = (accepted?.outcome as { result?: { messageID?: string } })
      ?.result?.messageID;
    expect(messageID).toBeTruthy();
    await expect(page.locator(`[data-message="${messageID}"]`)).toHaveCount(1);
    const before = frames.connections().opened;
    frames.close();
    await expect.poll(() => frames.connections().opened).toBeGreaterThan(
      before,
    );
    await expect(page.locator(`[data-message="${messageID}"]`)).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Transcript", exact: true }))
      .toHaveAttribute("aria-busy", "false");
    expect(frames.sent.filter(({ frame }) => frame.method === "session.prompt"))
      .toHaveLength(1);
  },
);
