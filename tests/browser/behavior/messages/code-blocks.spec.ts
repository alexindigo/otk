// SPDX-License-Identifier: LGPL-3.0-only
import type { Locator, Page } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import type { TestState } from "../../fixtures/test-state.ts";
import { openSession } from "../../fixtures/wire.ts";
import { contextMenu, rightClick } from "../../pages/menus.ts";
import {
  expandTool,
  nativeIdle,
  prompt,
  revealAcquired,
  runNativeTool,
} from "../../pages/transcript.ts";

const block = (page: Page, kind: string) =>
  page.locator(`.otk-code-block[data-code-kind=${kind}]`);
const button = (scope: Locator) =>
  scope.getByRole("button", { name: "Copy code", exact: true });
const fence = (lang: string, source: string) =>
  "```" + lang + "\n" + source + "\n```";

async function reply(state: TestState, page: Page, source: string) {
  await state.queue([source]);
  await prompt(page, "Show the source examples");
}

async function session(state: TestState, page: Page) {
  const { id } = await state.native<{ id: string }>("/session", "POST", {
    title: "Copy code blocks",
  });
  await openSession(state, page, id);
  return id;
}

async function copy(page: Page, scope: Locator, text: string) {
  await button(scope).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(text);
}

test(
  "messages.code-block-copy-every-kind",
  { tag: "@messages" },
  async ({ isolatedState: state, page, context }) => {
    const id = await session(state, page);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const shell = "printf 'one\\n'\nprintf 'two\\n'";
    const python = "print('hello')";
    const console = "$ printf 'console\\n'\nconsole";
    await reply(
      state,
      page,
      [fence("bash", shell), fence("python", python), fence("console", console)]
        .join("\n\n"),
    );
    for (const source of [shell, python, console]) {
      await copy(
        page,
        block(page, "fence").filter({ hasText: source.split("\n")[0] }),
        source,
      );
    }
    const command = "printf '%s\\n' shell-output";
    await runNativeTool(state, page, id, "bash", {
      command,
      description: "Print a sample",
    });
    await expandTool(page, "[data-tool=bash]");
    await copy(page, block(page, "command"), command);
    const output = block(page, "output").filter({ hasText: "shell-output" });
    await copy(page, output, (await output.locator("pre").textContent())!);
    const path = state.directory + "/copy-fixture.txt";
    await state.controller.call("writeProjectFiles", {
      lease: state.lease.lease,
      files: { "copy-fixture.txt": "old source\n" },
    });
    await runNativeTool(state, page, id, "read", { filePath: path });
    await expandTool(page, "[data-tool=read]");
    await copy(page, block(page, "file"), "old source");
    await runNativeTool(state, page, id, "edit", {
      filePath: path,
      oldString: "old source",
      newString: "new source",
    });
    await expandTool(page, "[data-tool=edit]");
    await copy(page, block(page, "diff"), "new source");
  },
);

test(
  "messages.code-block-copy-long-virtualized",
  { tag: "@messages" },
  async ({ isolatedState: state, page, context }) => {
    const id = await session(state, page);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const source = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    await reply(state, page, fence("text", source));
    await nativeIdle(state, id);
    // Acquire the measured control through reader input. Click auto-scroll
    // does not pause tail follow and can lose the button during layout.
    await revealAcquired(page, '[data-message-command="code.copy"]');
    const code = block(page, "fence");
    await expect(button(code)).toBeVisible();
    await expect(button(code)).toBeInViewport();
    const rows = await code.locator(".otk-code-line, .otk-code-raw").count();
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThan(3000);
    await copy(page, code, source);
  },
);

test(
  "messages.code-block-actions-keyboard",
  { tag: "@messages" },
  async ({ isolatedState: state, page, context }) => {
    await session(state, page);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await reply(state, page, fence("text", "keyboard copy"));
    const code = block(page, "fence");
    const action = button(code);
    await expect(action).toBeVisible();
    const before = await action.boundingBox();
    await action.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(action).not.toBeFocused();
    await page.keyboard.press("Tab");
    await expect(action).toBeFocused();
    await page.keyboard.press("Enter");
    const status = code.getByRole("status").filter({ hasText: /^Copied$/ });
    await expect(status).toBeAttached();
    expect(await action.boundingBox()).toEqual(before);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("keyboard copy");
    await expect(status).toHaveCount(0);
    expect(await action.boundingBox()).toEqual(before);
  },
);

test.use({
  profile: "revert-native",
  launchOptions: {
    args: ["--host-resolver-rules=MAP otk.test 127.0.0.1", "--no-proxy-server"],
  },
});
test.describe("plain HTTP", () => {
  async function plain(state: TestState, page: Page) {
    const { id } = await state.native<{ id: string }>("/session", "POST", {
      title: "Plain HTTP copy",
    });
    const url = new URL(state.url);
    url.hostname = "otk.test";
    url.hash = `/local/${id}`;
    await page.goto(url.href);
    expect(await page.evaluate(() => isSecureContext)).toBe(false);
    await page.evaluate(() =>
      document.addEventListener("copy", (event) => {
        document.documentElement.dataset.copied = event.clipboardData?.getData(
          "text/plain",
        );
      })
    );
    await reply(state, page, fence("text", "plain HTTP\n  indented"));
    return block(page, "fence");
  }
  test(
    "messages.code-block-copy-plain-http",
    { tag: "@messages" },
    async ({ isolatedState: state, page }) => {
      await button(await plain(state, page)).click();
      await expect(page.locator("html")).toHaveAttribute(
        "data-copied",
        "plain HTTP\n  indented",
      );
    },
  );
  test(
    "messages.code-block-copy-failure-is-quiet",
    { tag: "@messages" },
    async ({ isolatedState: state, page }) => {
      const code = await plain(state, page);
      await expect(button(code)).toBeVisible();
      const height = (await code.boundingBox())!.height;
      await page.evaluate(() =>
        Object.defineProperty(document, "execCommand", {
          configurable: true,
          value: () => false,
        })
      );
      await button(code).click();
      const failed = code.getByRole("button", {
        name: "Copy code failed",
        exact: true,
      });
      await expect(failed).toHaveAccessibleDescription(
        /Select the code and press Ctrl\+C/,
      );
      await expect(code.getByRole("alert")).toHaveCount(0);
      await expect(code.locator(".otk-failure-signal")).toHaveCount(0);
      expect((await code.boundingBox())!.height).toEqual(height);
      await page.evaluate(() =>
        Reflect.deleteProperty(document, "execCommand")
      );
      await failed.click();
      await expect(button(code)).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute(
        "data-copied",
        "plain HTTP\n  indented",
      );
    },
  );
});

test(
  "messages.code-block-copy-in-saved-branch",
  { tag: "@messages" },
  async ({ isolatedState: state, page, context }) => {
    await page.setViewportSize({ width: 1280, height: 1500 });
    const id = await session(state, page);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const source = "printf 'archived\\n'";
    await reply(state, page, fence("bash", source));
    await expect(block(page, "fence")).toBeVisible();
    await expect(page.locator(`[data-session="${id}"]`)).toHaveAttribute(
      "data-status",
      "idle",
    );
    await page.locator('[data-message-command="prompt.revert"]').click();
    await page.getByRole("button", { name: "Confirm revert", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Restore conversation", exact: true }),
    ).toBeVisible();
    await state.queue(["Replacement reply"]);
    await prompt(page, "Replace the earlier conversation");
    await expect(page.locator(".otk-messages")).toContainText(
      "Replacement reply",
    );
    await rightClick(page, ".otk-messages");
    await contextMenu(page).getByRole("menuitem", {
      name: /^(Saved earlier branches|Saved conversation copies \(1\))$/,
    }).click();
    const saved = page.getByRole("region", {
      name: "Saved earlier branch",
      exact: true,
    });
    await copy(page, saved.locator(".otk-code-block"), source);
  },
);
