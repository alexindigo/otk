// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { expandTool, runTool, toolRow } from "../support/rendering.ts";
import { revealViewportElement } from "../support/message-viewport.ts";

test("tool headers, bodies and path-list results share project context, including outside paths and reload", async () => {
  const f = await browserFixture({
    read: "allow",
    glob: "allow",
    bash: "allow",
    external_directory: "allow",
  }, {
    prepare: async (oc) => {
      await Deno.mkdir(join(oc.directory, "src"));
      await Deno.writeTextFile(
        join(oc.directory, "src/AGENTS.md"),
        "# Fixture instructions\nRead the fixture only.\n",
      );
      await Deno.writeTextFile(
        join(oc.directory, "src/probe.txt"),
        "path marker\n",
      );
      await Deno.mkdir(join(oc.root, "outside"));
      await Deno.writeTextFile(
        join(oc.root, "outside/probe.txt"),
        "outside marker\n",
      );
    },
  });
  try {
    const s = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Shared path presentation" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, s.id);
    const checks: {
      selector: string;
      expected: string;
      result?: string;
      text?: string;
    }[] = [];
    for (const outside of [false, true]) {
      const directory = outside
        ? join(f.oc.root, "outside")
        : join(f.oc.directory, "src");
      for (const kind of ["read", "list", "glob"] as const) {
        const file = kind === "read" ? join(directory, "probe.txt") : directory;
        const part = await runTool(
          f,
          browser,
          s.id,
          kind === "glob"
            ? { name: "glob", input: { pattern: "*.txt", path: directory } }
            : { name: "read", input: { filePath: file } },
        );
        const selector = toolRow(part);
        await browser.poll(
          `document.querySelector(${
            JSON.stringify(selector)
          })?.dataset.toolStatus==='completed'`,
        );
        const expected = outside
          ? file
          : kind === "read"
          ? "src/probe.txt"
          : "src";
        await browser.poll(
          `document.querySelector(${
            JSON.stringify(selector + " .otk-tool-target")
          })?.textContent===${JSON.stringify(expected)}`,
        );
        await expandTool(browser, selector);
        assertEquals(
          await browser.evaluate(
            `document.querySelector(${
              JSON.stringify(selector + " .otk-tool-summary")
            })`,
          ),
          null,
        );
        const sourceText = kind === "read"
          ? outside ? "outside marker" : "path marker"
          : undefined;
        if (sourceText) {
          await browser.poll(
            `document.querySelector(${
              JSON.stringify(selector + " .otk-code code")
            })?.textContent===${JSON.stringify(sourceText)}`,
          );
          assertEquals(
            await browser.evaluate(
              `document.querySelector(${
                JSON.stringify(selector + " .otk-code code")
              })?.textContent`,
            ),
            sourceText,
          );
        }
        if (kind === "read" && !outside) {
          assertEquals(
            await browser.evaluate(
              `document.querySelector(${
                JSON.stringify(selector + " .otk-muted .otk-path")
              })?.textContent`,
            ),
            "src/AGENTS.md",
          );
        }
        const result = kind === "glob"
          ? (outside ? join(directory, "probe.txt") : "src/probe.txt")
          : undefined;
        if (result) {
          assertEquals(
            await browser.evaluate(
              `document.querySelector(${
                JSON.stringify(selector + " .otk-tool-output")
              })?.textContent`,
            ),
            result,
          );
        }
        if (kind === "list") {
          const text = await browser.evaluate<string>(
            `document.querySelector(${
              JSON.stringify(selector + " .otk-tool-output")
            })?.textContent`,
          );
          assertEquals(
            text.includes(
              outside ? join(directory, "probe.txt") : "src/probe.txt",
            ),
            true,
          );
          assertEquals(text.includes(f.oc.directory), false);
        }
        checks.push({ selector, expected, result, text: sourceText });
      }
    }
    await runTool(f, browser, s.id, {
      name: "bash",
      input: {
        command: "pwd",
        description: "Path presentation",
        workdir: join(f.oc.directory, "src"),
      },
    });
    await browser.click("[data-tool=bash] .otk-tool-toggle");
    assertEquals(
      await browser.evaluate(
        "document.querySelector('[data-tool=bash] .otk-muted .otk-path')?.textContent",
      ),
      "src",
    );
    const nativeCount =
      (await f.oc.request<unknown[]>(`/session/${s.id}/message`)).length;
    await browser.reload();
    await openSession(browser, s.id);
    // Reload acquires newest ten first. Viewport reveal addresses acquired rows;
    // join that baseline and acquire earlier native pages through the UI before
    // checking the original complete set of path cases.
    await browser.poll(
      "Number(document.querySelector('.otk-message-flow')?.dataset.messageCount)>0",
    );
    while (
      await browser.evaluate<number>(
        "Number(document.querySelector('.otk-message-flow').dataset.messageCount)",
      ) < nativeCount
    ) {
      const before = await browser.evaluate<number>(
        "Number(document.querySelector('.otk-message-flow').dataset.messageCount)",
      );
      await browser.poll(
        `Number(document.querySelector('.otk-message-flow').dataset.messageCount)>${before} || !!document.querySelector('.otk-load-older')`,
      );
      await browser.evaluate(
        "document.querySelector('.otk-load-older')?.click()",
      );
      await browser.poll(
        `Number(document.querySelector('.otk-message-flow').dataset.messageCount)>${before}`,
      );
    }
    for (const check of checks) {
      const selector = check.selector;
      await revealViewportElement(browser, ".otk-messages", selector);
      await browser.poll(
        `document.querySelector(${
          JSON.stringify(selector)
        })?.dataset.toolStatus==='completed'`,
      );
      const actual = await browser.evaluate<string>(
        `document.querySelector(${
          JSON.stringify(selector + " .otk-tool-target")
        }).textContent`,
      );
      assertEquals(actual, check.expected);
      await expandTool(browser, selector);
      assertEquals(
        await browser.evaluate(
          `document.querySelector(${
            JSON.stringify(selector + " .otk-tool-summary")
          })`,
        ),
        null,
      );
      if (check.text) {
        await browser.poll(
          `document.querySelector(${
            JSON.stringify(selector + " .otk-code code")
          })?.textContent===${JSON.stringify(check.text)}`,
        );
        assertEquals(
          await browser.evaluate(
            `document.querySelector(${
              JSON.stringify(selector + " .otk-code code")
            })?.textContent`,
          ),
          check.text,
        );
      }
      if (check.result) {
        assertEquals(
          await browser.evaluate(
            `document.querySelector(${
              JSON.stringify(selector + " .otk-tool-output")
            })?.textContent`,
          ),
          check.result,
        );
      }
    }
  } finally {
    await f.stop();
  }
});
