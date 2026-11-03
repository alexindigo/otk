// SPDX-License-Identifier: LGPL-3.0-only
import { isolatedTest as test } from "../fixtures/isolated.ts";
import { expect } from "../fixtures/evidence.ts";

test.use({ profile: "contract-scale-request" });
test(
  "scale.task-intent-socket-replacement",
  { tag: ["@scale"] },
  async ({ isolatedState: state, page }, info) => {
    test.setTimeout(180_000);
    const initial = await state.observe<
      { sessionID: string; counts: unknown; expectedCounts: unknown }
    >();
    expect(initial.counts).toEqual(initial.expectedCounts);
    await page.addInitScript(
      `window.requestSockets=[];window.requestFrames=[];window.WebSocket=class extends WebSocket{constructor(...args){super(...args);window.requestSockets.push(this)}send(value){window.requestFrames.push(JSON.parse(value));return super.send(value)}}`,
    );
    await page.goto(state.url + "/#/local/" + initial.sessionID);
    await page.locator(".otk-task-new").click();
    await page.locator('input[name="taskName"]').fill("perf");
    await page.locator('.otk-form button[type="submit"]').click();
    await expect.poll(async () =>
      (await state.observe<{ effects: number }>()).effects
    ).toBe(1);
    await expect(page.locator(".otk-form")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await expect(page.locator('input[name="taskName"]')).toHaveJSProperty(
      "readOnly",
      true,
    );
    await expect(page.locator('.otk-form [role="alert"],.otk-form [disabled]'))
      .toHaveCount(0);
    await page.evaluate(
      "document.querySelector('.otk-form').requestSubmit();window.requestSockets.at(-1).close()",
    );
    await expect.poll(() =>
      page.evaluate(
        "window.requestFrames.some(frame=>frame.t==='request.resume')",
      )
    ).toBe(true);
    expect((await state.observe<{ effects: number }>()).effects).toBe(1);
    expect(await state.product("tasks.list", { directory: state.directory }))
      .toEqual([]);
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "release",
    });
    await expect(page.locator('input[name="taskName"]')).toHaveCount(0);
    const tasks = await state.product("tasks.list", {
      directory: state.directory,
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe("perf");
    await expect(page.locator(`[data-tab="${tasks[0].id}"]`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const result = await state.observe<{ effects: number }>();
    expect(result.effects).toBe(1);
    await info.attach("population-control-measurements", {
      body: JSON.stringify(result),
      contentType: "application/json",
    });
  },
);
