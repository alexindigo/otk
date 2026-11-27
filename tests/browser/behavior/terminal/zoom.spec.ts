// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { cleanup, observe, open, viewport } from "../../pages/terminal.ts";

test("terminal.cells-follow-app-type-and-fit-the-live-pty-at-browser-zoom", {
  tag: "@terminal",
}, async ({ context, page, state }) => {
  // Measure the real cell rectangles drawn for an ANSI background stencil.
  // The probe neither changes canvas output nor reads the renderer's state.
  const ink = "#c11ef3";
  await page.addInitScript((ink) => {
    const prototype = CanvasRenderingContext2D.prototype;
    const paint = prototype.fillRect;
    const marks = new Map<
      number,
      { left: number; width: number; end: number }
    >();
    Reflect.set(globalThis, "terminalZoomMarks", marks);
    prototype.fillRect = function (left, top, width, height) {
      if (this.canvas.classList.contains("otk-ghostty-canvas")) {
        if (
          left === 0 && top === 0 && width === this.canvas.width &&
          height === this.canvas.height
        ) marks.clear();
        if (this.fillStyle === ink) {
          marks.set(top, { left, width, end: top + height });
        }
      }
      paint.call(this, left, top, width, height);
    };
  }, ink);
  const wire = observe(page);
  const cdp = await context.newCDPSession(page);
  const session = await open(state, page, "Terminal typography");
  const stencilRows = 4;
  const stencil = "\\033[48;2;193;30;243m  \\033[0m\\n".repeat(stencilRows);
  const input = page.getByRole("textbox", {
    name: "Terminal input",
    exact: true,
  });
  try {
    let baseline = 0;
    for (
      const [zoom, textSize] of [
        [1, "100"],
        [1, "125"],
        [1.5, "125"],
        [2, "125"],
      ] as const
    ) {
      await test.step(`${textSize}% app text at ${zoom * 100}% browser zoom`, async () => {
        const size = {
          width: Math.round(1800 / zoom),
          height: Math.round(1680 / zoom),
        };
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          ...size,
          deviceScaleFactor: zoom,
          mobile: false,
        });
        await state.product("prefs.set", { key: "textSize", value: textSize });
        await expect.poll(() =>
          page.evaluate(() => ({
            scale: getComputedStyle(document.documentElement).getPropertyValue(
              "--otk-scale",
            ).trim(),
            dpr: devicePixelRatio,
            width: innerWidth,
            height: innerHeight,
          }))
        ).toEqual({
          scale: String(Number(textSize) / 100),
          dpr: zoom,
          ...size,
        });
        await page.evaluate(() =>
          Reflect.get(globalThis, "terminalZoomMarks").clear()
        );
        await input.focus();
        await page.keyboard.insertText(
          `PS1='> '; printf '\\033[3J\\033[2J\\033[H${stencil}'`,
        );
        await input.press("Enter");
        const measure = () =>
          viewport(page).evaluate((canvas: HTMLCanvasElement, stencilRows) => {
            const marks = Array.from(
              (Reflect.get(globalThis, "terminalZoomMarks") as Map<
                number,
                { left: number; width: number; end: number }
              >).entries(),
            ).sort(([a], [b]) => a - b);
            if (marks.length !== stencilRows) return null;
            const [top, { left, width }] = marks[0];
            const cellHeight = (marks.at(-1)![1].end - top) / marks.length;
            const usableWidth = canvas.clientWidth - 2 * left;
            const usableHeight = canvas.clientHeight - 2 * left;
            return {
              cellHeight: cellHeight * devicePixelRatio,
              lineHeight:
                parseFloat(getComputedStyle(document.body).lineHeight) *
                devicePixelRatio,
              usableHeight,
              rowHeight: cellHeight,
              cols: Math.floor(usableWidth / (width / 2)),
              backing: { width: canvas.width, height: canvas.height },
              expectedBacking: {
                width: Math.round(canvas.clientWidth * devicePixelRatio),
                height: Math.round(canvas.clientHeight * devicePixelRatio),
              },
              transform: canvas.getContext("2d")!.getTransform().a,
            };
          }, stencilRows);
        await expect.poll(async () => (await measure())?.transform, {
          message: `painted cell stencil at ${zoom}x and ${textSize}%`,
        }).toBe(zoom);
        const metrics = (await measure())!;
        expect(metrics.backing).toEqual(metrics.expectedBacking);
        expect(metrics.transform).toBe(zoom);
        const fraction = metrics.cellHeight / metrics.lineHeight;
        if (textSize === "100") baseline = fraction;
        expect.soft(
          fraction,
          `cell height / body line height at ${zoom}x and ${textSize}%`,
        )
          .toBeCloseTo(baseline, 2);
        await expect.poll(() => wire.grids.at(-1)?.cols).toBe(metrics.cols);
        // The stencil's row edges snap to device pixels; allow that observed
        // measurement error across the whole grid, not an extra row of slack.
        const rows = wire.grids.at(-1)!.rows;
        const edgeError = (rows + 1) / (stencilRows * zoom);
        expect(rows * metrics.rowHeight).toBeLessThanOrEqual(
          metrics.usableHeight + edgeError,
        );
        expect((rows + 1) * metrics.rowHeight).toBeGreaterThan(
          metrics.usableHeight - edgeError,
        );
      });
    }
  } finally {
    await cleanup(state, session);
  }
});
