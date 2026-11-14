// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import {
  acquireOlderHistory,
  nativeHistoryCount,
} from "../../pages/history.ts";
import {
  expandTool,
  openWorkLogs,
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
      const selector = `[data-message="${part.messageID}"] [data-tool]`;
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
      await expandTool(
        page,
        selector,
        page.locator(`[data-message="${part.messageID}"]`),
      );
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
        if (state.controller.info!.version.startsWith("2.")) {
          // Decisions 1/18 retain full instructions behind their native record disclosure.
          const instructions = page.locator(
            '[data-native-record="opencode-v2/synthetic"]',
          ).filter({ hasText: "Loaded src/AGENTS.md" });
          await expect(instructions).toBeVisible();
          const toggle = instructions.locator(".otk-tool-toggle");
          await expect(toggle).toHaveAttribute("aria-expanded", "false");
          await toggle.click();
          await expect(instructions.locator(".otk-tool-body")).toContainText(
            "Instructions from: " + state.directory + "/src/AGENTS.md",
          );
        } else {await expect(page.locator(selector + " .otk-muted .otk-path"))
            .toHaveText("src/AGENTS.md");}
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
  const bash = await runNativeTool(state, page, session.id, "bash", {
    command: "pwd",
    description: "Path presentation",
    workdir: state.directory + "/src",
  });
  await expandTool(
    page,
    "[data-tool=bash]",
    page.locator(`[data-message="${bash.messageID}"]`),
  );
  await expect(page.locator("[data-tool=bash] .otk-muted .otk-path"))
    .toHaveText("src");
  // Decision 1 retains all native control rows, not only the legacy facade's projections.
  const nativeCount = await nativeHistoryCount(state, session.id);
  await page.reload();
  await openSession(state, page, session.id);
  await acquireOlderHistory(page, nativeCount);
  for (const check of checks) {
    await revealAcquired(page, check.selector.split(" [data-tool]")[0]);
    const message = page.locator(check.selector.split(" [data-tool]")[0]);
    await openWorkLogs(page, message);
    await revealAcquired(page, check.selector);
    await expect(page.locator(check.selector)).toHaveAttribute(
      "data-tool-status",
      "completed",
    );
    await expect(page.locator(check.selector + " .otk-tool-target")).toHaveText(
      check.expected,
    );
    await expandTool(page, check.selector, message);
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
