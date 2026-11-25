// SPDX-License-Identifier: LGPL-3.0-only
import { type Page } from "@playwright/test";
import { expect, test } from "../../fixtures/evidence.ts";
import type { TestState } from "../../fixtures/test-state.ts";
import {
  imagePreview,
  paths,
  planLink,
  replyPaths,
  shot,
  status,
  textPreview,
  transcript,
} from "../../pages/file-paths.ts";

const themes = [["otk-dark", "dark"], ["otk-light", "linen"], [
  "otk-light-stone",
  "stone",
]] as const;
const capture = process.env.OTK_FILE_PATH_SCREENSHOTS;
const setDisplay = async (
  state: TestState,
  theme: string,
  size: string,
) => {
  await state.product("prefs.set", { key: "theme", value: theme });
  await state.product("prefs.set", { key: "textSize", value: size });
};
const awaitDisplay = async (page: Page, theme: string, size: string) => {
  await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
  await expect.poll(() =>
    page.locator("html").evaluate((root) =>
      getComputedStyle(root).getPropertyValue("--otk-scale").trim()
    )
  ).toBe(String(Number(size) / 100));
};
const narrow = async (state: TestState, page: Page) => {
  await state.product("layout.patch", {
    leftCollapsed: true,
    rightCollapsed: true,
  });
  await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
    "data-collapsed",
    "true",
  );
  await expect(page.locator(".otk-right-panel")).toHaveJSProperty(
    "hidden",
    true,
  );
  await page.setViewportSize({ width: 400, height: 850 });
};

for (const [theme, label] of themes) {
  for (const scale of ["100", "125"]) {
    test(`visual.file-path-quiet-and-stable-${label}-${scale}`, {
      tag: ["@visual", "@messages"],
    }, async ({ state, page }, info) => {
      // Keep the same viewport whether or not evidence capture is requested.
      await page.setViewportSize({ width: 1280, height: 1000 });
      let release!: () => void;
      const hold = new Promise<void>((done) => release = done);
      const keys = new Set<string>();
      await page.routeWebSocket("**/api/ws", (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((message) => {
          const frame = JSON.parse(message.toString());
          if (frame.t === "request" && frame.method === "file.stat") {
            keys.add(frame.ref.key);
          }
          server.send(message);
        });
        server.onMessage(async (message) => {
          const frame = JSON.parse(message.toString());
          if (frame.t === "request.result" && keys.has(frame.ref.key)) {
            await hold;
          }
          socket.send(message);
        });
      });
      await setDisplay(state, theme, scale);
      const id = await replyPaths(
        state,
        page,
        `${transcript(state)}\n\nBinary data: \`data/blob.bin\`.`,
      );
      await awaitDisplay(page, theme, scale);
      await expect(status(page, id)).toHaveAttribute("data-status", "idle");
      await expect.poll(() => keys.size).toBeGreaterThan(0);
      await page.evaluate(() => document.fonts.ready.then(() => {}));
      const paragraphs = page.locator(
        '[data-role="assistant"] .otk-prose-paragraph',
      );
      await expect(paragraphs).toHaveCount(3);
      const boxes = () =>
        paragraphs.evaluateAll((nodes) =>
          nodes.map((n) => {
            const { left, top, width, height } = n.getBoundingClientRect();
            return [left, top, width, height];
          })
        );
      const before = await boxes();
      await expect(paths(page)).toHaveCount(0);
      release();
      await expect(paths(page)).toHaveCount(4);
      const after = await boxes();
      expect(after).toHaveLength(before.length);
      for (const [index, box] of after.entries()) {
        for (const [axis, value] of box.entries()) {
          expect(
            Math.abs(value - before[index][axis]),
            JSON.stringify({ before, after, index, axis }),
          ).toBeLessThanOrEqual(.5);
        }
      }
      for (
        const target of [
          page.getByRole("button", { name: shot(state), exact: true }),
          planLink(page),
        ]
      ) {
        const appearance = await target.evaluate((node) => ({
          actual: getComputedStyle(node).color,
          expected:
            getComputedStyle(node.querySelector("code") ?? node.parentElement!)
              .color,
          line: getComputedStyle(node).textDecorationStyle,
        }));
        expect(appearance.actual).toBe(appearance.expected);
        expect(appearance.line).toBe("dotted");
      }
      const save = async (kind: string) => {
        await page.screenshot({
          path: `${capture}/${kind}-${label}.png`,
          fullPage: true,
          animations: "disabled",
        });
        await info.attach(`${kind}-${label}`, {
          path: `${capture}/${kind}-${label}.png`,
          contentType: "image/png",
        });
      };
      const saving = !!capture && scale === "125";
      if (saving) await save("link");
      const prose = page.getByRole("button", {
        name: shot(state),
        exact: true,
      });
      await prose.hover();
      await expect(prose).toHaveCSS("text-decoration-style", "solid");
      if (saving) {
        await save("hover");
        await prose.focus();
        await page.keyboard.press("Tab");
        await expect(planLink(page)).toBeFocused();
        await save("focus");
        await page.getByRole("button", { name: "data/blob.bin", exact: true })
          .click();
        const menu = page.getByRole("menu", { name: "Context menu" });
        await expect(menu.getByRole("menuitem", { name: "Copy path" }))
          .toBeVisible();
        await save("menu");
        await page.keyboard.press("Escape");
        const text = await textPreview(page);
        await expect(text.locator(".otk-code-number.is-marked")).toHaveCount(2);
        await save("text-preview");
        await page.keyboard.press("Escape");
        const image = await imagePreview(state, page);
        await expect.poll(() =>
          image.locator("img").evaluate((img: HTMLImageElement) =>
            img.naturalWidth
          )
        ).toBeGreaterThan(0);
        await save("image-preview");
      }
    });
  }
}

test(
  "visual.file-path-wraps-inline",
  { tag: ["@visual", "@messages"] },
  async ({ state, page }) => {
    await replyPaths(state, page, undefined, () => narrow(state, page));
    const link = page.getByRole("button", { name: shot(state), exact: true });
    await expect(link).toBeVisible();
    const { fragments, first, preceding } = await link.evaluate((node) => {
      const range = document.createRange();
      let text = node.previousSibling!;
      while (
        text && (text.nodeType !== Node.TEXT_NODE || !text.textContent?.trim())
      ) text = text.previousSibling!;
      range.selectNodeContents(text);
      const rects = node.getClientRects();
      return {
        fragments: rects.length,
        first: rects[0].top,
        preceding: range.getBoundingClientRect().top,
      };
    });
    expect(fragments).toBeGreaterThanOrEqual(2);
    expect(Math.abs(first - preceding)).toBeLessThanOrEqual(1);
  },
);

test(
  "visual.file-path-preview-labels",
  { tag: ["@visual", "@messages"] },
  async ({ state, page }) => {
    await replyPaths(state, page, undefined, () => narrow(state, page));
    const dialog = await textPreview(page);
    for (const name of ["plan.md", "Copy path", "Open folder in terminal"]) {
      const target = dialog.getByRole(
        name === "plan.md" ? "heading" : "button",
        { name, exact: true },
      );
      expect(
        await target.evaluate((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          return range.getClientRects().length;
        }),
      ).toBe(1);
    }
  },
);
