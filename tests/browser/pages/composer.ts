// SPDX-License-Identifier: LGPL-3.0-only
import { expect, type Page } from "@playwright/test";
import type { TestState } from "../fixtures/test-state.ts";
import type { wire } from "../fixtures/wire.ts";

export const prompt = (page: Page) => page.locator("textarea[name=prompt]");
export const chips = (page: Page) => page.locator(".otk-prompt-chip");
/** Submission readiness is separate from chip paint and native turn idle. */
export async function sendPrompt(page: Page) {
  await expect(page.locator(".otk-send-button:not(:disabled)")).toBeVisible();
  await expect(prompt(page)).toBeFocused();
  await page.keyboard.press("Enter");
}
export async function viewing(
  page: Page,
  frames: Awaited<ReturnType<typeof wire>>,
  id: string,
) {
  for (const method of ["layout.location", "sessions.seen"]) {
    await expect.poll(() => {
      const request = frames.sent.find(({ frame }) =>
        frame.method === method && frame.params?.sessionID === id
      )?.frame;
      return !!request &&
        frames.received.some((frame) =>
          frame.t === "request.result" && frame.ref?.key === request.ref!.key &&
          (frame.outcome as { ok: boolean }).ok
        );
    }).toBe(true);
  }
  await expect(page.locator(".otk-composer-notice")).toHaveCount(0);
}
export interface NativeMessage {
  info: { id: string; role: string; agent?: string; model?: unknown };
  parts: {
    type: string;
    text?: string;
    filename?: string;
    mime?: string;
    url?: string;
    tool?: string;
    state?: { status: string };
  }[];
}
export const messages = (state: TestState, id: string) =>
  state.native<NativeMessage[]>(`/session/${id}/message`);
export async function reply(
  state: TestState,
  page: Page,
  id: string,
  text: string,
) {
  await expect(
    page.locator("[data-role=assistant] .otk-text").filter({ hasText: text }),
  ).toHaveText(text);
  await expect(page.locator(`[data-session="${id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await expect(
    page.locator(".otk-message-footer").filter({ hasText: "streaming" }),
  ).toHaveCount(0);
  await expect.poll(async () =>
    (await state.observe<{ active: number }>()).active
  ).toBe(0);
}
export async function pasteText(page: Page, text: string) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await prompt(page).focus();
  await page.keyboard.press("Control+v");
}
export async function upload(
  page: Page,
  files: { name: string; bytes: string; mime?: string }[],
  kind: "paste" | "drop" = "drop",
) {
  await page.evaluate(({ files, kind }) => {
    const data = new DataTransfer();
    for (const file of files) {
      data.items.add(
        new File(
          [Uint8Array.from(atob(file.bytes), (c) => c.charCodeAt(0))],
          file.name,
          { type: file.mime ?? "text/plain" },
        ),
      );
    }
    document.querySelector(
      kind === "paste" ? "textarea[name=prompt]" : ".otk-prompt",
    )!.dispatchEvent(
      kind === "paste"
        ? new ClipboardEvent("paste", { bubbles: true, clipboardData: data })
        : new DragEvent("drop", { bubbles: true, dataTransfer: data }),
    );
  }, { files, kind });
}
declare global {
  interface Window {
    composerReads: { name: string; complete(): Promise<void> }[];
  }
}
export async function holdUploads(page: Page) {
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer;
    const owner = globalThis as unknown as Window;
    owner.composerReads = [];
    File.prototype.arrayBuffer = function () {
      return new Promise((resolve) =>
        owner.composerReads.push({
          name: this.name,
          complete: async () => resolve(await original.call(this)),
        })
      );
    };
  });
}
export async function completeUpload(page: Page, index: number) {
  await page.evaluate(
    (index) =>
      (globalThis as unknown as Window).composerReads[index].complete(),
    index,
  );
}
