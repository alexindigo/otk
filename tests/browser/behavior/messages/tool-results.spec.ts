// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession } from "../../fixtures/wire.ts";
import {
  expandTool,
  highlightedRange,
  openWork,
  revealAcquired,
  runNativeTool,
  workPanel,
} from "../../pages/transcript.ts";
import { readFile } from "node:fs/promises";
import type { Json } from "../../../support/fixture-control.ts";
import { nativeHistoryCount } from "../../pages/history.ts";

test(
  "messages.typed-native-results-reload",
  { tag: ["@messages"] },
  async ({ state, page }) => {
    const v2 = state.controller.info!.version.startsWith("2.");
    const source =
      "// first\nexport const otk_result_marker = 1;\nexport const third = 2;\n// fourth\n";
    await state.controller.call("writeProjectFiles", {
      lease: state.lease.lease,
      files: { "src/probe.ts": source, "src/sub/.keep": "" },
    });
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Decoded tool results",
    });
    await openSession(state, page, session.id);
    const cases: {
      name: string;
      input: Record<string, Json>;
      tool: "read" | "search";
      mode?: "list" | "glob" | "grep";
      content: string;
      expected: string;
    }[] = [
      {
        name: "read",
        input: {
          filePath: state.directory + "/src/probe.ts",
          offset: 2,
          limit: 2,
        },
        tool: "read",
        content: ".otk-code code",
        expected:
          "export const otk_result_marker = 1;\nexport const third = 2;",
      },
      {
        name: "read",
        input: { filePath: state.directory + "/src", limit: 1 },
        tool: "search",
        mode: "list",
        content: ".otk-tool-output",
        expected: v2 ? "src/sub/" : "src/probe.ts",
      },
      {
        name: "glob",
        input: { pattern: "*.ts", path: state.directory + "/src" },
        tool: "search",
        mode: "glob",
        content: ".otk-tool-output",
        expected: "src/probe.ts",
      },
      {
        name: "grep",
        input: { pattern: "otk_result_marker", path: state.directory + "/src" },
        tool: "search",
        mode: "grep",
        content: ".otk-tool-output",
        expected: "src/probe.ts:2: export const otk_result_marker = 1;",
      },
    ];
    const sourceIDs: string[] = [];
    async function details(item: typeof cases[number], messageID: string) {
      const message = `[data-message=${JSON.stringify(messageID)}]`;
      await revealAcquired(page, `${message} .otk-work-strip`);
      const work = await openWork(page.locator(message));
      const selector = `[data-tool=${item.tool}]`;
      await expandTool(page, selector);
      const row = work.locator(selector);
      await expect(row.locator(item.content))
        .toHaveJSProperty("textContent", item.expected);
      if (item.tool === "read") {
        await highlightedRange(
          page,
          `${selector} .otk-code[data-language=ts] code`,
          "otk_result_marker",
        );
        await expect(row.locator(".otk-code-numbers"))
          .toHaveJSProperty("textContent", "2\n3");
        await expect(row.locator("[data-tool-result-meta]")).toHaveText(
          v2 ? "2-3 · More available" : "2-3 of 4 lines · More available",
        );
      } else {
        const summary = row.locator(".otk-work-tool-summary");
        await expect(row.locator(`[data-search-mode=${item.mode}]`))
          .toHaveCount(1);
        if (item.mode === "list") {
          await expect(row.locator(".otk-tool-toggle")).toHaveText(/^List\b/);
          await expect(row.locator("[data-tool-result-meta]")).toHaveText(
            v2 ? "More available" : "1–1 of 2 entries · More available",
          );
          if (v2) await expect(summary).toHaveCount(0);
          else await expect(summary).toContainText("2 entries");
        } else {
          await expect(summary).toHaveText(`${item.input.pattern} · 1 match`);
        }
      }
      if (v2) {
        // V2 persists model-facing content and truncation, not historical totals.
        for (const meta of await row.locator("[data-tool-result-meta]").all()) {
          await expect(meta).not.toContainText(/\bof\b|\btotal\b|unavailable/i);
        }
      }
      await expect(row.locator(".otk-tool-body")).not.toContainText(
        state.directory,
      );
      await expect(row.locator(".otk-tool-summary")).toHaveCount(0);
    }
    for (const item of cases) {
      const raw = await runNativeTool(
        state,
        page,
        session.id,
        item.name,
        item.input,
      );
      sourceIDs.push(raw.messageID);
      expect(raw.state.output).toBeTruthy();
      if (item.content === ".otk-code code") {
        if (v2) {
          expect(raw.state.output).toContain(
            "2: export const otk_result_marker = 1;\n3: export const third = 2;",
          );
        } else {expect((raw.state.metadata!.display as { text: string }).text)
            .toBe(item.expected);}
      } else if (item.name === "grep") {
        expect(raw.state.output).toContain(
          "  Line 2: export const otk_result_marker = 1;",
        );
      }
      await details(item, raw.messageID);
    }
    const history = await state.native<unknown[]>(
      `/session/${session.id}/message`,
    );
    // Decision 1/addendum 2 retain native controls/outcomes; the legacy fixture facade omits controls.
    const nativeCount = await nativeHistoryCount(state, session.id);
    if (v2) expect(nativeCount).toBeGreaterThan(history.length);
    // Reacquired offscreen work groups use the saved reader default too.
    await page.reload();
    await openSession(state, page, session.id);
    await expect(workPanel(page)).toHaveCount(0);
    await expect(page.locator(".otk-message-flow")).toHaveAttribute(
      "data-message-count",
      String(nativeCount),
    );
    for (const [index, item] of cases.entries()) {
      await details(item, sourceIDs[index]);
    }
  },
);

test(
  "messages.empty-result-offset-total",
  { tag: ["@messages", "@contracts"] },
  async ({ state, page }) => {
    const v2 = state.controller.info!.version.startsWith("2.");
    await state.controller.call("writeProjectFiles", {
      lease: state.lease.lease,
      files: { "src/only.txt": "only\n" },
    });
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Empty directory page",
    });
    await openSession(state, page, session.id);
    const raw = await runNativeTool(state, page, session.id, "read", {
      filePath: state.directory + "/src",
      offset: 3,
    });
    if (v2) expect(raw.state.output).toMatch(/^Read directory .+, 0 entries$/);
    else {expect((raw.state.metadata!.display as { entries: string[] }).entries)
        .toEqual([]);}
    await expect(page.locator("[data-tool=search]")).toHaveAttribute(
      "data-tool-status",
      "completed",
    );
    await expandTool(page, "[data-tool=search]");
    await expect(page.locator("[data-tool=search] .otk-tool-output"))
      .toHaveText("No results");
    if (v2) {
      await expect(page.locator("[data-tool=search] [data-tool-result-meta]"))
        .toHaveCount(0);
      await expect(page.locator("[data-tool=search]")).not.toContainText(
        /total|unavailable/i,
      );
    } else {await expect(
        page.locator("[data-tool=search] [data-tool-result-meta]"),
      ).toHaveText("Offset 3 · 1 entry total");}
    // V2 treats limit:0 as the default page; use a truly empty native file for its empty-result contract.
    if (v2) {
      await state.controller.call("writeProjectFiles", {
        lease: state.lease.lease,
        files: { "src/empty.txt": "" },
      });
    }
    await runNativeTool(state, page, session.id, "read", {
      filePath: state.directory + (v2 ? "/src/empty.txt" : "/src/only.txt"),
      limit: 0,
    });
    await expect(page.locator("[data-tool=read]")).toHaveAttribute(
      "data-tool-status",
      "completed",
    );
    await expandTool(page, "[data-tool=read]");
    await expect(page.locator("[data-tool=read] .otk-tool-body")).toContainText(
      "No lines returned",
    );
    if (v2) {
      await expect(page.locator("[data-tool=read] [data-tool-result-meta]"))
        .toHaveCount(0);
      await expect(page.locator("[data-tool=read]")).not.toContainText(
        /total|unavailable/i,
      );
    } else {await expect(
        page.locator("[data-tool=read] [data-tool-result-meta]"),
      ).toHaveText("1 line total · More available");}
    expect(await readFile(state.directory + "/src/only.txt", "utf8")).toBe(
      "only\n",
    );
  },
);
