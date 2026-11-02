// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
test.use({ profile: "messages-helper-pages" });
test("messages.helper-held-parent-paint-progress-removal-reload", {
  tag: ["@messages"],
}, async ({ isolatedState: state, page }, info) => {
  interface O {
    transport: {
      helper: {
        parent: { id: string; nativeID: string };
        child: { id: string; nativeID: string };
        work: { info: { id: string } };
        tool: { id: string };
      };
      reads: string[];
      childReads: number;
    };
  }
  const observation = async () => (await state.observe<O>()).transport,
    seed = await observation(),
    { parent, child, work, tool } = seed.helper;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    const Native = WebSocket;
    let start: number | undefined;
    Object.assign(globalThis, { helperPaint: undefined });
    globalThis.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", (e) => {
          const f = JSON.parse(e.data);
          if (f.t === "index.snapshot" && start === undefined) {
            start = performance.now();
          }
        });
      }
    };
    const inspect = () => {
      const cards = Array.from(document.querySelectorAll(".otk-task-card"));
      if (
        start !== undefined &&
        cards.some((e) =>
          e.textContent!.includes("Preparing progress…") &&
          e.getBoundingClientRect().bottom > 0 &&
          e.getBoundingClientRect().top < innerHeight
        )
      ) {
        requestAnimationFrame(() =>
          Object.assign(globalThis, {
            helperPaint: {
              ms: performance.now() - start!,
              cards: cards.length,
            },
          })
        );
        return;
      }
      requestAnimationFrame(inspect);
    };
    requestAnimationFrame(inspect);
  });
  await page.goto(state.url + "/helper-review/#/local/" + parent.id);
  await expect.poll(() =>
    page.evaluate(() =>
      (globalThis as typeof globalThis & { helperPaint?: { cards: number } })
        .helperPaint?.cards ?? 0
    )
  ).toBeGreaterThan(1);
  await expect.poll(() => observation().then((o) => o.childReads))
    .toBeGreaterThan(0);
  await info.attach("helper-paint", {
    body: JSON.stringify(
      await page.evaluate(() =>
        (globalThis as typeof globalThis & { helperPaint: unknown }).helperPaint
      ),
    ),
    contentType: "application/json",
  });
  const before = (await observation()).reads.length;
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "release",
  });
  await expect(
    page.locator(".otk-task-card").filter({ hasText: "1 tool call" }).first(),
  ).toBeAttached({ timeout: 60000 });
  await state.native(
    `/session/${child.id}/message/${work.info.id}/part/${tool.id}`,
    "DELETE",
  );
  await expect(
    page.locator(".otk-task-card").filter({ hasText: "0 tool calls" }).first(),
  ).toBeAttached({ timeout: 60000 });
  expect(
    (await observation()).reads.slice(before).filter((path) =>
      path.startsWith(`/session/${parent.nativeID}/message/`)
    ),
  ).toEqual([]);
  await page.reload();
  await expect(
    page.locator(".otk-task-card").filter({ hasText: "0 tool calls" }).first(),
  ).toBeAttached({ timeout: 60000 });
});
