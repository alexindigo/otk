// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { seed, tool } from "../../pages/attention.ts";
import { prompt } from "../../pages/composer.ts";
import { cssLength } from "../../pages/css-length.ts";
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
  const cards = page.locator(".otk-toast");
  const stage = page.locator(".otk-transcript-stage");
  const dock = page.locator(".otk-composer-dock");
  const assertBottom = async (key: string, count: number) => {
    await expect(cards).toHaveCount(count);
    const gutter = await cssLength(stage, "--overlay-gutter");
    const geometry = await stage.evaluate((element) => {
      const box = (el: Element) => el.getBoundingClientRect();
      const stack = element.querySelector(".otk-toasts")!;
      return {
        stage: box(element).bottom,
        dock: box(element.parentElement!.querySelector(".otk-composer-dock")!)
          .top,
        transcript: box(element.querySelector('[aria-label="Transcript"]')!)
          .bottom,
        toast: box(Array.from(stack.querySelectorAll(".otk-toast")).at(-1)!)
          .bottom,
        stack: box(stack).toJSON(),
        parent: box(stack.parentElement!).toJSON(),
      };
    });
    const label = `${key}: ${JSON.stringify({ ...geometry, gutter })}`;
    expect.soft(Math.abs(geometry.stage - geometry.dock), label)
      .toBeLessThanOrEqual(0.5);
    expect.soft(Math.abs(geometry.stage - geometry.transcript), label)
      .toBeLessThanOrEqual(0.5);
    expect.soft(Math.abs(geometry.stage - gutter - geometry.toast), label)
      .toBeLessThanOrEqual(0.5);
  };
  await assertBottom("one toast", 1);
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
  await expect(cards).toHaveCount(3);
  const assertAboveDock = async (key: string) => {
    await expect(cards).toHaveCount(3);
    await expect(dock).toBeVisible();
    const dockBox = (await dock.boundingBox())!;
    for (const [index, card] of (await cards.all()).entries()) {
      await expect(card).toBeInViewport({ ratio: 1 });
      const cardBox = (await card.boundingBox())!;
      expect.soft(
        cardBox.y + cardBox.height,
        `${key}: toast ${index + 1} must end above the entire composer dock`,
      ).toBeLessThanOrEqual(dockBox.y);
    }
  };
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
      await assertAboveDock(key);
      await assertBottom(key, 3);
      await page.screenshot({
        path: info.outputPath(`${key}.png`),
        fullPage: true,
      });
      if (textSize === "125") {
        const empty = (await dock.boundingBox())!.height;
        await prompt(page).fill(
          "First line\nSecond line\nThird line\nFourth line",
        );
        await expect.poll(async () => (await dock.boundingBox())!.height)
          .toBeGreaterThan(empty);
        await assertBottom(`${key} with a multiline draft`, 3);
        await page.screenshot({
          path: info.outputPath(`${key}-grown.png`),
          fullPage: true,
        });
        await prompt(page).fill("");
        await expect.poll(async () => (await dock.boundingBox())!.height).toBe(
          empty,
        );
      }
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
  await state.product("prefs.set", { key: "textSize", value: "100" });
  await expect.poll(() =>
    page.locator("html").evaluate((root) =>
      Number(getComputedStyle(root).getPropertyValue("--otk-scale"))
    )
  ).toBe(1);
  const viewport = page.viewportSize()!;
  const cdp = await page.context().newCDPSession(page);
  try {
    for (const zoom of [1, 1.25]) {
      // Match desktop zoom: fewer CSS pixels at the same physical size.
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 1000 / zoom,
        height: 900 / zoom,
        deviceScaleFactor: zoom,
        mobile: false,
      });
      await expect.poll(() =>
        page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio])
      ).toEqual([1000 / zoom, 900 / zoom, zoom]);
      await assertAboveDock(`browser zoom ${zoom * 100}%`);
      await assertBottom(`browser zoom ${zoom * 100}%`, 3);
    }
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await cdp.detach();
    await page.setViewportSize({ ...viewport, width: viewport.width + 1 });
    await page.setViewportSize(viewport);
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
      `.otk-project-sessions .otk-session-row[data-session="${session.id}"] .otk-sidebar-lamp .otk-status-light`,
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

test("attention.toast-hover-and-focus-hold-one-expiry", {
  tag: ["@attention", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const current = await seed(state, "Current conversation");
  const background = await seed(state, "Background conversation");
  await openSession(state, page, current.id);
  await focusNotifications(page);
  await page.clock.install();
  await state.queue(["Review complete"]);
  await state.product("session.prompt", {
    sessionID: background.id,
    mode: "normal",
    parts: [{ kind: "text", text: "Complete a background review" }],
  });
  const note = page.locator(toast(background.id));
  const name = note.getByRole("button", {
    name: "Background conversation",
    exact: true,
  });
  const close = note.getByRole("button", {
    name: "Dismiss notification",
    exact: true,
  });
  await expect(note).toContainText("Session done");
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
  await name.hover();
  await page.clock.fastForward(7000);
  await expect(note).toBeVisible();
  await name.focus();
  await page.mouse.move(1, 1);
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.clock.fastForward(7000);
  await expect(note).toBeVisible();
  await close.blur();
  await page.clock.fastForward(5999);
  await expect(note).toBeVisible();
  await page.clock.fastForward(1);
  await expect(note).toHaveCount(0);
});
