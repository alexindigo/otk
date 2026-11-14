// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { chips, messages, prompt, reply } from "../../pages/composer.ts";
import { readFile } from "node:fs/promises";

const image =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
const pdf = btoa("%PDF-1.4\n%%EOF\n");
test(
  "composer.cold-recall-image-pdf-exact-ordered-bytes",
  { tag: "@composer" },
  async ({ state, page }) => {
    await state.native<{ id: string }>("/session", "POST", {
      title: "Provider recall source",
      messages: [{
        parts: [
          { type: "text", text: "Review the image and [PDF 1]" },
          {
            type: "file",
            filename: "pixel.png",
            mime: "image/png",
            url: `data:image/png;base64,${image}`,
          },
          {
            type: "file",
            filename: "report.pdf",
            mime: "application/pdf",
            url: `data:application/pdf;base64,${pdf}`,
          },
        ],
      }],
    });
    const target = await state.native<{ id: string }>("/session", "POST", {
      title: "Recalled attachments",
    });
    const frames = await wire(page);
    await openSession(state, page, target.id);
    await prompt(page).press("ArrowUp");
    await expect(chips(page)).toHaveCount(2);
    await expect(prompt(page)).toHaveValue(/Review the image/);
    expect(
      frames.sent.filter(({ frame }) => frame.method === "history.attachments"),
    ).toHaveLength(0);
    await state.queue(["Recalled files received."]);
    await page.locator(".otk-prompt button[type=submit]").click();
    await expect.poll(async () =>
      (await messages(state, target.id)).flatMap((row) => row.parts).filter(
        (p) => p.type === "file",
      ).map((p) => [p.filename, p.mime, p.url])
    ).toEqual([
      ["pixel.png", "image/png", `data:image/png;base64,${image}`],
      ["report.pdf", "application/pdf", `data:application/pdf;base64,${pdf}`],
    ]);
    await reply(state, page, target.id, "Recalled files received.");
    const batches = frames.sent.filter(({ frame }) =>
      frame.method === "history.attachments"
    );
    expect(batches).toHaveLength(1);
    expect(batches[0].frame.params!.refs).toHaveLength(2);
    await expect(chips(page)).toHaveCount(0);
    await expect(prompt(page)).toHaveValue("");
    const storage = `${state.controller.info!.root}/otk-${
      new URL(state.url).port
    }`;
    for (const name of ["otk.db", "digest.db", "otk.db-wal", "digest.db-wal"]) {
      try {
        const persisted = await readFile(`${storage}/${name}`, "utf8");
        for (const content of [image, pdf, "Review the image and [PDF 1]"]) {
          expect(persisted, `${name} retained provider content`).not.toContain(
            content,
          );
        }
      } catch (error) {
        if (
          !name.endsWith("-wal") ||
          (error as NodeJS.ErrnoException).code !== "ENOENT"
        ) throw error;
      }
    }
  },
);

test("composer.deleted-recall-rejects-with-complete-draft-and-no-send", {
  tag: "@composer",
}, async ({ state, page }) => {
  const source = await state.native<{ id: string }>("/session", "POST", {
    title: "Deleted recall source",
    messages: [{
      parts: [
        { type: "text", text: "Keep this recalled draft" },
        {
          type: "file",
          filename: "pixel.png",
          mime: "image/png",
          url: `data:image/png;base64,${image}`,
        },
      ],
    }],
  });
  const target = await state.native<{ id: string }>("/session", "POST", {
    title: "Keep recalled draft",
  });
  const frames = await wire(page);
  await openSession(state, page, target.id);
  await expect(page.locator(".otk-messages .otk-empty")).toHaveText(
    "Start a conversation below.",
  );
  await expect(page.locator(".otk-composer-notice")).toHaveCount(0);
  await prompt(page).press("ArrowUp");
  await expect(prompt(page)).toHaveValue("Keep this recalled draft");
  await expect(chips(page)).toHaveCount(1);
  await state.native(`/session/${source.id}`, "DELETE");
  await page.locator(".otk-prompt button[type=submit]").click();
  await expect(page.locator(".otk-composer-notice [role=alert]")).toHaveCount(
    1,
  );
  await expect(prompt(page)).toHaveValue("Keep this recalled draft");
  await expect(chips(page)).toHaveCount(1);
  expect(frames.sent.filter(({ frame }) => frame.method === "session.prompt"))
    .toHaveLength(0);
  expect((await state.observe<{ requests: unknown[] }>()).requests)
    .toHaveLength(0);
  const request = frames.sent.find(({ frame }) =>
    frame.method === "history.attachments"
  )!.frame;
  await expect.poll(() =>
    frames.received.some((frame) =>
      frame.t === "request.result" && frame.ref?.key === request.ref!.key &&
      (frame.outcome as { ok: boolean }).ok === false
    )
  ).toBe(true);
});

test("composer.definitive-recall-rejection-is-one-visible-failure", {
  tag: "@composer",
}, async ({ state, page }) => {
  const target = await state.native<{ id: string }>("/session", "POST", {
    title: "Unavailable recall",
  });
  const frames = await wire(
    page,
    (frame) =>
      frame.method === "history.list"
        ? { ...frame, method: "fixture.history.unavailable" }
        : frame,
  );
  await openSession(state, page, target.id);
  await expect(page.locator(".otk-messages .otk-empty")).toHaveText(
    "Start a conversation below.",
  );
  await expect(page.locator(".otk-composer-notice")).toHaveCount(0);
  await prompt(page).press("ArrowUp");
  await expect(page.locator(".otk-composer-notice [role=alert]")).toHaveCount(
    1,
  );
  await expect(page.locator(".otk-composer-notice [role=alert]"))
    .toContainText("Unknown method: fixture.history.unavailable");
  await expect(prompt(page)).toHaveValue("");
  await expect(chips(page)).toHaveCount(0);
  expect(frames.sent.filter(({ frame }) => frame.method === "history.list"))
    .toHaveLength(1);
  const request = frames.sent.find(({ frame }) =>
    frame.method === "history.list"
  )!.frame;
  await expect.poll(() =>
    frames.received.some((frame) =>
      frame.t === "request.rejected" && frame.ref?.key === request.ref!.key
    )
  ).toBe(true);
});

test("composer.recalled-caret-accepts-next-native-key-before-paint", {
  tag: "@composer",
}, async ({ state, page }) => {
  await state.native<{ id: string }>("/session", "POST", {
    title: "Caret source",
    messages: ["older caret prompt", "newer caret prompt"].map((text) => ({
      parts: [{ type: "text", text }],
    })),
  });
  const target = await state.native<{ id: string }>("/session", "POST", {
    title: "Caret recall",
  });
  await openSession(state, page, target.id);
  await prompt(page).focus();
  await expect(prompt(page)).toBeFocused();
  await page.evaluate(() => {
    const saved = requestAnimationFrame;
    Object.assign(globalThis, {
      restoreComposerRaf: () => {
        globalThis.requestAnimationFrame = saved;
      },
    });
    globalThis.requestAnimationFrame = () => 1;
  });
  try {
    await page.keyboard.press("ArrowUp");
    await expect(prompt(page)).toHaveValue("newer caret prompt");
    await page.keyboard.press("ArrowUp");
    await expect(prompt(page)).toHaveValue("older caret prompt");
  } finally {
    await page.evaluate(() =>
      (globalThis as unknown as { restoreComposerRaf(): void })
        .restoreComposerRaf()
    );
  }
});
