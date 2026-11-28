// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";

const path =
  "/var/lib/export/TransferArtifactManifestChecksumValidationSnapshotRef/report.json";
const reply = [
  "## Transfer checklist",
  "",
  "| Step | Details | Output |",
  "| --- | --- | --- |",
  `| Transfer and Blacksmith | Use the native transfer to keep history, releases, and redirects. Verify the new repository, then grant the Blacksmith GitHub App access. | \`${path}\` |`,
  "",
  "Verify the destination before publishing.",
].join("\n");

test.use({ profile: "revert-native" });

test("visual.markdown-tables-wrap-words-and-scroll-in-the-reply", {
  tag: ["@visual", "@messages"],
}, async ({ isolatedState: state, page, context }) => {
  await state.product("prefs.set", { key: "animationsOff", value: true });
  const { id } = await state.native<{ id: string }>("/session", "POST", {
    title: "Project status review",
  });
  await openSession(state, page, id);
  await state.product("layout.patch", {
    leftCollapsed: false,
    rightCollapsed: true,
  });
  await state.queue([reply]);
  await prompt(page, "Show the transfer checklist and output path.");
  const message = page.locator('.otk-message[data-role="assistant"]').filter({
    hasText: "Verify the destination before publishing.",
  });
  const table = message.getByRole("table");
  const port = message.locator(".otk-table-scroll");
  const bar = message.getByRole("scrollbar", { name: "Horizontal scroll" });
  await expect(table.getByRole("columnheader")).toHaveCount(3);
  await expect(table.getByRole("cell").last()).toHaveText(path);

  const cdp = await context.newCDPSession(page);
  for (
    const [physicalWidth, zoom, textSize, needsScroll] of [
      [1280, 1, "100", false],
      [900, 1.25, "125", true],
      [1280, 1.5, "125", true],
      [1440, 2, "125", true],
      [1280, 1, "100", false],
    ] as const
  ) {
    await test.step(`${physicalWidth} wide at ${zoom * 100}% zoom, text ${textSize}%`, async () => {
      const width = Math.round(physicalWidth / zoom);
      const height = Math.round(1500 / zoom);
      await page.setViewportSize({ width, height });
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: zoom,
        mobile: false,
      });
      await state.product("prefs.set", { key: "textSize", value: textSize });
      await expect.poll(() =>
        page.evaluate(() => [
          innerWidth,
          devicePixelRatio,
          getComputedStyle(document.documentElement).getPropertyValue(
            "--otk-scale",
          ).trim(),
        ])
      ).toEqual([width, zoom, String(Number(textSize) / 100)]);
      await page.evaluate(() => document.fonts.ready);
      await port.scrollIntoViewIfNeeded();
      const splitWords = await table.evaluate((element) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        const split: string[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          // A path can wrap between components, never within a word.
          for (const word of node.textContent!.matchAll(/[A-Za-z0-9_]+/g)) {
            range.setStart(node, word.index!);
            range.setEnd(node, word.index! + word[0].length);
            const lines = new Set(
              Array.from(range.getClientRects(), (rect) => rect.top),
            );
            if (lines.size > 1) split.push(word[0]);
          }
        }
        return split;
      });
      expect.soft(splitWords, "words occupy one line each").toEqual([]);
      expect.soft(
        await message.evaluate((element) => [
          document.documentElement.scrollWidth - innerWidth,
          element.scrollWidth - element.clientWidth,
        ]),
        "neither the page nor the reply overflows",
      ).toEqual([0, 0]);

      const extent = await port.evaluate((node) =>
        node.scrollWidth - node.clientWidth
      );
      expect.soft(extent > 0, `table overflow: ${extent}`).toBe(needsScroll);
      if (extent > 0 && needsScroll) {
        await expect.soft(bar).toBeVisible();
        const thumb = await bar.locator(".otk-scroll-thumb").boundingBox();
        const tableBox = (await table.boundingBox())!;
        if (thumb) {
          expect.soft(thumb.y, "thumb has breathing room below the cells")
            .toBeGreaterThan(tableBox.y + tableBox.height);
          expect.soft(
            await bar.evaluate((node) => getComputedStyle(node).opacity),
          )
            .toBe("1");
        }
      } else if (!needsScroll) {
        await expect.soft(bar).toBeHidden();
      }

      const capture = process.env.OTK_MARKDOWN_TABLE_SCREENSHOTS;
      if (capture && zoom === 1.5) {
        for (
          const [theme, name] of [
            ["otk-dark", "dark"],
            ["otk-light", "linen"],
            ["otk-light-stone", "stone"],
          ]
        ) {
          await state.product("prefs.set", { key: "theme", value: theme });
          await expect(page.locator("html")).toHaveAttribute(
            "data-otk-theme",
            theme,
          );
          await page.screenshot({ path: `${capture}/${name}.png` });
        }
      }

      if (extent > 0 && needsScroll) {
        const end = await port.evaluate((node) => {
          node.scrollLeft = node.scrollWidth;
          const maximum = node.scrollWidth - node.clientWidth;
          const position = node.scrollLeft;
          node.scrollLeft = 0;
          return { maximum, position };
        });
        expect.soft(end.position).toBeGreaterThan(0);
        expect.soft(Math.abs(end.maximum - end.position)).toBeLessThanOrEqual(
          1,
        );
      }
    });
  }
});
