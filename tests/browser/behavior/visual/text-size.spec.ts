// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession } from "../../fixtures/wire.ts";
import { independentPage } from "../../pages/visual.ts";
import {
  openWorkLogs,
  prompt,
  revealAcquired,
  toolScript,
} from "../../pages/transcript.ts";
import { isolatedTest as toolTest } from "../../fixtures/isolated.ts";

test("visual.text-size-live-geometry-broadcast-and-reload", {
  tag: ["@visual", "@messages", "@sessions", "@text-size"],
}, async ({ state, page, browser }, info) => {
  const layout = (await state.product("prefs.get", {})).shellLayout;
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Text size and measured layout",
  });
  await state.queue([
    "## Proportional text\n\n" +
    "A measured transcript keeps the latest response in view as text grows.\n\n"
      .repeat(45) +
    "The final line remains visible.",
  ]);
  await state.native(`/session/${session.id}/prompt_async`, "POST", {
    parts: [{ type: "text", text: "Explain proportional text and spacing." }],
  });
  await openSession(state, page, session.id);
  const pane = page.getByRole("region", { name: "Transcript", exact: true });
  await expect(pane).toContainText("The final line remains visible.");
  const { page: settings, errors } = await independentPage(state, browser);
  await settings.goto(state.url);
  await settings.locator(".otk-settings-entry").click();
  const sizes = settings.getByRole("group", { name: "Text size", exact: true });
  await expect(sizes.getByRole("button", { pressed: true })).toHaveText("100%");
  await expect(sizes.locator("select, input[type=range]")).toHaveCount(0);
  const rootScale = (p: typeof page) =>
    p.locator("html").evaluate((element) =>
      Number(getComputedStyle(element).getPropertyValue("--otk-scale"))
    );
  const geometry = () =>
    pane.evaluate((element) => {
      const track = element.parentElement!.querySelector<HTMLElement>(
        ".otk-scroll-track-y",
      )!;
      const thumb = track.firstElementChild!.getBoundingClientRect();
      const input = document.querySelector<HTMLTextAreaElement>(
        "textarea[name=prompt]",
      )!;
      return {
        distance: Math.abs(
          element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
        thumbError: Math.abs(
          thumb.height -
            track.clientHeight * element.clientHeight / element.scrollHeight,
        ),
        inputHeight: input.getBoundingClientRect().height,
        lineHeight: parseFloat(getComputedStyle(input).lineHeight),
        rowHeights: Array.from(
          element.querySelectorAll<HTMLElement>(".otk-virtual-item"),
        ).map((row) => row.getBoundingClientRect().height),
      };
    });
  for (const size of [90, 100, 110, 125, 150]) {
    await sizes.getByRole("button", { name: `${size}%`, exact: true }).click();
    for (const p of [page, settings]) {
      await expect.poll(() => rootScale(p)).toBe(size / 100);
    }
    await expect(sizes.getByRole("button", { pressed: true })).toHaveText(
      `${size}%`,
    );
    const checkbox = await settings.locator("input[name=reducedColors]")
      .boundingBox();
    expect(checkbox!.width).toBeCloseTo(13 * size / 100, 1);
    expect(checkbox!.height).toBeCloseTo(13 * size / 100, 1);
    const avatar =
      (await page.locator(".otk-project-chip .otk-project-avatar").first()
        .boundingBox())!;
    expect(avatar.width).toBeCloseTo(18 * size / 100, 1);
    expect(avatar.height).toBeCloseTo(18 * size / 100, 1);
    const heading =
      (await settings.locator(".otk-view-header h1").boundingBox())!;
    const appearance =
      (await settings.getByRole("heading", { name: "Appearance", exact: true })
        .boundingBox())!;
    expect(Math.abs(heading.x - appearance.x)).toBeLessThanOrEqual(1);
    await expect.poll(async () => (await geometry()).distance)
      .toBeLessThanOrEqual(2);
    const following = await pane.evaluate(async (element) => {
      const distances: number[] = [];
      for (let frame = 0; frame < 12; frame++) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve())
        );
        distances.push(
          Math.abs(
            element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        );
      }
      return distances;
    });
    expect(Math.max(...following)).toBeLessThanOrEqual(2);
    await expect.poll(async () => (await geometry()).thumbError)
      .toBeLessThanOrEqual(1);
    const measured = await geometry();
    expect(measured.rowHeights.some((height) => height > 0)).toBe(true);
    expect(measured.inputHeight).toBeGreaterThanOrEqual(48 * size / 100 - 1);
    expect(measured.lineHeight).toBeCloseTo(24 * size / 100, 1);
    await page.locator(".otk-display-menu > button").click();
    const popover = page.locator(".otk-popover-panel:popover-open");
    await expect(popover).toBeVisible();
    const box = (await popover.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    await page.keyboard.press("Escape");
  }
  expect((await state.product("prefs.get", {})).textSize).toBe("150");
  await page.reload();
  await expect.poll(() => rootScale(page)).toBe(1.5);
  await expect(pane).toContainText("The final line remains visible.");
  await expect.poll(async () => (await geometry()).distance)
    .toBeLessThanOrEqual(2);
  for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(settings.locator("html")).toHaveAttribute(
      "data-otk-theme",
      theme,
    );
    for (const size of [100, 150]) {
      await sizes.getByRole("button", { name: `${size}%`, exact: true })
        .click();
      await expect.poll(() => rootScale(settings)).toBe(size / 100);
      await expect.poll(() => rootScale(page)).toBe(size / 100);
      await settings.screenshot({
        path: info.outputPath(`text-size-${theme}-${size}.png`),
        fullPage: true,
      });
      await page.screenshot({
        path: info.outputPath(`text-size-transcript-${theme}-${size}.png`),
        fullPage: true,
      });
    }
    // The existing compact rails are the 600px workspace: two expanded
    // persisted side columns alone otherwise consume almost the full viewport.
    await state.product("layout.patch", {
      leftCollapsed: true,
      rightCollapsed: true,
    });
    for (const p of [page, settings]) {
      await expect(p.locator(".otk-sidebar-rail").first()).toHaveAttribute(
        "data-collapsed",
        "true",
      );
      await expect(p.locator(".otk-right-rail")).toBeVisible();
    }
    await settings.setViewportSize({ width: 600, height: 800 });
    await page.setViewportSize({ width: 600, height: 800 });
    const wrapping = await settings.locator(
      ".otk-settings .otk-control-label, .otk-preference-segments button",
    ).evaluateAll((elements) =>
      elements.filter((element) => {
        const style = getComputedStyle(element);
        return style.whiteSpace !== "nowrap";
      }).map((element) => element.textContent)
    );
    expect(wrapping).toEqual([]);
    const choices = await sizes.getByRole("button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          width: button.clientWidth,
          content: button.scrollWidth,
        };
      })
    );
    for (const choice of choices) {
      expect(choice.left).toBeGreaterThanOrEqual(0);
      expect(choice.right).toBeLessThanOrEqual(600);
      expect(choice.content).toBeLessThanOrEqual(choice.width);
    }
    await page.locator(".otk-display-menu > button").click();
    const narrowPopover = page.locator(".otk-popover-panel:popover-open");
    await expect(narrowPopover).toBeVisible();
    const narrowBox = (await narrowPopover.boundingBox())!;
    expect(narrowBox.x).toBeGreaterThanOrEqual(0);
    expect(narrowBox.x + narrowBox.width).toBeLessThanOrEqual(601);
    expect(narrowBox.y).toBeGreaterThanOrEqual(0);
    expect(narrowBox.y + narrowBox.height).toBeLessThanOrEqual(801);
    await page.keyboard.press("Escape");
    await settings.screenshot({
      path: info.outputPath(`text-size-narrow-${theme}-150.png`),
      fullPage: true,
    });
    await page.screenshot({
      path: info.outputPath(`text-size-transcript-narrow-${theme}-150.png`),
      fullPage: true,
    });
    await settings.setViewportSize({ width: 1280, height: 800 });
    await page.setViewportSize({ width: 1280, height: 800 });
    await state.product("layout.patch", {
      leftCollapsed: layout.leftCollapsed,
      rightCollapsed: layout.rightCollapsed,
    });
  }
  expect(errors).toEqual([]);
});

toolTest.use({ profile: "messages-forms" });
toolTest("visual.text-size-native-tool-control-geometry", {
  tag: ["@visual", "@messages", "@text-size"],
}, async ({ isolatedState: state, page, browser }) => {
  await state.product("prefs.set", { key: "expandWork", value: true });
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Scaled native tool controls",
  });
  await openSession(state, page, session.id);
  await toolScript(state, "bash", {
    command: "exit 7",
    description: "Measured failing tool",
  });
  await prompt(page, "Run the measured tool");
  const row = page.locator("[data-tool=bash]");
  await expect(page.locator(".otk-message-flow")).toContainText(
    "Tool finished.",
  );
  await openWorkLogs(page);
  await revealAcquired(page, "[data-tool=bash] .otk-tool-toggle");
  const { page: settings, errors } = await independentPage(state, browser);
  await settings.goto(state.url);
  await settings.locator(".otk-settings-entry").click();
  const sizes = settings.getByRole("group", { name: "Text size", exact: true });
  for (const size of [90, 100, 110, 125, 150]) {
    await sizes.getByRole("button", { name: `${size}%`, exact: true }).click();
    await expect.poll(() =>
      page.locator("html").evaluate((element) =>
        Number(getComputedStyle(element).getPropertyValue("--otk-scale"))
      )
    ).toBe(size / 100);
    await revealAcquired(page, "[data-tool=bash] .otk-tool-toggle");
    const tool = (await row.locator(".otk-tool-toggle").boundingBox())!;
    expect(tool.height).toBeGreaterThanOrEqual(26 * size / 100 - 1);
    const icon = (await row.locator(".otk-tool-icon svg").boundingBox())!;
    expect(icon.width).toBeCloseTo(13 * size / 100, 1);
    expect(icon.height).toBeCloseTo(13 * size / 100, 1);
  }
  expect(errors).toEqual([]);
});
