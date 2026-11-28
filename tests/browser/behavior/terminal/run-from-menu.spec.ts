// SPDX-License-Identifier: LGPL-3.0-only
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../../fixtures/evidence.ts";
import type { TestState } from "../../fixtures/test-state.ts";
import { openSession } from "../../fixtures/wire.ts";
import { cleanup, observe, tabs, text } from "../../pages/terminal.ts";
import { prompt } from "../../pages/transcript.ts";

const area = { tag: "@terminal" };
const command = (word: string) => `printf 'otk-%s\\n' ${word}`;
const inline = (value: string) => `\`${value}\``;
const span = (page: Page, value: string) =>
  page.getByText(value, { exact: true }).and(page.locator(".otk-prose-code"));
const pending = (page: Page) =>
  page.getByRole("group", { name: "Pasted command" });
const run = (page: Page) =>
  pending(page).getByRole("button", { name: "Run", exact: true });
const cancel = (page: Page) =>
  pending(page).getByRole("button", { name: "Cancel", exact: true });
const terminalInput = (page: Page) =>
  page.getByRole("textbox", { name: "Terminal input", exact: true });
const terminalMenuItem = (page: Page) =>
  page.getByRole("menuitem", { name: /^Run in terminal: / });

async function withReply(
  state: TestState,
  page: Page,
  source: string,
  check: () => Promise<void>,
) {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { id } = await state.native<{ id: string }>("/session", "POST", {
    title: "Run from reply menu",
  });
  await openSession(state, page, id);
  try {
    await state.queue([source]);
    await prompt(page, "Show sample terminal commands");
    await check();
  } finally {
    await cleanup(state, id);
  }
}

async function selectContents(locator: Locator) {
  await locator.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

async function pasteInline(page: Page, value: string) {
  await span(page, value).click({ button: "right" });
  const item = terminalMenuItem(page);
  await expect(item).toHaveCount(1);
  await expect(item).toHaveAccessibleName(`Run in terminal: ${value}`);
  await item.click();
  await expect(pending(page)).toContainText(value);
  await expect.poll(() => text(page)).toContain(value);
}

test(
  "terminal.run-from-menu.inline-code-run",
  area,
  async ({ state, page }) => {
    const value = command("menu-a");
    const wire = observe(page);
    await withReply(
      state,
      page,
      `Start it with ${inline(value)} now.`,
      async () => {
        await expect(tabs(page)).toHaveCount(0);
        await pasteInline(page, value);
        await expect(tabs(page)).toHaveCount(1);
        expect(await text(page)).not.toContain("otk-menu-a");
        expect(wire.input.join("")).not.toContain("\r");
        await expect(run(page)).toBeFocused();
        await run(page).click();
        await expect.poll(() => text(page)).toContain("otk-menu-a");
        await expect(pending(page)).toHaveCount(0);
      },
    );
  },
);

test(
  "terminal.run-from-menu.selection-wins-then-cancel",
  area,
  async ({ state, page }) => {
    const selected = command("sel-b"), code = command("span-c");
    const paragraph = `Try ${selected} with ${code} too.`;
    await withReply(
      state,
      page,
      `Try ${selected} with ${inline(code)} too.`,
      async () => {
        await selectContents(
          page.locator("p").filter({ has: span(page, code) }),
        );
        await span(page, code).click({ button: "right" });
        const item = terminalMenuItem(page);
        await expect(item).toHaveCount(1);
        await expect(item).toHaveAccessibleName(/^Run in terminal: Try printf/);
        await item.click();
        await expect(pending(page)).toContainText(paragraph);
        await expect.poll(() => text(page)).toContain("sel-b");
        await cancel(page).click();
        await expect(pending(page)).toHaveCount(0);
        await expect.poll(() => text(page)).not.toMatch(/sel-b|span-c/);
        await terminalInput(page).focus();
        await page.keyboard.type(command("after-c"));
        await page.keyboard.press("Enter");
        await expect.poll(() => text(page)).toContain("otk-after-c");
        expect(await text(page)).not.toContain("command not found");
      },
    );
  },
);

test("terminal.run-from-menu.escape-cancels", area, async ({ state, page }) => {
  const value = command("menu-c");
  await withReply(state, page, inline(value), async () => {
    await pasteInline(page, value);
    await expect(run(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(pending(page)).toHaveCount(0);
    await expect.poll(() => text(page)).not.toContain(value);
    await expect(tabs(page)).toHaveCount(1);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

test(
  "terminal.run-from-menu.typing-releases",
  area,
  async ({ state, page }) => {
    const value = command("menu-d");
    await withReply(state, page, inline(value), async () => {
      await pasteInline(page, value);
      await terminalInput(page).focus();
      await page.keyboard.type(" #x");
      await expect(pending(page)).toHaveCount(0);
      await expect.poll(() => text(page)).toContain(`${value} #x`);
      await page.keyboard.press("Enter");
      await expect.poll(() => text(page)).toContain("otk-menu-d");
    });
  },
);

test(
  "terminal.run-from-menu.second-paste-replaces",
  area,
  async ({ state, page }) => {
    const first = command("menu-e"), second = command("menu-f");
    await withReply(
      state,
      page,
      `Use ${inline(first)} or ${inline(second)}.`,
      async () => {
        await pasteInline(page, first);
        await pasteInline(page, second);
        await expect.poll(() => text(page)).not.toContain("menu-e");
        await expect(pending(page)).not.toContainText("menu-e");
      },
    );
  },
);

test(
  "terminal.run-from-menu.hidden-without-text",
  area,
  async ({ state, page }) => {
    const prose = "Ordinary reply prose without runnable text.";
    await withReply(state, page, prose, async () => {
      await page.getByText(prose, { exact: true }).click({ button: "right" });
      await expect(
        page.getByRole("menuitem", { name: "Copy reply", exact: true }),
      ).toBeVisible();
      await expect(terminalMenuItem(page)).toHaveCount(0);
    });
  },
);

test(
  "terminal.run-from-menu.hide-keeps-pending",
  area,
  async ({ state, page }) => {
    const value = command("menu-g");
    await withReply(state, page, inline(value), async () => {
      await pasteInline(page, value);
      await page.getByRole("region", { name: "Terminal", exact: true })
        .getByRole("button", { name: "Hide terminal", exact: true })
        .click();
      await expect(pending(page)).toHaveCount(0);
      await page.getByRole("form", { name: "Composer", exact: true })
        .getByRole("button", { name: "Open terminal", exact: true })
        .click();
      await expect(pending(page)).toContainText(value);
      await expect(run(page)).toBeEnabled();
      await run(page).click();
      await expect.poll(() => text(page)).toContain("otk-menu-g");
    });
  },
);

const capture = process.env.OTK_RUN_MENU_SCREENSHOTS;
if (capture) {
  test("terminal.run-from-menu.screenshots", area, async ({ state, page }) => {
    const single = "./run-guest-test --interactive";
    const lines = ["cd tests/guest", "./run-guest-test --interactive --keep"];
    const multi = lines.join("\n");
    const themes = [
      ["otk-dark", "dark"],
      ["otk-light", "linen"],
      ["otk-light-stone", "stone"],
    ];
    const themeEach = async (check: (label: string) => Promise<void>) => {
      for (const [theme, label] of themes) {
        await state.product("prefs.set", { key: "theme", value: theme });
        await expect(page.locator("html")).toHaveAttribute(
          "data-otk-theme",
          theme,
        );
        await check(label);
      }
    };
    const shot = (kind: string, theme: string) =>
      page.screenshot({
        path: `${capture}/${kind}-${theme}.png`,
        animations: "disabled",
        fullPage: true,
      });
    const checkFooter = async () => {
      const icon = await run(page).locator("svg").boundingBox();
      expect(icon?.width).toBeGreaterThan(0);
      expect(icon?.height).toBeGreaterThan(0);
      const geometry = await pending(page).evaluate((row) => {
        const elements = Array.from(
          row.querySelectorAll<HTMLElement>("button, code"),
        );
        const center = (element: Element) => {
          const { top, height } = element.getBoundingClientRect();
          return top + height / 2;
        };
        return elements.map((element) => {
          const inner = document.createRange();
          inner.selectNodeContents(element);
          const contents = element.matches("code")
            ? [inner.getBoundingClientRect()]
            : Array.from(
              element.children,
              (child) => child.getBoundingClientRect(),
            );
          const outer = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            offset: Math.abs(center(row) - center(element)),
            left: Math.min(...contents.map(({ left }) => left)) - outer.left,
            right: outer.right -
              Math.max(...contents.map(({ right }) => right)),
            padding: parseFloat(style.paddingInlineStart),
            whole: Array.from(element.querySelectorAll(".otk-control-label"))
              .every(
                (label) => label.scrollWidth <= label.clientWidth,
              ),
            outline: style.outlineStyle,
          };
        });
      });
      expect(geometry).toHaveLength(3);
      const [chip, runControl, cancelControl] = geometry;
      for (const item of geometry) {
        expect(item.offset).toBeLessThanOrEqual(1);
        expect(item.whole).toBe(true);
        expect(Math.abs(item.left - item.right)).toBeLessThanOrEqual(1);
        expect(Math.min(item.left, item.right)).toBeGreaterThanOrEqual(
          item.padding - 1,
        );
      }
      expect([chip.outline, runControl.outline, cancelControl.outline]).toEqual(
        ["none", "solid", "none"],
      );
    };
    const wire = observe(page);
    await withReply(
      state,
      page,
      `Start it with ${inline(single)}.\n\n${inline(lines[0])}  \n${
        inline(lines[1])
      }`,
      async () => {
        await themeEach(async (label) => {
          await span(page, single).click({ button: "right" });
          await expect(terminalMenuItem(page)).toHaveAccessibleName(
            `Run in terminal: ${single}`,
          );
          await terminalMenuItem(page).hover();
          await shot("menu-inline-code", label);
          await page.keyboard.press("Escape");
          await expect(terminalMenuItem(page)).toHaveCount(0);
        });
        await pasteInline(page, single);
        await expect(run(page)).toBeFocused();
        await themeEach(async (label) => {
          await page.mouse.move(0, 0);
          await checkFooter();
          await shot("pending-docked", label);
          await run(page).hover();
          await checkFooter();
          await shot("pending-hovered", label);
        });
        await cancel(page).click();
        await expect.poll(() => text(page)).not.toContain(single);
        const first = span(page, lines[0]);
        const paragraph = page.locator("p").filter({ has: first });
        await first.scrollIntoViewIfNeeded();
        await selectContents(paragraph);
        expect(await page.evaluate(() => getSelection()?.toString())).toBe(
          multi,
        );
        await first.click({ button: "right" });
        await expect(terminalMenuItem(page)).toHaveAccessibleName(
          `Run in terminal: ${lines[0]}...`,
        );
        await terminalMenuItem(page).click();
        await expect(pending(page).locator("code")).toHaveAttribute(
          "title",
          multi,
        );
        await expect(pending(page)).toContainText("+1 line");
        await expect.poll(() => text(page)).toContain(lines[1]);
        expect(wire.input.join("")).toContain(`\x1b[200~${multi}\x1b[201~`);
        await page.getByRole("button", { name: "Expand terminal", exact: true })
          .click();
        await expect(
          page.getByRole("dialog", { name: "Terminal" }).getByRole("group", {
            name: "Pasted command",
          }),
        ).toBeVisible();
        await expect(run(page)).toBeEnabled();
        // The existing resize control keeps focus across its portal move; use
        // normal tab navigation to capture keyboard focus inside the footer.
        await run(page).focus();
        await themeEach(async (label) => {
          await page.mouse.move(0, 0);
          await checkFooter();
          await shot("pending-expanded-multiline", label);
        });
        await page.keyboard.press("Escape");
        await expect(pending(page)).toHaveCount(0);
        await expect(page.getByRole("dialog", { name: "Terminal" }))
          .toBeVisible();
      },
    );
  });
}
