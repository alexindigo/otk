// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { activity } from "../../pages/sessions.ts";
import { openSession } from "../../fixtures/wire.ts";

test.use({ profile: "contract-sessions-default" });
test("composer.task-target-header-shares-row-with-subagents-in-all-themes", {
  tag: ["@composer", "@sessions", "@contracts", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  const taskName =
    "Sticky selected task: review the destination before sending a message to the intended conversation";
  const task = await state.product("tasks.create", {
    directory: state.directory,
    name: taskName,
    sessions: ["tstv1-otk"],
  });
  await activity(state, "tstv1-urgent-child", "hold");
  await openSession(state, page, "tstv1-otk");
  const target = page.locator(".otk-composer-target");
  const work = page.locator(".otk-composer-activity .otk-live-work-trigger");
  await expect(target).toContainText(taskName);
  await expect(work).toContainText("1 subagent");
  await expect(page.locator(`[data-tab="${task.id}"]`)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const title = await target.getAttribute("title");
  expect(title).toContain(taskName);
  const geometry = async () => {
    const box = await target.evaluate((label) => {
      const row = label.parentElement!;
      const work = row.querySelector(".otk-live-work-trigger")!;
      const l = label.getBoundingClientRect(), w = work.getBoundingClientRect();
      // Style7 finding 3: task and destination have separate label ownership.
      // notes/2026-11-21-style7fix.md; decision 3 keeps the actual open session named.
      const labels = Array.from(
        label.querySelectorAll<HTMLElement>(".otk-control-label"),
      ).map((item) => ({
        text: item.textContent,
        whiteSpace: getComputedStyle(item).whiteSpace,
        overflow: getComputedStyle(item).textOverflow,
        centerDrift: Math.abs(
          (item.getBoundingClientRect().top +
            item.getBoundingClientRect().bottom - w.top - w.bottom) / 2,
        ),
        truncated: item.scrollWidth > item.clientWidth,
      }));
      return {
        display: getComputedStyle(row).display,
        left: l.left,
        right: l.right,
        workLeft: w.left,
        centerDrift: Math.abs((l.top + l.bottom - w.top - w.bottom) / 2),
        labels,
        title: label.getAttribute("title"),
        text: labels.map((item) => item.text).join(": "),
        truncated: labels[0].truncated,
      };
    });
    expect(box.display).toBe("flex");
    expect(box.right).toBeLessThanOrEqual(box.workLeft);
    expect(box.centerDrift).toBeLessThanOrEqual(0.5);
    expect(box.labels).toHaveLength(2);
    for (const label of box.labels) {
      expect(label.whiteSpace).toBe("nowrap");
      expect(label.overflow).toBe("ellipsis");
      expect(label.centerDrift).toBeLessThanOrEqual(0.5);
    }
    expect(box.labels[1].truncated).toBe(false);
    expect(box.title).toBe(box.text);
    return box;
  };
  for (
    const [theme, label] of [["otk-dark", "dark"], ["otk-light", "linen"], [
      "otk-light-stone",
      "stone",
    ]]
  ) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await geometry();
    await page.screenshot({
      path: info.outputPath(`composer-task-${label}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
  await page.setViewportSize({ width: 800, height: 800 });
  expect((await geometry()).truncated).toBe(true);
  await activity(state, "tstv1-urgent-child", "release");
  await expect(work).toHaveCount(0);
  await expect(target).toContainText(taskName);
  await page.reload();
  await expect(target).toContainText(taskName);
});
