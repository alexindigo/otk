// SPDX-License-Identifier: LGPL-3.0-only
import type { Page } from "@playwright/test";
import { expect, test } from "../../fixtures/evidence.ts";
import { isolatedTest } from "../../fixtures/isolated.ts";
import type { TestState } from "../../fixtures/test-state.ts";
import { type Frame, openSession } from "../../fixtures/wire.ts";
import { cleanup, observe, tabs, viewport } from "../../pages/terminal.ts";
import { expandTool, prompt, runNativeTool } from "../../pages/transcript.ts";

isolatedTest.use({ profile: "revert-native" });

const run = (page: Page) =>
  page.getByRole("button", { name: "Run in terminal", exact: true });
const command = (part: string) => `printf 'otk-%s\\n' ${part}`;
const bash = (commands: string[]) =>
  "```bash\n" + commands.join("\n") + "\n```";
async function start(state: TestState, page: Page) {
  const { id } = await state.native<{ id: string }>("/session", "POST", {
    title: "Run code blocks",
  });
  await openSession(state, page, id);
  return id;
}
async function reply(state: TestState, page: Page, source: string) {
  await state.queue([source]);
  await prompt(page, "Show sample terminal commands");
  await expect(page.locator(".otk-code code").first()).toBeVisible();
}

async function expectRunOutput(page: Page, first: string, last: string) {
  // Issue 2.118: the actual grid can wrap the long shell prompt and move
  // the first command's output into scrollback before the last one paints.
  const output = viewport(page);
  await expect(output).toHaveAttribute("aria-label", new RegExp(last));
  const scrollback = page.getByRole("scrollbar", {
    name: "Terminal scrollback",
    exact: true,
  });
  const scrolled = !(await output.getAttribute("aria-label"))?.includes(first);
  if (scrolled) {
    await scrollback.press("Home");
    await expect(scrollback).toHaveAttribute("aria-valuenow", "0");
  }
  await expect(output).toHaveAttribute("aria-label", new RegExp(first));
  if (scrolled) await scrollback.press("End");
}

test(
  "terminal.run-code-multi-line-opens-dock-and-runs",
  { tag: "@terminal" },
  async ({ state, page }) => {
    const capture = process.env.OTK_CODE_BLOCK_SCREENSHOTS;
    if (capture) await page.setViewportSize({ width: 1280, height: 1800 });
    const id = await start(state, page);
    try {
      await reply(state, page, bash([command("run-a"), command("run-b")]));
      await expect(tabs(page)).toHaveCount(0);
      await run(page).click();
      await expect(tabs(page)).toHaveCount(1);
      await expect(
        page.getByRole("textbox", { name: "Terminal input", exact: true }),
      ).toBeFocused();
      await expectRunOutput(page, "otk-run-a", "otk-run-b");
      if (capture) {
        for (const scale of ["100", "125"]) {
          await state.product("prefs.set", { key: "textSize", value: scale });
          await expect.poll(() =>
            page.locator("html").evaluate((root) =>
              getComputedStyle(root).getPropertyValue("--otk-scale").trim()
            )
          ).toBe(String(Number(scale) / 100));
          for (
            const [theme, label] of [["otk-dark", "dark"], [
              "otk-light",
              "linen",
            ], ["otk-light-stone", "stone"]]
          ) {
            await state.product("prefs.set", { key: "theme", value: theme });
            await expect(page.locator("html")).toHaveAttribute(
              "data-otk-theme",
              theme,
            );
            await expect(viewport(page)).toHaveAttribute(
              "aria-label",
              /otk-run-b/,
            );
            await page.screenshot({
              path: `${capture}/code-blocks-run-${label}-${scale}.png`,
              fullPage: true,
              animations: "disabled",
            });
          }
        }
      }
    } finally {
      await cleanup(state, id);
    }
  },
);

test(
  "terminal.run-code-reuses-open-terminal",
  { tag: "@terminal" },
  async ({ state, page }) => {
    await page.setViewportSize({ width: 1280, height: 1600 });
    const id = await start(state, page);
    try {
      await reply(state, page, bash([command("reused")]));
      await page.getByRole("button", { name: "Open terminal", exact: true })
        .click();
      await expect(viewport(page)).toHaveAttribute("aria-label", /\$/);
      const before = await state.product("terminal.list", { sessionID: id });
      await run(page).click();
      await expect(viewport(page)).toHaveAttribute("aria-label", /otk-reused/);
      await expect(tabs(page)).toHaveCount(1);
      expect(
        (await state.product("terminal.list", { sessionID: id })).map((t) =>
          t.id
        ),
      ).toEqual(before.map((t) => t.id));
    } finally {
      await cleanup(state, id);
    }
  },
);

test(
  "terminal.run-code-console-strips-prompts",
  { tag: "@terminal" },
  async ({ state, page }) => {
    const wire = observe(page);
    const id = await start(state, page);
    try {
      const first = command("c1"), second = command("c2");
      await reply(
        state,
        page,
        "```console\n$ " + first + "\nnoise-output\n$ " + second + "\n```",
      );
      await run(page).click();
      await expectRunOutput(page, "otk-c1", "otk-c2");
      const input = wire.input.join("");
      expect(input).toContain(first);
      expect(input).toContain(second);
      expect(input).not.toContain("$ ");
      expect(input).not.toContain("noise-output");
    } finally {
      await cleanup(state, id);
    }
  },
);

isolatedTest(
  "terminal.run-code-bash-tool-command",
  { tag: "@terminal" },
  async ({ isolatedState: state, page }) => {
    const id = await start(state, page);
    try {
      await runNativeTool(state, page, id, "bash", {
        command: command("tool"),
        description: "Print a sample",
      });
      await expandTool(page, "[data-tool=bash]");
      await run(page).click();
      await expect(viewport(page)).toHaveAttribute("aria-label", /otk-tool/);
    } finally {
      await cleanup(state, id);
    }
  },
);

isolatedTest(
  "terminal.run-code-only-shell-blocks",
  { tag: "@terminal" },
  async ({ isolatedState: state, page }) => {
    const id = await start(state, page);
    await reply(
      state,
      page,
      bash([command("shell")]) + "\n\n```python\nprint('python example')\n```",
    );
    await expect(run(page)).toHaveCount(1);
    const path = state.directory + "/not-shell.sh";
    await state.controller.call("writeProjectFiles", {
      lease: state.lease.lease,
      files: { "not-shell.sh": "echo before\n" },
    });
    const notRunnable = async (kind: string) => {
      const block = page.locator(`.otk-code-block[data-code-kind=${kind}]`)
        .first();
      await expect(block).toBeVisible();
      await expect(block.getByRole("button", { name: "Run in terminal" }))
        .toHaveCount(0);
    };
    await runNativeTool(state, page, id, "read", { filePath: path });
    await expandTool(page, "[data-tool=read]");
    await notRunnable("file");
    await runNativeTool(state, page, id, "edit", {
      filePath: path,
      oldString: "before",
      newString: "after",
    });
    await expandTool(page, "[data-tool=edit]");
    await notRunnable("diff");
    await runNativeTool(state, page, id, "bash", {
      command: command("output"),
      description: "Print output",
    });
    await expandTool(page, "[data-tool=bash]");
    await notRunnable("output");
  },
);

test("terminal.run-code-unavailable-is-quiet-and-disabled", {
  tag: "@terminal",
}, async ({ state, page }) => {
  await page.setViewportSize({ width: 1280, height: 1600 });
  await page.routeWebSocket("**/api/ws", (socket) => {
    const server = socket.connectToServer();
    const keys = new Set<string>();
    socket.onMessage((message) => {
      const frame = JSON.parse(message.toString()) as Frame;
      if (
        frame.t === "request" && frame.method === "terminal.create" && frame.ref
      ) keys.add(frame.ref.key);
      server.send(message);
    });
    server.onMessage((message) => {
      const frame = JSON.parse(message.toString()) as Frame;
      if (frame.t !== "request.result" || !keys.has(frame.ref?.key ?? "")) {
        return socket.send(message);
      }
      socket.send(JSON.stringify({
        ...frame,
        outcome: {
          ok: false,
          error: {
            code: "terminal-unavailable",
            retry: "none",
            diagnosticID: "terminal-fixture-unavailable",
            facts: {
              actionLabel: "Creating terminal",
              reason: "Terminal host is unavailable",
            },
          },
        },
      }));
    });
  });
  const id = await start(state, page);
  try {
    await reply(state, page, bash([command("unavailable")]));
    await run(page).click();
    const terminal = page.getByRole("region", {
      name: "Terminal",
      exact: true,
    });
    await expect(
      terminal.getByText("Terminal host is unavailable", { exact: true }),
    ).toHaveCount(1);
    // An open terminal can occupy the bounded transcript's viewport. Hiding
    // the dock must retain the reason on the same session's code control.
    await terminal.getByRole("button", { name: "Hide terminal", exact: true })
      .click();
    await expect(terminal).toHaveCount(0);
    await expect(run(page)).toBeDisabled();
    await expect(run(page)).toHaveAccessibleDescription(
      "Terminals are unavailable on this OTK server",
    );
    await expect(page.getByRole("button", { name: "Run in terminal failed" }))
      .toHaveCount(0);
  } finally {
    await cleanup(state, id);
  }
});

test(
  "terminal.run-code-streaming-is-disabled",
  { tag: "@terminal" },
  async ({ state, page }) => {
    await start(state, page);
    const { gate } = await state.controller.call<{ gate: string }>(
      "queueScript",
      {
        lease: state.lease.lease,
        chunks: ["```bash\n" + command("streaming") + "\n", "```"],
        delay: 100,
        gate: "held",
      },
    );
    try {
      await prompt(page, "Stream a shell example");
      await expect(run(page)).toBeDisabled();
      await expect(run(page)).toHaveAccessibleDescription(
        "This block is still being written",
      );
    } finally {
      await state.release(gate);
    }
  },
);
