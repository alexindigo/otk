// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import {
  messages,
  prompt,
  readyChips,
  reply,
  upload,
} from "../../pages/composer.ts";

test.use({ profile: "composer-submission" });

for (const mode of ["normal", "shell", "slash"] as const) {
  test(`composer.custody-${mode}-before-rpc-settlement`, {
    tag: ["@composer", "@transport", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: `Custody ${mode}`,
    });
    const frames = await wire(page);
    await openSession(state, page, session.id);
    const method = mode === "normal"
      ? "session.prompt"
      : mode === "shell"
      ? "session.shell"
      : "session.command";
    const ack = (
      frame: import("../../fixtures/wire.ts").Frame,
      request?: import("../../fixtures/wire.ts").Frame,
    ) => frame.t === "request.result" && request?.method === method;
    frames.hold((frame, request) =>
      ack(frame, request) ||
      frame.t === "content" && frame.sessionID === session.id ||
      frame.t === "load.chunk" &&
        (frame.data as { kind?: string })?.kind === "message-page" ||
      request?.method === "session.messages"
    );
    const input = prompt(page);
    const text = mode === "normal"
      ? "One captured prompt"
      : mode === "shell"
      ? "printf 'CUSTODY-SHELL'"
      : "/probe custody";
    if (mode === "shell") {
      await input.press("!");
      await expect(page.locator(".otk-prompt > label")).toHaveText("Shell");
    } else await state.queue(["Custody reply."]);
    if (mode === "normal") {
      const bytes = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 16;
        return canvas.toDataURL("image/png").split(",")[1];
      });
      await upload(page, [{
        name: "custody.png",
        mime: "image/png",
        bytes,
      }], "paste");
      await expect(readyChips(page)).toHaveCount(1);
    }
    try {
      await input.fill(text);
      await page.locator(".otk-prompt button[type=submit]").click();
      await expect.poll(() =>
        frames.sent.some(({ frame }) => frame.method === method)
      ).toBe(true);
      await expect(input).toHaveValue("");
      await expect(readyChips(page)).toHaveCount(0);
      if (mode === "normal") {
        frames.hold(ack);
        for (const delivery of frames.held.splice(0)) {
          if (ack(delivery.frame, delivery.request)) frames.held.push(delivery);
          else delivery.deliver();
        }
        await expect(page.locator("[data-send-key]")).toHaveAttribute(
          "data-send-state",
          "committed",
        );
        // Chromium's composition path creates a new draft even when its text
        // is byte-for-byte the same as the original Send.
        const cdp = await page.context().newCDPSession(page);
        await input.focus();
        await cdp.send("Input.imeSetComposition", {
          text,
          selectionStart: text.length,
          selectionEnd: text.length,
        });
        await cdp.send("Input.insertText", { text });
        await cdp.detach();
      } else await input.fill("Next prompt");
      frames.release();
      await expect(input).toHaveValue(mode === "normal" ? text : "Next prompt");
      const sent = frames.sent.filter(({ frame }) => frame.method === method);
      expect(sent).toHaveLength(1);
      expect(sent[0].frame.params?.messageID).toBeTruthy();
      if (mode === "normal") {
        const users = (await messages(state, session.id)).filter(({ info }) =>
          info.role === "user"
        );
        expect(users.map(({ info }) => info.id)).toEqual([
          sent[0].frame.params?.messageID,
        ]);
        expect(
          users[0].parts.some((part) =>
            part.type === "file" && part.mime === "image/png"
          ),
        ).toBe(true);
      }
      if (mode !== "shell") {
        await reply(state, page, session.id, "Custody reply.");
      }
    } finally {
      frames.release();
    }
  });
}

test.describe("choice-only custody", () => {
  test.use({ profile: "composer-pickers" });
  test("composer.custody-choice-only-edit-during-send", {
    tag: ["@composer", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {});
    const frames = await wire(page);
    await openSession(state, page, session.id);
    frames.hold((frame, request) =>
      frame.t === "request.result" && request?.method === "session.prompt"
    );
    await state.queue(["Choice reply."]);
    await prompt(page).fill("Captured before changing agent");
    await page.locator(".otk-prompt button[type=submit]").click();
    await expect.poll(() => frames.held.length).toBeGreaterThan(0);
    try {
      await page.locator(".otk-agent-picker > button").click();
      await page.locator(
        '.otk-agent-picker [data-picker-key="reviewer"] .otk-picker-option',
      ).click({ timeout: 5_000 });
      await expect(prompt(page)).toHaveValue("");
    } finally {
      frames.release();
    }
    expect(frames.sent.filter(({ frame }) => frame.method === "session.prompt"))
      .toHaveLength(1);
    await expect(page.locator(".otk-composer-agent")).toHaveText("Reviewer");
    await reply(state, page, session.id, "Choice reply.");
  });
});

test("composer.custody-refusal-retains-both-drafts-across-session-switch", {
  tag: ["@composer", "@transport", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  const first = await state.native<{ id: string }>("/session", "POST", {
    title: "Refused draft",
  });
  const second = await state.native<{ id: string }>("/session", "POST", {
    title: "Other draft",
  });
  // Reject the RPC at the real request boundary without committing native input.
  const frames = await wire(
    page,
    (frame) =>
      frame.method === "session.prompt"
        ? { ...frame, method: "test.refused-custody" }
        : frame,
  );
  await openSession(state, page, first.id);
  frames.hold((frame, request) =>
    request?.method === "session.prompt" &&
    (frame.t === "request.result" || frame.t === "request.rejected")
  );
  await upload(page, [{
    name: "retained.png",
    mime: "image/png",
    bytes:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=",
  }], "paste");
  await expect(readyChips(page)).toHaveCount(1);
  await prompt(page).fill("Original with an attachment");
  await page.locator(".otk-prompt button[type=submit]").click();
  await expect.poll(() => frames.held.length).toBeGreaterThan(0);
  await info.attach("refusal-outcome", {
    body: JSON.stringify(frames.held.map(({ frame }) => frame)),
    contentType: "application/json",
  });
  await prompt(page).fill("Newer input");
  await openSession(state, page, second.id);
  await prompt(page).fill("Other session input");
  frames.release();
  await expect(prompt(page)).toHaveValue("Other session input");
  await openSession(state, page, first.id);
  const recover = page.getByRole("button", {
    name: "Recover draft",
    exact: true,
  });
  await expect(recover).toBeVisible();
  await expect(prompt(page)).toHaveValue("Newer input");
  await recover.click();
  await expect(prompt(page)).toHaveValue("Original with an attachment");
  await expect(readyChips(page)).toHaveCount(1);
  await recover.click();
  await expect(prompt(page)).toHaveValue("Newer input");
  await expect(readyChips(page)).toHaveCount(0);
  expect(await messages(state, first.id)).toHaveLength(0);
  expect(frames.sent.filter(({ frame }) => frame.method === "session.prompt"))
    .toHaveLength(1);
});

test("composer.custody-uncertain-retry-checks-the-original-native-send", {
  tag: ["@composer", "@transport", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {});
  const frames = await wire(page);
  await openSession(state, page, session.id);
  frames.hold((frame, request) =>
    frame.t === "content" && frame.sessionID === session.id ||
    frame.t === "load.chunk" &&
      (frame.data as { kind?: string })?.kind === "message-page" ||
    request?.method === "session.messages" ||
    request?.method === "session.prompt" && frame.t === "request.result"
  );
  await state.queue(["Late commitment stayed authoritative."]);
  await prompt(page).fill("Submitted once before uncertainty");
  await page.locator(".otk-prompt button[type=submit]").click();
  const entry = page.locator("[data-send-key]");
  await expect(entry).toHaveAttribute("data-send-state", "failed", {
    timeout: 20_000,
  });
  await expect(prompt(page)).toHaveValue("");
  await prompt(page).fill("Unrelated next input");
  await entry.getByRole("button", { name: "Retry", exact: true }).click();
  frames.release();
  await expect(entry).toHaveAttribute("data-send-state", "committed");
  await expect(prompt(page)).toHaveValue("Unrelated next input");
  const sent = frames.sent.filter(({ frame }) =>
    frame.method === "session.prompt"
  );
  expect(sent).toHaveLength(1);
  await expect(entry).toHaveAttribute(
    "data-message",
    String(sent[0].frame.params?.messageID),
  );
  expect(
    (await messages(state, session.id)).filter(({ info }) =>
      info.role === "user"
    ).map(({ info }) => info.id),
  ).toEqual([sent[0].frame.params?.messageID]);
});
