// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { seed, tool } from "../../pages/attention.ts";
import { focusNotifications, toast } from "../../pages/notifications.ts";
import { auditUiRules } from "../../pages/ui-rules.ts";

test.use({ profile: "contract-attention-native" });
test("visual.toast-compact-geometry-dismiss-and-lamp", {
  tag: ["@attention", "@visual", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  const a = await seed(state, "Current conversation");
  const b = await seed(
    state,
    "Review the notification layout and the remaining small fixes",
  );
  const c = await seed(state, "Inspect the project README");
  const frames = await wire(page);
  // Audit the whole shell with both history directions available.
  await openSession(state, page, c.id);
  const aURL = `${state.url}/#/local/${a.id}`;
  await page.goto(aURL);
  await expect(page.locator(`[data-crumb="${a.id}"]`)).toBeVisible();
  await page.goto(`${state.url}/#/local/${c.id}`);
  await expect(page.locator(`[data-crumb="${c.id}"]`)).toBeVisible();
  const history = page.getByRole("navigation", { name: "Session history" });
  const back = history.getByRole("button").first();
  const forward = history.getByRole("button").last();
  await back.click();
  await expect(page).toHaveURL(aURL);
  await expect(back).toBeEnabled();
  await expect(forward).toBeEnabled();
  await focusNotifications(page);
  await tool(state, "read", { filePath: `${state.directory}/README.md` });
  await state.product("session.prompt", {
    sessionID: c.id,
    mode: "normal",
    parts: [{ kind: "text", text: "Inspect the project README" }],
  });
  const permission = page.locator(toast(c.id));
  await expect(permission).toContainText("Permission needed");
  frames.fault({
    t: "error",
    code: "fixture",
    message: "Could not read the project index",
  });
  const failure = page.locator('.otk-toast[data-kind="error"]');
  await expect(failure).toHaveCount(1);
  await state.queue(["Review complete"]);
  await page.clock.install();
  await state.product("session.prompt", {
    sessionID: b.id,
    mode: "normal",
    parts: [{ kind: "text", text: "Review the notification layout" }],
  });
  const done = page.locator(toast(b.id));
  await expect(done).toContainText("Session done");
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
  const cards = page.locator(".otk-toast");
  await expect(cards).toHaveCount(3);
  const measure = () =>
    done.evaluate((card) => {
      const box = (selector: string) =>
        card.querySelector(selector)!.getBoundingClientRect();
      const text = (selector: string) => {
        const range = document.createRange();
        range.selectNodeContents(card.querySelector(selector)!);
        return range.getBoundingClientRect();
      };
      const gaps = (outer: DOMRect, inner: DOMRect) => [
        inner.left - outer.left,
        outer.right - inner.right,
        inner.top - outer.top,
        outer.bottom - inner.bottom,
      ];
      const surface = box(".otk-surface");
      const row = box(".otk-toast-row");
      const lead = box(".otk-toast-lead");
      const x = box(".otk-toast-close");
      const title = text(".otk-toast-title");
      const name = text(".otk-toast-target");
      const target = card.querySelector(".otk-toast-target")!;
      // The title tooltip carries the entire name even where pixels are clipped.
      const visibleName = box(".otk-toast-target");
      return {
        rowHeight: row.height,
        sideDifference: Math.abs(
          lead.left - surface.left - surface.right + x.right,
        ),
        lamp: gaps(lead, box(".otk-toast-lead .otk-status-light")),
        icon: gaps(x, box(".otk-toast-close svg")),
        title: gaps(surface, title),
        name: gaps(surface, visibleName),
        nameRing: getComputedStyle(target).outlineStyle,
        namePadding: [
          name.left - visibleName.left,
          parseFloat(getComputedStyle(target).paddingInlineEnd),
          name.top - visibleName.top,
          visibleName.bottom - name.bottom,
        ],
        truncates: target.scrollWidth > target.clientWidth,
        topDifference: Math.abs(title.top - name.top),
        fitsRow: [title, visibleName].every((r) =>
          r.left >= row.left && r.right <= row.right && r.top >= row.top &&
          r.bottom <= row.bottom
        ),
      };
    });
  const dismiss = "Dismiss notification";
  const name = done.getByRole("button", {
    name: /Review the notification layout/,
  });
  const x = done.getByRole("button", { name: dismiss, exact: true });
  for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    for (const textSize of ["100", "125"]) {
      const scale = Number(textSize) / 100;
      await state.product("prefs.set", { key: "textSize", value: textSize });
      await expect.poll(() =>
        page.locator("html").evaluate((root) =>
          Number(getComputedStyle(root).getPropertyValue("--otk-scale"))
        )
      ).toBe(scale);
      const key = `toast-compact-${theme}-${textSize}`;
      await page.screenshot({
        path: info.outputPath(`${key}.png`),
        fullPage: true,
      });
      expect((await done.boundingBox())!.height).toBeLessThanOrEqual(
        54 * scale + 1,
      );
      for (const card of await cards.all()) {
        const close = card.getByRole("button", { name: dismiss, exact: true });
        await expect(close).toHaveCount(1);
        await expect(close).toHaveAttribute("title", dismiss);
        await expect(card.getByRole("button", { name: "Dismiss", exact: true }))
          .toHaveCount(0);
        await expect(card.getByRole("button", { name: "Open", exact: true }))
          .toHaveCount(0);
      }
      const metrics = await measure();
      expect(metrics.fitsRow).toBe(true);
      expect(metrics.truncates).toBe(true);
      expect(metrics.topDifference).toBeLessThanOrEqual(1);
      expect(Math.abs(metrics.rowHeight - 28 * scale)).toBeLessThanOrEqual(1);
      expect(metrics.sideDifference).toBeLessThanOrEqual(1);
      for (const gaps of [metrics.lamp, metrics.icon]) {
        expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
      }
      expect(Math.min(...metrics.title, ...metrics.name))
        .toBeGreaterThanOrEqual(12 * scale - 1);
      await expect(name).toHaveAttribute(
        "title",
        `Open ${await name.textContent()}`,
      );
      const checkInteractionPadding = async () => {
        const state = await measure();
        expect(Math.min(...state.name)).toBeGreaterThanOrEqual(12 * scale - 1);
        expect(Math.min(...state.namePadding, ...state.icon))
          .toBeGreaterThanOrEqual(4 * scale - 1);
        return state;
      };
      for (
        const [label, control] of [["name", name], ["dismiss", x]] as const
      ) {
        await control.hover();
        await done.screenshot({
          path: info.outputPath(`${key}-${label}-hover.png`),
        });
        await checkInteractionPadding();
        // Tab onto the control to show its keyboard focus ring without hover.
        await page.mouse.move(1, 1);
        if (label === "name") {
          await name.focus();
          await page.keyboard.press("Shift+Tab");
        } else await name.focus();
        await page.keyboard.press("Tab");
        await expect(control).toBeFocused();
        await done.screenshot({
          path: info.outputPath(`${key}-${label}-focus.png`),
        });
        const focus = await checkInteractionPadding();
        if (label === "name") expect(focus.nameRing).toBe("solid");
        await control.blur();
      }
      await auditUiRules(page, info, key);
    }
  }
  for (
    const [note, session, state] of [[done, b, "finished"], [
      permission,
      c,
      "blocked",
    ]] as const
  ) {
    const lamp = note.locator(".otk-toast-lead .otk-status-light");
    const sidebar = page.locator(
      `.otk-project-sessions .otk-session-row[data-session="${session.id}"] .otk-session-leading .otk-status-light`,
    );
    await expect(lamp).toHaveCount(1);
    await expect(sidebar).toHaveAttribute("data-state", state);
    await expect(lamp).toHaveAttribute(
      "data-state",
      (await sidebar.getAttribute("data-state"))!,
    );
    await expect(note.locator("[data-signal]")).toHaveCount(0);
  }
  await expect(failure.locator(".otk-surface")).toHaveAttribute(
    "data-signal",
    "error",
  );
  await expect(failure.locator(".otk-toast-lead")).toHaveCount(0);
  await name.click();
  await expect(page).toHaveURL(new RegExp(`${b.id}$`));
  await expect(done).toHaveCount(0);
});
