// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { acquireOlderHistory } from "../../pages/history.ts";
import {
  expandTool,
  revealAcquired,
  runNativeTool,
} from "../../pages/transcript.ts";
import { mkdir, writeFile } from "node:fs/promises";

test.use({ profile: "messages-tools" });
test("messages.project-and-outside-tool-paths-reload", {
  tag: ["@messages", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  test.setTimeout(180_000);
  await state.controller.call("writeProjectFiles", {
    lease: state.lease.lease,
    files: {
      "src/AGENTS.md": "# Fixture instructions\nRead the fixture only.\n",
      "src/probe.txt": "path marker\n",
    },
  });
  const outsideDirectory = state.controller.info!.root + "/outside";
  await mkdir(outsideDirectory);
  await writeFile(outsideDirectory + "/probe.txt", "outside marker\n");
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Shared path presentation",
  });
  await openSession(state, page, session.id);
  const checks: {
    selector: string;
    expected: string;
    result?: string;
    text?: string;
  }[] = [];
  for (const outside of [false, true]) {
    const directory = outside ? outsideDirectory : state.directory + "/src";
    for (const kind of ["read", "list", "glob"]) {
      const file = kind === "read" ? directory + "/probe.txt" : directory;
      const part = await runNativeTool(
        state,
        page,
        session.id,
        kind === "glob" ? "glob" : "read",
        kind === "glob"
          ? { pattern: "*.txt", path: directory }
          : { filePath: file },
      );
      const selector = `[data-message="${part.messageID}"] .otk-tool-line`;
      await expect(page.locator(selector)).toHaveAttribute(
        "data-tool-status",
        "completed",
      );
      const expected = outside
        ? file
        : kind === "read"
        ? "src/probe.txt"
        : "src";
      await expect(page.locator(selector + " .otk-tool-target")).toHaveText(
        expected,
      );
      await expandTool(page, selector);
      await expect(page.locator(selector + " .otk-tool-summary")).toHaveCount(
        0,
      );
      const sourceText = kind === "read"
        ? outside ? "outside marker" : "path marker"
        : undefined;
      if (sourceText) {
        await expect(page.locator(selector + " .otk-code code"))
          .toHaveJSProperty("textContent", sourceText);
      }
      if (kind === "read" && !outside) {
        await expect(page.locator(selector + " .otk-muted .otk-path"))
          .toHaveText("src/AGENTS.md");
      }
      const result = kind === "glob"
        ? outside ? directory + "/probe.txt" : "src/probe.txt"
        : undefined;
      if (result) {
        await expect(page.locator(selector + " .otk-tool-output"))
          .toHaveJSProperty("textContent", result);
      }
      if (kind === "list") {
        const text = await page.locator(selector + " .otk-tool-output")
          .textContent();
        expect(text).toContain(
          outside ? directory + "/probe.txt" : "src/probe.txt",
        );
        expect(text).not.toContain(state.directory);
      }
      checks.push({ selector, expected, result, text: sourceText });
    }
  }
  await runNativeTool(state, page, session.id, "bash", {
    command: "pwd",
    description: "Path presentation",
    workdir: state.directory + "/src",
  });
  await expandTool(page, "[data-tool=bash]");
  await expect(page.locator("[data-tool=bash] .otk-muted .otk-path"))
    .toHaveText("src");
  const nativeCount =
    (await state.native<unknown[]>(`/session/${session.id}/message`)).length;
  await page.reload();
  await openSession(state, page, session.id);
  await acquireOlderHistory(page, nativeCount);
  for (const check of checks) {
    await revealAcquired(page, check.selector);
    await expect(page.locator(check.selector)).toHaveAttribute(
      "data-tool-status",
      "completed",
    );
    await expect(page.locator(check.selector + " .otk-tool-target")).toHaveText(
      check.expected,
    );
    await expandTool(page, check.selector);
    await expect(page.locator(check.selector + " .otk-tool-summary"))
      .toHaveCount(0);
    if (check.text) {
      await expect(page.locator(check.selector + " .otk-code code"))
        .toHaveJSProperty("textContent", check.text);
    }
    if (check.result) {
      await expect(page.locator(check.selector + " .otk-tool-output"))
        .toHaveJSProperty("textContent", check.result);
    }
  }
});
