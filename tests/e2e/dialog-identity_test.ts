// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assertEquals } from "@std/assert";
import { legacyMenusScene } from "../support/legacy-menus-scene.ts";
// These fixed rendered states retain the original Dark/Linen captures for T3.
for (
  const [title, setup, selector, value] of [
    [
      "late task save cannot close its same-type replacement",
      "dialogTest.task('Replacement task')",
      "dialog[open] input",
      "Replacement task",
    ],
    [
      "feature dismissal receives a close bound to its invocation, including deferred completion",
      "dialogTest.probe('Replacement dismissal')",
      "dialog[open]",
      "Replacement dismissal",
    ],
    [
      "standalone palette dismisses through its injected callback without a host close command",
      "dialogTest.palette()",
      "body",
      "",
    ],
  ]
) {
  test(title, async () => {
    const f = await legacyMenusScene("contract-menus-dialog");
    try {
      const b = f.b;
      await b.goto(f.url);
      await b.poll(
        '!!globalThis.dialogTest && !!document.querySelector("#origin")',
      );
      await b.click("#origin");
      await b.evaluate(setup);
      if (selector === "body") {
        await b.poll(
          '!!document.querySelector("[data-command=\\"consumer.action\\"]")',
        );
        await b.click('[data-command="consumer.action"]');
        await b.poll('!document.querySelector("input[name=command-search]")');
      }
      for (const theme of ["otk-dark", "otk-light"]) {
        await b.evaluate(`dialogTest.theme('${theme}')`);
        await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
        await b.poll(`!!document.querySelector('${selector}')`);
        if (selector.includes("input")) {
          assertEquals(
            await b.evaluate(`document.querySelector('${selector}').value`),
            value,
          );
        }
        if (selector === "dialog[open]") {
          assertEquals(
            await b.evaluate(
              `document.querySelector('${selector}').getAttribute('aria-label')`,
            ),
            value,
          );
        }
        await b.screenshot(`${f.root}/dialog-${theme}.png`);
      }
    } finally {
      await f.close();
    }
  });
}
