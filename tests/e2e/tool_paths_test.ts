// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { runTool } from "../support/rendering.ts";

Deno.test("tool headers, bodies and path-list results share project context, including outside paths and reload", async () => {
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
    const s = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Shared path presentation" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, s.id);
    const checks: { expected: string; result?: string; text?: string }[] = [];
    let ordinal = 0;
    for (const outside of [false, true]) {
      const directory = outside
        ? join(f.oc.root, "outside")
        : join(f.oc.directory, "src");
      for (const kind of ["read", "list", "glob"] as const) {
        const file = kind === "read" ? join(directory, "probe.txt") : directory;
        await runTool(
          f,
          browser,
          s.id,
          kind === "glob"
            ? { name: "glob", input: { pattern: "*.txt", path: directory } }
            : { name: "read", input: { filePath: file } },
        );
        ordinal++;
        await browser.poll(
          `document.querySelectorAll('.otk-tool-line')[${
            ordinal - 1
          }]?.dataset.toolStatus==='completed'`,
        );
        await browser.evaluate(
          `document.querySelectorAll('.otk-tool-line')[${
            ordinal - 1
          }].setAttribute('data-path-probe', '${ordinal}')`,
        );
        const selector = `[data-path-probe="${ordinal}"]`;
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
        await browser.click(`${selector} .otk-tool-toggle`);
        await browser.poll(
          `!document.querySelector(${
            JSON.stringify(selector + " .otk-tool-body")
          }).hidden`,
        );
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
        checks.push({ expected, result, text: sourceText });
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
    await browser.reload();
    await openSession(browser, s.id);
    for (const [index, check] of checks.entries()) {
      await browser.poll(
        `document.querySelectorAll('.otk-tool-line')[${index}]?.dataset.toolStatus==='completed'`,
      );
      const actual = await browser.evaluate<string>(
        `document.querySelectorAll('.otk-tool-target')[${index}].textContent`,
      );
      assertEquals(actual, check.expected);
      await browser.evaluate(
        `document.querySelectorAll('.otk-tool-line')[${index}].setAttribute('data-path-probe', '${
          index + 1
        }')`,
      );
      const selector = `[data-path-probe="${index + 1}"]`;
      await browser.click(`${selector} .otk-tool-toggle`);
      await browser.poll(
        `!document.querySelector(${
          JSON.stringify(selector + " .otk-tool-body")
        }).hidden`,
      );
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
