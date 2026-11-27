// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";

test.use({ profile: "contract-sessions-hierarchy" });

test("composer.subagents-clear-removes-only-finished", {
  tag: ["@composer", "@sessions", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const transport = await wire(page);
  const theme = process.env.OTK_CLEAR_THEME;
  if (theme) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await state.product("prefs.set", { key: "textSize", value: "125" });
    await state.product("prefs.set", { key: "animationsOff", value: true });
  }
  const main = "tstv1-otk";
  const task = await state.product("tasks.create", {
    directory: state.directory,
    name: "Review helpers",
    sessions: [main],
  });
  for (const sessionID of [main, "tstv1-blocked"]) {
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "release",
      sessionID,
    });
  }
  await openSession(state, page, main);
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "hold",
    target: "helper-review",
  });

  const pill = page.getByRole("button", {
    name: "Subagents: 1 needs you, 5 finished, 2 running", // D78
  });
  const lamps = pill.locator(".otk-status-light:visible");
  await expect(pill).toHaveText(/^\s*1\s*5\s*2\s*$/);
  for (const [i, kind] of ["blocked", "finished", "working"].entries()) {
    await expect(lamps.nth(i)).toHaveAttribute("data-state", kind);
  }
  await pill.hover();
  if (theme) await page.screenshot({ path: info.outputPath("clear-pill.png") });
  await pill.click();
  const dropdown = page.getByRole("menu", { name: "Subagents" });
  const button = page.getByRole("button", { name: "Clear finished" });
  await expect(dropdown.getByRole("group", { name: "Finished 5" }))
    .toBeVisible();
  await expect(
    dropdown.getByRole("menuitem", { name: "Reported helper failure" }),
  )
    .toBeVisible();
  await expect(dropdown.locator('.otk-status-light[data-state="none"]'))
    .toHaveCount(0);
  await expect(button).toBeVisible();
  const geometry = () =>
    button.evaluate((node) => {
      const b = node.getBoundingClientRect();
      const i = node.querySelector("svg")!.getBoundingClientRect();
      const label = node.querySelector(".otk-control-label")!;
      const t = label.getBoundingClientRect();
      const header = node.closest(".otk-surface-title")!;
      const heading = header.querySelector("h2")!.getBoundingClientRect();
      const h = header.getBoundingClientRect();
      return {
        gaps: [
          i.left - b.left,
          i.top - b.top,
          b.bottom - i.bottom,
          b.right - t.right,
        ],
        headerInsets: [heading.left - h.left, h.right - b.right],
        oneLine: getComputedStyle(label).whiteSpace === "nowrap",
      };
    });
  for (const mode of ["hover", "focus"] as const) {
    if (mode === "hover") await button.hover();
    else {
      await page.mouse.move(0, 0);
      await page.keyboard.press("Escape");
      await expect(pill).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(dropdown.getByRole("menuitem").first()).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(button).toBeFocused();
      await expect(button).toHaveCSS("outline-style", "solid");
      await page.keyboard.press("Shift+Tab");
      await expect(dropdown.getByRole("menuitem").first()).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(button).toBeFocused();
    }
    const { gaps, headerInsets, oneLine } = await geometry();
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(3);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
    expect(Math.abs(headerInsets[0] - headerInsets[1])).toBeLessThanOrEqual(1);
    expect(oneLine).toBe(true);
    if (theme) {
      await page.screenshot({
        path: info.outputPath(`clear-finished-${mode}.png`),
      });
    }
  }

  transport.hold((frame, request) =>
    frame.t === "inbox.patch" ||
    (request?.method === "sessions.acknowledge" && frame.t === "request.result")
  );
  try {
    await button.click();
    await expect(button).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("status").filter({ hasText: "Clearing..." }))
      .toBeVisible();
    await expect.poll(() =>
      transport.held.some(({ request }) =>
        request?.method === "sessions.acknowledge"
      )
    ).toBe(true);
  } finally {
    transport.release();
  }
  await expect(dropdown.getByRole("group", { name: /^Finished/ })).toHaveCount(
    0,
  );
  await expect(button).toHaveCount(0);
  await expect(dropdown.getByRole("group", { name: "Running 2" }))
    .toBeVisible();
  await expect(dropdown.getByRole("group", { name: "Needs you 1" }))
    .toBeVisible();
  await expect(
    page.getByRole("button", { name: "Subagents: 1 needs you, 2 running" }),
  )
    .toHaveText(/^\s*1\s*2\s*$/);
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "release",
    sessionID: "tstv1-disp-2",
  });
  const tabLamp = page.locator(`[data-tab="${task.id}"] .otk-status-light`);
  await expect(tabLamp).toHaveAttribute("data-state", "finished"); // D78
  await state.product("sessions.acknowledge", {
    scope: "subtree",
    sessionID: "tstv1-disp-2",
  });
  await expect(tabLamp).toHaveAttribute("data-state", "working");
});
