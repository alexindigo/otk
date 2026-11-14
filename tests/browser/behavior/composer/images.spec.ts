// SPDX-License-Identifier: LGPL-3.0-only
import {
  expectPrimaryBlocked,
  send as composerSend,
} from "../../pages/primary-action.ts";
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import {
  chips,
  completeUpload,
  holdUploads,
  messages,
  pendingChips,
  prompt,
  reply,
  upload,
} from "../../pages/composer.ts";
import { scrollTranscript, wheelTranscript } from "../../pages/transcript.ts";

test(
  "composer.images-paste-drop-unique-chip-native-original-dialog-and-recall",
  { tag: "@composer" },
  async ({ state, page }) => {
    test.setTimeout(120_000);
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Image review",
    });
    const other = await state.native<{ id: string }>("/session", "POST", {
      title: "Other draft",
    });
    const frames = await wire(page);
    await state.product("prefs.set", { key: "animationsOff", value: true });
    await openSession(state, page, session.id);
    const image = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 400;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#234651";
      ctx.fillRect(0, 0, 640, 400);
      ctx.fillStyle = "#7fc8b8";
      ctx.fillRect(40, 40, 240, 240);
      ctx.fillStyle = "#f2c16d";
      ctx.beginPath();
      ctx.arc(440, 160, 100, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = "24px sans-serif";
      ctx.fillText("Image review · 640 × 400", 40, 350);
      return canvas.toDataURL("image/png");
    });
    const add = (kind: "paste" | "drop", name: string) =>
      upload(
        page,
        [{ name, bytes: image.split(",")[1], mime: "image/png" }],
        kind,
      );
    const reveal = async (id: string) => {
      await page.locator("[data-panel-view=timeline]").click();
      await page.locator(`[data-timeline-prompt="${id}"] .otk-timeline-reveal`)
        .click();
      const bubble = page.locator(`[data-message="${id}"] .otk-user-bubble`);
      await expect(bubble).toBeFocused();
      await expect.poll(() =>
        bubble.evaluate((element) => {
          const box = element.getBoundingClientRect(),
            pane = document.querySelector(".otk-messages")!
              .getBoundingClientRect();
          return box.top >= pane.top - .5 && box.bottom <= pane.bottom + .5;
        })
      ).toBe(true);
    };
    const imageMessages = async (count: number) => {
      await expect.poll(async () =>
        (await messages(state, session.id)).filter((row) =>
          row.info.role === "user" && row.parts.some((p) => p.type === "file")
        ).length
      ).toBe(count);
      for (
        const row of (await messages(state, session.id)).filter((row) =>
          row.info.role === "user"
        )
      ) {
        expect(row.parts.filter((p) => p.type === "file").map((p) => p.url))
          .toEqual([image]);
        await reveal(row.info.id);
        const thumb = page.locator(
          `[data-message="${row.info.id}"] .otk-file-image img`,
        );
        await expect(thumb).toHaveCount(1);
        await expect.poll(() =>
          thumb.evaluate((img) => ({
            complete: (img as HTMLImageElement).complete,
            width: (img as HTMLImageElement).naturalWidth,
            src: (img as HTMLImageElement).src,
          }))
        ).toEqual({ complete: true, width: 640, src: image });
      }
      await page.locator("[data-panel-view=sessions]").click();
      // A reveal pauses following even if already at bottom. Preserve the actual
      // downward-wheel intent before converging on the live measured range.
      await wheelTranscript(page, 100000);
      await scrollTranscript(page, true);
    };
    await prompt(page).fill("What is in this image?");
    await add("paste", "sample.png");
    await expect(chips(page)).toHaveCount(1);
    await expect(pendingChips(page)).toHaveCount(0);
    await expect(prompt(page)).toHaveValue("What is in this image?");
    await expect.poll(() =>
      chips(page).locator("img").evaluate((img) =>
        (img as HTMLImageElement).naturalWidth
      )
    ).toBe(640);
    await expect(chips(page).locator("img")).toHaveAttribute("src", image);
    await prompt(page).fill("Edited question");
    await page.getByRole("button", { name: "Edit prompt", exact: true })
      .click();
    await page.locator("textarea[name=editor]").fill("Describe these shapes.");
    await page.locator(".otk-editor footer button").last().click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(chips(page).locator("img")).toHaveCount(1);
    await openSession(state, page, other.id);
    await expect(chips(page)).toHaveCount(0);
    await openSession(state, page, session.id);
    await expect(prompt(page)).toHaveValue("Describe these shapes.");
    await expect(chips(page).locator("img")).toHaveCount(1);
    await state.queue(["The image contains a square and a circle."]);
    await page.locator(".otk-prompt button[type=submit]").click();
    await reply(
      state,
      page,
      session.id,
      "The image contains a square and a circle.",
    );
    const user = (await messages(state, session.id)).find((row) =>
      row.info.role === "user"
    )!;
    expect(user.parts.filter((p) => p.type === "file").map((p) => p.url))
      .toEqual([image]);
    expect(
      user.parts.filter((p) => p.type === "text").some((p) =>
        p.text?.includes("[Image")
      ),
    ).toBe(false);
    await reveal(user.info.id);
    await expect(page.locator(`[data-message="${user.info.id}"] .otk-text`))
      .toHaveText("Describe these shapes.");
    await expect(chips(page)).toHaveCount(0);
    const source = page.locator(
      `[data-message="${user.info.id}"] .otk-file-image`,
    );
    await source.click();
    const original = page.locator("dialog[open] .otk-image-view img");
    await expect.poll(() =>
      original.evaluate((img) => (img as HTMLImageElement).naturalWidth)
    ).toBe(640);
    await expect(original).toHaveAttribute("src", image);
    await expect(page.locator("dialog[open] h2")).toHaveCount(1);
    await expect.poll(async () => {
      const a = await source.locator("img").boundingBox(),
        b = await original.boundingBox();
      return !!a && !!b && b.width > a.width &&
        Math.abs(b.width / b.height - 1.6) < .01;
    }).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(source).toBeFocused();
    await page.locator("[data-panel-view=sessions]").click();
    await page.reload();
    await expect.poll(() =>
      page.locator("[data-role=user] .otk-file-image img").evaluate((img) =>
        (img as HTMLImageElement).naturalWidth
      )
    ).toBe(640);
    await add("drop", "second.png");
    await expect(chips(page).locator("img")).toHaveCount(1);
    await expect(page.locator(".otk-prompt button[type=submit]")).toBeEnabled();
    await expect(prompt(page)).toHaveValue("");
    await state.queue(["Second image received."]);
    await page.locator(".otk-prompt button[type=submit]").click();
    await expect(chips(page)).toHaveCount(0);
    await reply(state, page, session.id, "Second image received.");
    const prompts = frames.sent.filter(({ frame }) =>
      frame.method === "session.prompt"
    );
    expect(prompts).toHaveLength(2);
    const sent = prompts[1].frame.params!.parts as {
      kind: string;
      text?: string;
    }[];
    expect(sent.filter((p) => p.kind === "file")).toHaveLength(1);
    expect(sent.filter((p) => p.kind === "text").every((p) => p.text === ""))
      .toBe(true);
    await imageMessages(2);
    await prompt(page).press("ArrowUp");
    await expect(chips(page)).toHaveCount(1);
    await expect(chips(page).locator("button").first()).toHaveAttribute(
      "title",
      "second.png",
    );
    await expect(prompt(page)).toHaveValue("");
    expect(
      frames.sent.filter(({ frame }) => frame.method === "history.attachments"),
    ).toHaveLength(0);
    await state.queue(["Recalled image received."]);
    await page.locator(".otk-prompt button[type=submit]").click();
    await reply(state, page, session.id, "Recalled image received.");
    expect(
      frames.sent.filter(({ frame }) => frame.method === "history.attachments"),
    ).toHaveLength(1);
    await imageMessages(3);
    await add("paste", "remove.png");
    await expect(chips(page).locator("img")).toHaveCount(1);
    await chips(page).getByRole("button", { name: /^Remove/ }).click();
    await expect(chips(page)).toHaveCount(0);
    await expectPrimaryBlocked(composerSend(page), "Write a message");
    await upload(page, [{ name: "notes.txt", bytes: btoa("plain bytes") }]);
    await expect(page.locator(".otk-prompt button[type=submit]")).toBeEnabled();
    await state.queue(["File received."]);
    await page.locator(".otk-prompt button[type=submit]").click();
    await expect(
      page.locator("[data-role=user] .otk-chip").filter({
        hasText: "notes.txt",
      }),
    ).toBeVisible();
    await reply(state, page, session.id, "File received.");
  },
);

test("composer.pending-image-session-owner-and-removal-fence", {
  tag: "@composer",
}, async ({ state, page }) => {
  const a = await state.native<{ id: string }>("/session", "POST", {
    title: "Pending image",
  });
  const z = await state.native<{ id: string }>("/session", "POST", {
    title: "Independent draft",
  });
  const frames = await wire(page);
  await openSession(state, page, a.id);
  await holdUploads(page);
  const paste = () =>
    upload(page, [{
      name: "pending.png",
      mime: "image/png",
      bytes:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=",
    }], "paste");
  await paste();
  await expect.poll(() =>
    page.evaluate(() => (globalThis as unknown as Window).composerReads.length)
  )
    .toBe(1);
  await expect(pendingChips(page)).toHaveCount(1);
  await expect(prompt(page)).toHaveValue("");
  await openSession(state, page, z.id);
  await prompt(page).fill("Keep this draft");
  await completeUpload(page, 0);
  await expect(chips(page)).toHaveCount(0);
  await expect(prompt(page)).toHaveValue("Keep this draft");
  await openSession(state, page, a.id);
  await expect.poll(() =>
    chips(page).locator("img").evaluate((img) =>
      (img as HTMLImageElement).naturalWidth
    )
  ).toBe(1);
  await chips(page).getByRole("button", { name: /^Remove/ }).click();
  await paste();
  await expect.poll(() =>
    page.evaluate(() => (globalThis as unknown as Window).composerReads.length)
  )
    .toBe(2);
  await expect(chips(page)).toHaveCount(1);
  await chips(page).getByRole("button", { name: /^Remove/ }).click();
  await completeUpload(page, 1);
  await expect(chips(page)).toHaveCount(0);
  await expect(prompt(page)).toHaveValue("");
  await expectPrimaryBlocked(composerSend(page), "Write a message");
  expect(frames.sent.filter(({ frame }) => frame.method === "session.prompt"))
    .toHaveLength(0);
});
