// SPDX-License-Identifier: LGPL-3.0-only
import type { Locator } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { expandTool, prompt, runNativeTool } from "../../pages/transcript.ts";

const themes = [["otk-dark", "dark"], ["otk-light", "linen"], [
  "otk-light-stone",
  "stone",
]] as const;
const capture = process.env.OTK_CODE_BLOCK_SCREENSHOTS;
test.use({ profile: "revert-native" });
const fence = (lang: string, text: string) =>
  "```" + lang + "\n" + text + "\n```";

async function measure(blocks: Locator) {
  const facts = await blocks.evaluateAll((elements) =>
    elements.map((block) => {
      const bounds = (node: Element) => node.getBoundingClientRect();
      const actions = block.querySelector(".otk-code-block-actions")!;
      const area = block.querySelector(
        ".otk-code-block-body, .otk-code-block-header",
      )!;
      const firstLine = block.querySelector(
        ".otk-code-content, .otk-code-block-text, .otk-hunk-header",
      )!;
      const computed = getComputedStyle(firstLine);
      const lineCenter = bounds(firstLine).top +
        parseFloat(computed.paddingTop) + parseFloat(computed.lineHeight) / 2;
      const inside = bounds(actions).left + 0.1 >= bounds(area).right &&
        bounds(actions).right <= bounds(block).right + 0.1;
      const buttons = Array.from(actions.querySelectorAll("button")).map(
        (button) => {
          const b = bounds(button);
          const icon = bounds(button.querySelector("svg")!);
          const gaps = [
            icon.left - b.left,
            b.right - icon.right,
            icon.top - b.top,
            b.bottom - icon.bottom,
          ];
          return {
            balance: Math.max(...gaps) - Math.min(...gaps),
            center: Math.abs(lineCenter - (b.top + b.height / 2)),
            inside: b.top >= bounds(block).top &&
              b.bottom <= bounds(block).bottom &&
              b.right <= bounds(block).right,
          };
        },
      );
      const tint = block.querySelector(
        ".otk-diff-split-row, .otk-diff-unified",
      );
      return {
        kind: block.getAttribute("data-code-kind"),
        inside,
        buttons,
        tint: !tint || bounds(tint).right + 1 >= bounds(block).right,
      };
    })
  );
  for (const { kind, inside, buttons, tint } of facts) {
    expect(inside, `${kind} owns a column outside its text`).toBe(true);
    expect(tint, `${kind} rows span the frame`).toBe(true);
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.inside, `${kind} button sits inside the frame`).toBe(true);
      expect(button.balance, `${kind} icon is centred`).toBeLessThanOrEqual(1);
      expect(button.center, `${kind} button aligns to first line`)
        .toBeLessThanOrEqual(1);
    }
  }
}

test("visual.code-block-controls-never-cover-code", {
  tag: ["@visual", "@messages"],
}, async ({ isolatedState: state, page, context }, info) => {
  await page.setViewportSize({ width: 1280, height: 1800 });
  await state.product("prefs.set", { key: "animationsOff", value: true });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { id } = await state.native<{ id: string }>("/session", "POST", {
    title: "Code block actions",
  });
  await openSession(state, page, id);
  await state.queue([[
    "Code examples",
    fence("bash", "printf 'Dock: %s\\n' ready\nprintf 'Result: %s\\n' done"),
    fence("console", "$ printf 'sample\\n'\nsample"),
    fence("python", "print('hello from Python')"),
  ].join("\n\n")]);
  await prompt(page, "Show code examples");
  await expect(page.locator(".otk-code-block[data-code-kind=fence]"))
    .toHaveCount(3);
  const path = state.directory + "/example.sh";
  await state.controller.call("writeProjectFiles", {
    lease: state.lease.lease,
    files: { "example.sh": "#!/bin/sh\necho before\n" },
  });
  await runNativeTool(state, page, id, "bash", {
    command: "printf '%s\\n' 'Example output'",
    description: "Print example output",
  });
  await expandTool(page, "[data-tool=bash]");
  await runNativeTool(state, page, id, "read", { filePath: path });
  await expandTool(page, "[data-tool=read]");
  await runNativeTool(state, page, id, "edit", {
    filePath: path,
    oldString: "before",
    newString: "after",
  });
  await expandTool(page, "[data-tool=edit]");
  await expect(page.locator(".otk-code-block[data-code-kind=diff]").first())
    .toBeVisible();
  await state.queue([fence("text", "long_line ".repeat(34).trimEnd())]);
  await prompt(page, "Show a long line");
  await expect(
    page.locator(".otk-code-content").filter({ hasText: "long_line" }),
  ).toBeVisible();
  for (const scale of [100, 125]) {
    await state.product("prefs.set", { key: "textSize", value: String(scale) });
    await expect.poll(() =>
      page.locator("html").evaluate((root) =>
        getComputedStyle(root).getPropertyValue("--otk-scale").trim()
      )
    ).toBe(String(scale / 100));
    for (const [theme, label] of themes) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      for (const width of [1280, 400]) {
        await page.setViewportSize({ width, height: 1800 });
        await state.product("layout.patch", {
          leftCollapsed: width === 400,
          rightCollapsed: width === 400,
        });
        await page.evaluate(() => document.fonts.ready);
        const blocks = page.locator(".otk-code-block");
        await expect(blocks.first()).toBeVisible();
        await measure(blocks);
        const long = page.locator(".otk-code-content").filter({
          hasText: "long_line",
        });
        await expect.poll(() =>
          long.evaluate((node) => node.scrollWidth - node.clientWidth)
        ).toBeGreaterThan(0);
        if (width === 1280 && (capture || scale === 125)) {
          if (capture) await page.setViewportSize({ width, height: 3000 });
          await page.screenshot({
            path: capture
              ? `${capture}/code-blocks-${label}-${scale}.png`
              : info.outputPath(`code-blocks-${label}-${scale}.png`),
            fullPage: true,
            animations: "disabled",
          });
          if (capture) await page.setViewportSize({ width, height: 1800 });
        }
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 1800 });
  const action = page.locator(".otk-code-block").first().getByRole("button", {
    name: "Copy code",
    exact: true,
  });
  await page.mouse.move(1, 1);
  const paint = () =>
    action.evaluate((node) => {
      const ink = getComputedStyle(node).color;
      const probes = ["--otk-fg-3", "--otk-action-text"].map((token) => {
        const probe = document.createElement("span");
        probe.style.color = `var(${token})`;
        node.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      return { ink, idle: probes[0], done: probes[1] };
    });
  const idle = await paint();
  expect(idle.ink).toBe(idle.idle);
  await action.click();
  await expect(action).toHaveClass(/\bis-done\b/);
  const done = await paint();
  expect(done.ink).toBe(done.done);
});
