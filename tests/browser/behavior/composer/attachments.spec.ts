// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import {
  chips,
  completeUpload,
  holdUploads,
  messages,
  pasteText,
  pendingChips,
  prompt,
  readyChips,
  reply,
  upload,
} from "../../pages/composer.ts";

test(
  "composer.upload-completions-retain-edits-removals-concurrent-and-replaced-drafts",
  { tag: "@composer" },
  async ({ state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Upload ownership",
    });
    const other = await state.native<{ id: string }>("/session", "POST", {
      title: "Other draft",
    });
    await openSession(state, page, session.id);
    await holdUploads(page);
    const files = (names: string[]) =>
      names.map((name) => ({ name, bytes: btoa("bytes:" + name) }));
    await upload(page, files(["removed.txt", "second.txt"]));
    await expect.poll(() =>
      page.evaluate(() =>
        (globalThis as unknown as Window).composerReads.length
      )
    )
      .toBe(1);
    await prompt(page).pressSequentially(" surrounding edits ");
    await expect(prompt(page)).toHaveValue(/surrounding edits/);
    await page.getByRole("button", { name: "Remove [File 1]", exact: true })
      .click();
    await completeUpload(page, 0);
    await expect.poll(() =>
      page.evaluate(() =>
        (globalThis as unknown as Window).composerReads.length
      )
    )
      .toBe(2);
    await upload(page, files(["third.txt"]));
    await expect.poll(() =>
      page.evaluate(() =>
        (globalThis as unknown as Window).composerReads.length
      )
    )
      .toBe(3);
    await completeUpload(page, 2);
    await expect(readyChips(page)).toHaveCount(1);
    await completeUpload(page, 1);
    await expect(chips(page)).toHaveCount(2);
    await expect(pendingChips(page)).toHaveCount(0);
    await state.queue(["All retained file bytes received."]);
    await page.locator(".otk-prompt button[type=submit]").click();
    await expect.poll(async () =>
      (await messages(state, session.id)).find((row) =>
        row.info.role === "user"
      )?.parts.filter((p) => p.type === "file").map((p) => p.filename).sort()
    ).toEqual(["second.txt", "third.txt"]);
    const parts =
      (await messages(state, session.id)).find((row) =>
        row.info.role === "user"
      )!.parts;
    for (const name of ["second.txt", "third.txt"]) {
      expect(
        parts.find((p) => p.filename === name)?.url,
      ).toBe("data:text/plain;base64," + btoa("bytes:" + name));
    }
    expect(
      parts.some((p) =>
        p.type === "text" && p.text?.includes("surrounding edits")
      ),
    ).toBe(true);
    await reply(state, page, session.id, "All retained file bytes received.");
    await expect(chips(page)).toHaveCount(0);
    await upload(page, files(["old-session.txt"]));
    await expect.poll(() =>
      page.evaluate(() =>
        (globalThis as unknown as Window).composerReads.length
      )
    )
      .toBe(4);
    await expect(pendingChips(page)).toHaveCount(1);
    await openSession(state, page, other.id);
    await expect(chips(page)).toHaveCount(0);
    await prompt(page).fill("replacement draft");
    await completeUpload(page, 3);
    await expect(prompt(page)).toHaveValue("replacement draft");
    await expect(chips(page)).toHaveCount(0);
    await openSession(state, page, session.id);
    await expect(chips(page)).toContainText("[File 1]");
    await expect(pendingChips(page)).toHaveCount(0);
    await state.queue(["Retained upload received."]);
    await page.locator(".otk-prompt button[type=submit]").click();
    await expect.poll(async () =>
      (await messages(state, session.id)).flatMap((row) => row.parts).find(
        (p) => p.filename === "old-session.txt",
      )?.url
    ).toBe("data:text/plain;base64," + btoa("bytes:old-session.txt"));
    await reply(state, page, session.id, "Retained upload received.");
  },
);

test("composer.drop-paste-reference-and-exact-native-file", {
  tag: "@composer",
}, async ({ state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Attachments",
  });
  const other = await state.native<{ id: string }>("/session", "POST", {
    title: "Other",
  });
  await openSession(state, page, session.id);
  await upload(page, [{
    name: "client.txt",
    bytes: btoa("dropped client bytes"),
  }]);
  await expect(chips(page)).toContainText("[File 1]");
  await expect(pendingChips(page)).toHaveCount(0);
  await openSession(state, page, other.id);
  await expect(chips(page)).toHaveCount(0);
  await openSession(state, page, session.id);
  await expect(chips(page)).toHaveCount(1);
  await state.queue(["attachment received"]);
  await page.locator(".otk-prompt button[type=submit]").click();
  await expect(page.locator("[data-role=user] .otk-chip")).toContainText(
    "client.txt",
  );
  await expect.poll(async () =>
    (await messages(state, session.id)).find((row) => row.info.role === "user")
      ?.parts.find((p) => p.type === "file")?.url
  ).toBe("data:text/plain;base64," + btoa("dropped client bytes"));
  await reply(state, page, session.id, "attachment received");
  await pasteText(page, "README.md");
  await expect(chips(page)).toContainText("@README.md");
  await upload(page, [{
    name: "pixel.png",
    mime: "image/png",
    bytes:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=",
  }], "paste");
  await expect(chips(page)).toHaveCount(2);
  await expect(readyChips(page).filter({ hasText: "[Image 1]" })).toHaveCount(
    1,
  );
  await expect(page.locator(".otk-prompt button[type=submit]")).toBeEnabled();
});

test("composer.oversize-combined-files-retain-draft-without-send", {
  tag: "@composer",
}, async ({ state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Combined uploads",
  });
  const frames = await wire(page);
  await openSession(state, page, session.id);
  await page.evaluate(() => {
    const data = new DataTransfer(), bytes = new Uint8Array(17 * 1024 * 1024);
    for (let i = 1; i <= 3; i++) {
      data.items.add(
        new File([bytes], `part-${i}.txt`, { type: "text/plain" }),
      );
    }
    document.querySelector(".otk-prompt")!.dispatchEvent(
      new DragEvent("drop", { bubbles: true, dataTransfer: data }),
    );
  });
  await expect(chips(page)).toHaveCount(3);
  await expect(pendingChips(page)).toHaveCount(0);
  await page.locator(".otk-prompt button[type=submit]").click();
  await expect(page.locator(".otk-composer-notice [role=alert]")).toBeVisible();
  expect(frames.sent.filter(({ frame }) => frame.method === "session.prompt"))
    .toHaveLength(0);
  await expect(chips(page)).toHaveCount(3);
  expect((await state.observe<{ requests: unknown[] }>()).requests)
    .toHaveLength(0);
});
