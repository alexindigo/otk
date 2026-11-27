// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { seed } from "../../pages/attention.ts";

test("attention.sidebar-timers-use-run-and-visit-clocks", {
  tag: ["@attention", "@projects", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  const selected = await seed(state, "Review console");
  const running = await seed(state, "Background work");
  const finished = await state.controller.call<{
    id: string;
    nativeID: string;
    directory: string;
  }>("nativeRequest", {
    lease: state.lease.lease,
    path: "/session",
    method: "POST",
    project: "secondary",
    body: { title: "Finished review" },
  });
  for (const directory of [state.directory, finished.directory]) {
    await state.product("projects.visit", { directory, active: true });
  }
  const task = await state.product("tasks.create", {
    directory: state.directory,
    name: "Background work",
    sessions: [running.id],
  });
  await state.product("prefs.set", { key: "theme", value: "otk-dark" });
  await state.product("prefs.set", { key: "animationsOff", value: true });
  await state.product("prefs.set", { key: "notify.toast", value: false });
  await page.clock.install();
  await openSession(state, page, selected.id);
  const row = (directory: string) =>
    page.locator(
      `.otk-project-row[data-project=${JSON.stringify(directory)}]`,
    );
  const green = row(state.directory), yellow = row(finished.directory);
  const timer = (project: typeof green) =>
    project.locator(".otk-project-visit time");
  await expect(green).toHaveAttribute("data-rollup", "none");
  await expect(timer(green)).toHaveText("now");

  await state.queue(["Review finished."]);
  const prompt = (text: string) => ({
    parts: [{ type: "text", text }],
  });
  await state.controller.call("nativeRequest", {
    lease: state.lease.lease,
    path: `/session/${finished.nativeID}/prompt_async`,
    method: "POST",
    project: "secondary",
    body: prompt("Finish an unseen review"),
  });
  await expect(yellow).toHaveAttribute("data-rollup", "finished");
  await expect(timer(yellow)).toHaveText("now");
  const yellowVisit = await timer(yellow).getAttribute("datetime");
  const { gate } = await state.queue(["Work finished."], "held");
  try {
    await state.native(
      `/session/${running.id}/prompt_async`,
      "POST",
      prompt("Work in the background"),
    );
    await expect(green).toHaveAttribute("data-rollup", "working");
    // Native busy can arrive before the held request reaches the provider.
    await expect.poll(async () =>
      (await state.observe<{ pending: number }>()).pending
    ).toBe(0);
    const box = await green.boundingBox();
    const run = timer(green);
    await expect(run).toHaveAttribute("data-tone", "muted");
    const taskRun = page.locator(`[data-session-group="${task.id}"] time`);
    await expect(taskRun).toHaveAttribute("data-tone", "muted");
    await expect(run).toHaveText("now");
    await page.clock.fastForward(60_000);
    await expect(run).toHaveText("1m");
    await expect(taskRun).toHaveText("1m");
    await page.clock.fastForward(3_540_000);
    for (const shown of [run, taskRun, timer(yellow)]) {
      await expect(shown).toHaveText("1h");
    }
    await expect(timer(yellow)).toHaveAttribute("datetime", yellowVisit!);
    expect(await green.boundingBox()).toEqual(box);
    for (
      const [theme, name] of [["otk-dark", "dark"], ["otk-light", "linen"]]
    ) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      for (const shown of [run, taskRun, timer(yellow)]) {
        await expect(shown).toBeVisible();
      }
      expect(
        await run.evaluate((element) => {
          const muted = getComputedStyle(element.parentElement!).color;
          const parts = Array.from(
            element.querySelectorAll(".otk-time-unit, .otk-time-value"),
          );
          return parts.length >= 2 &&
            parts.every((part) => getComputedStyle(part).color === muted);
        }),
      ).toBe(true);
      const attention = timer(yellow);
      expect(
        await attention.evaluate((element) =>
          getComputedStyle(element.querySelector(".otk-time-unit")!).color !==
            getComputedStyle(element.querySelector(".otk-time-value")!).color
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`project-timer-pair-${name}.png`),
        animations: "disabled",
        fullPage: true,
      });
    }
  } finally {
    await state.release(gate);
  }
  await expect(green).toHaveAttribute("data-rollup", "finished");
});
