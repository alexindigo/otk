// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { runTool } from "../support/rendering.ts";
import { highlightedRange } from "../support/highlight.ts";

Deno.test("typed results show highlighted native file ranges, paths and grep matches without model envelopes or repeated headers, including reload", async () => {
  const source =
    "// first\nexport const otk_result_marker = 1;\nexport const third = 2;\n// fourth\n";
  const f = await browserFixture({
    read: "allow",
    glob: "allow",
    grep: "allow",
  }, {
    prepare: async (oc) => {
      await Deno.mkdir(join(oc.directory, "src"));
      await Deno.mkdir(join(oc.directory, "src/sub"));
      await Deno.writeTextFile(join(oc.directory, "src/probe.ts"), source);
    },
  });
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Decoded tool results" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    const cases = [
      {
        name: "read",
        input: {
          filePath: join(f.oc.directory, "src/probe.ts"),
          offset: 2,
          limit: 2,
        },
        selector: "[data-tool=read]",
        content: ".otk-code code",
        expected:
          "export const otk_result_marker = 1;\nexport const third = 2;",
      },
      {
        name: "read",
        input: { filePath: join(f.oc.directory, "src"), limit: 1 },
        selector: "[data-tool=search]:has([data-search-mode=list])",
        content: ".otk-tool-output",
        expected: "src/probe.ts",
      },
      {
        name: "glob",
        input: { pattern: "*.ts", path: join(f.oc.directory, "src") },
        selector: "[data-tool=search]:has([data-search-mode=glob])",
        content: ".otk-tool-output",
        expected: "src/probe.ts",
      },
      {
        name: "grep",
        input: {
          pattern: "otk_result_marker",
          path: join(f.oc.directory, "src"),
        },
        selector: "[data-tool=search]:has([data-search-mode=grep])",
        content: ".otk-tool-output",
        expected: "src/probe.ts:2: export const otk_result_marker = 1;",
      },
    ];
    for (const item of cases) {
      const raw = await runTool(f, browser, session.id, item);
      assert(raw.state!.output);
      if (item.content === ".otk-code code") {
        assertEquals(
          (raw.state!.metadata!.display as { text: string }).text,
          item.expected,
        );
      } else if (item.name === "grep") {
        assert(
          raw.state!.output!.includes(
            "  Line 2: export const otk_result_marker = 1;",
          ),
        );
      }
      await browser.click(`${item.selector} .otk-tool-toggle`);
      await browser.poll(
        `!document.querySelector(${
          JSON.stringify(item.selector + " .otk-tool-body")
        }).hidden && document.querySelector(${
          JSON.stringify(item.selector + " " + item.content)
        })?.textContent===${JSON.stringify(item.expected)}`,
      );
      if (item.name === "read" && item.content === ".otk-code code") {
        await highlightedRange(
          browser,
          `${item.selector} .otk-code[data-language=ts] code`,
          "otk_result_marker",
        );
      }
      assertEquals(
        await browser.evaluate(
          `document.querySelector(${
            JSON.stringify(item.selector + " .otk-tool-body")
          }).textContent.includes(${JSON.stringify(f.oc.directory)})`,
        ),
        false,
      );
      assertEquals(
        await browser.evaluate(
          `document.querySelector(${
            JSON.stringify(item.selector + " .otk-tool-summary")
          })`,
        ),
        null,
      );
    }
    await highlightedRange(
      browser,
      "[data-tool=read] .otk-code[data-language=ts] code",
      "otk_result_marker",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('[data-tool=read] .otk-code-numbers').textContent",
      ),
      "2\n3",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('[data-tool=read] [data-tool-result-meta]').textContent",
      ),
      "2–3 of 4 lines · More available",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('[data-search-mode=list] [data-tool-result-meta]').textContent",
      ),
      "1–1 of 2 entries · More available",
    );
    for (
      const [mode, label] of [["list", "2 entries"], ["glob", "1 match"], [
        "grep",
        "1 match",
      ]]
    ) {
      assertEquals(
        await browser.evaluate(
          `document.querySelector('[data-search-mode=${mode}]').closest('.otk-tool-line').querySelector('.otk-tool-brief').textContent.includes(${
            JSON.stringify(label)
          })`,
        ),
        true,
      );
    }
    await browser.screenshot(join(f.oc.root, "toolrows-r2-results.png"));
    await browser.reload();
    await openSession(browser, session.id);
    for (const item of cases) {
      await browser.click(`${item.selector} .otk-tool-toggle`);
      await browser.poll(
        `!document.querySelector(${
          JSON.stringify(item.selector + " .otk-tool-body")
        }).hidden && document.querySelector(${
          JSON.stringify(item.selector + " " + item.content)
        })?.textContent===${JSON.stringify(item.expected)}`,
      );
      if (item.name === "read" && item.content === ".otk-code code") {
        await highlightedRange(
          browser,
          `${item.selector} .otk-code[data-language=ts] code`,
          "otk_result_marker",
        );
      }
    }
    await highlightedRange(
      browser,
      "[data-tool=read] .otk-code[data-language=ts] code",
      "otk_result_marker",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('[data-tool=read] .otk-code-numbers').textContent",
      ),
      "2\n3",
    );
  } finally {
    await f.stop();
  }
});

Deno.test("empty result pages retain offset and total without inverted ranges or false empty-file claims", async () => {
  const f = await browserFixture({ read: "allow" }, {
    prepare: async (oc) => {
      await Deno.mkdir(join(oc.directory, "src"));
      await Deno.writeTextFile(join(oc.directory, "src/only.txt"), "only\n");
    },
  });
  try {
    const s = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Empty directory page" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, s.id);
    const raw = await runTool(f, browser, s.id, {
      name: "read",
      input: { filePath: join(f.oc.directory, "src"), offset: 3 },
    });
    assertEquals(
      (raw.state!.metadata!.display as { entries: string[] }).entries,
      [],
    );
    await browser.poll(
      "document.querySelector('[data-tool=search]')?.dataset.toolStatus==='completed'",
    );
    await browser.click("[data-tool=search] .otk-tool-toggle");
    await browser.poll(
      "!document.querySelector('[data-tool=search] .otk-tool-body').hidden",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('[data-tool=search] .otk-tool-output').textContent",
      ),
      "No results",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('[data-tool=search] [data-tool-result-meta]').textContent",
      ),
      "Offset 3 · 1 entry total",
    );
    await runTool(f, browser, s.id, {
      name: "read",
      input: { filePath: join(f.oc.directory, "src/only.txt"), limit: 0 },
    });
    await browser.poll(
      "document.querySelector('[data-tool=read]')?.dataset.toolStatus==='completed'",
    );
    await browser.click("[data-tool=read] .otk-tool-toggle");
    await browser.poll(
      "document.querySelector('[data-tool=read] .otk-tool-body')?.textContent.includes('No lines returned')",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('[data-tool=read] [data-tool-result-meta]').textContent",
      ),
      "1 line total · More available",
    );
    assertEquals(
      await Deno.readTextFile(join(f.oc.directory, "src/only.txt")),
      "only\n",
    );
  } finally {
    await f.stop();
  }
});
