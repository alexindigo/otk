// SPDX-License-Identifier: LGPL-3.0-only
import { chmod, unlink, writeFile } from "node:fs/promises";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import {
  chips,
  messages,
  prompt,
  reply,
  upload,
} from "../../pages/composer.ts";

test.use({ profile: "composer-required" });
for (const mode of ["prompt", "command"] as const) {
  for (const fault of ["missing", "unreadable"] as const) {
    test(
      `composer.required-${mode}-${fault}-complete-draft-and-all-parts-retry`,
      { tag: ["@composer", "@isolated"] },
      async ({ isolatedState: state, page }) => {
        const session = await state.native<{ id: string }>("/session", "POST", {
          title: "Required attachments",
        });
        const other = await state.native<{ id: string }>("/session", "POST", {
          title: "Other draft",
        });
        const frames = await wire(page);
        await openSession(state, page, session.id);
        await prompt(page).fill(mode === "command" ? "/probe " : "Review ");
        for (const path of ["good.txt", "selected.txt"]) {
          await prompt(page).pressSequentially("@" + path);
          await expect(page.locator(".otk-autocomplete")).toContainText(path);
          await prompt(page).press("Enter");
          await expect(chips(page).filter({ hasText: "@" + path })).toHaveCount(
            1,
          );
        }
        await upload(page, [{
          name: "upload.txt",
          bytes: btoa("uploaded attachment bytes"),
        }]);
        await expect(chips(page)).toHaveCount(3);
        await expect(chips(page).filter({ hasText: "reading…" })).toHaveCount(
          0,
        );
        const readDraft = async () => ({
          input: await prompt(page).inputValue(),
          chips: await chips(page).allTextContents(),
        });
        const original = await readDraft(),
          path = state.directory + "/selected.txt";
        if (fault === "missing") await unlink(path);
        else await chmod(path, 0);
        try {
          await page.locator(".otk-prompt button[type=submit]").click();
          await expect(page.locator(".otk-composer-notice [role=alert]"))
            .toContainText("An attachment cannot be read");
          expect(await readDraft()).toEqual(original);
          expect((await state.observe<{ requests: unknown[] }>()).requests)
            .toHaveLength(0);
          expect(await messages(state, session.id)).toEqual([]);
          const request = frames.sent.filter(({ frame }) =>
            frame.method === `session.${mode}`
          ).at(-1)!.frame;
          expect(request).toBeDefined();
          await expect.poll(() =>
            frames.received.filter((frame) =>
              ["request.result", "request.rejected"].includes(frame.t) &&
              frame.ref?.key === request.ref!.key
            ).at(-1)
          ).toMatchObject({ t: "request.result", outcome: { ok: false } });
          await openSession(state, page, other.id);
          await expect(prompt(page)).toHaveValue("");
          await openSession(state, page, session.id);
          expect(await readDraft()).toEqual(original);
          if (fault === "missing") {
            await writeFile(path, "selected attachment bytes");
          } else await chmod(path, 0o600);
          await state.queue(["Every attachment received."]);
          await page.locator(".otk-prompt button[type=submit]").click();
          await reply(state, page, session.id, "Every attachment received.");
          await expect(prompt(page)).toHaveValue("");
          await expect(chips(page)).toHaveCount(0);
          const requests =
            (await state.observe<{ requests: { messages: unknown }[] }>())
              .requests;
          expect(requests.some((request) =>
            [
              "selected attachment bytes",
              "good attachment bytes",
              "uploaded attachment bytes",
            ].every((text) =>
              JSON.stringify(request.messages).includes(text)
            )
          )).toBe(true);
          const users = (await messages(state, session.id)).filter((row) =>
            row.info.role === "user"
          );
          expect(users).toHaveLength(1);
          expect(
            users[0].parts.filter((p) => p.type === "file").map((p) =>
              p.filename
            ).sort(),
          ).toEqual(["good.txt", "selected.txt", "upload.txt"]);
          expect(users[0].parts.some((p) =>
            p.url ===
              "data:text/plain;base64," + btoa("uploaded attachment bytes")
          )).toBe(true);
        } finally {
          if (fault === "unreadable") await chmod(path, 0o600);
        }
      },
    );
  }
}
