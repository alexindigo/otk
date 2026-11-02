// SPDX-License-Identifier: LGPL-3.0-only
import { type CDPSession, expect, type Page } from "@playwright/test";
import type { TestState } from "./test-state.ts";
import { openSession } from "./wire.ts";
import { nativeIdle } from "../pages/transcript.ts";

export async function coolingCycles(
  state: TestState,
  page: Page,
  cdp: CDPSession,
  sample: (sessionID: string) => Promise<unknown> = () => Promise.resolve(null),
) {
  const a = await state.native<{ id: string }>("/session", "POST", {
    title: "Large code",
  });
  const b = await state.native<{ id: string }>("/session", "POST", {
    title: "Plain history",
  });
  await state.queue([
    "```ts\n" + Array.from({ length: 2000 }, (_, index) =>
      `const heap${index}: number = ${index};`).join("\n") +
    "\n```\n",
  ]);
  await state.native(`/session/${a.id}/prompt_async`, "POST", {
    parts: [{ type: "text", text: "Large code history" }],
  });
  await nativeIdle(state, a.id);
  for (const session of [a, b]) {
    await state.product("tasks.create", {
      directory: state.directory,
      name: session.id,
      sessions: [session.id],
    });
  }
  await openSession(state, page, b.id);
  await page.evaluate(() => document.fonts.ready);
  const samples: { cycle: number; loaded: unknown; released: unknown }[] = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    await openSession(state, page, a.id);
    await expect(page.locator(".otk-token").filter({ hasText: /^heap1999$/ }))
      .toHaveCount(1, { timeout: 60_000 });
    expect(
      (await cdp.send("Target.getTargets")).targetInfos.some((target) =>
        target.type === "worker"
      ),
    ).toBe(true);
    const loaded = await sample(a.id);
    await openSession(state, page, b.id);
    await expect(page.locator(".otk-code")).toHaveCount(0);
    await expect.poll(async () =>
      (await cdp.send("Target.getTargets")).targetInfos.some((target) =>
        target.type === "worker"
      )
    ).toBe(false);
    await page.evaluate(() =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
    );
    const released = await sample(a.id);
    samples.push({ cycle, loaded, released });
  }
  return samples;
}
