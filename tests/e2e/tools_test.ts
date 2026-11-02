// SPDX-License-Identifier: LGPL-3.0-only
// T2 V remainder: characterized stock envelopes, no repeated native tool journeys.
import { test } from "../support/resources.ts";
import { assertEquals } from "@std/assert";
import { legacyMessageScene } from "../support/legacy-message-scene.ts";
import { revealViewportElement } from "../support/message-viewport.ts";
import type { Cdp } from "../support/cdp.ts";
async function reveal(b: Cdp, selector: string) {
  await b.evaluate("document.querySelector('.otk-messages').scrollTop=0");
  await b.poll(
    "Number(document.querySelector('.otk-message-flow')?.dataset.messageCount)>=12",
  );
  await revealViewportElement(b, ".otk-messages", selector);
}
test("R1 bash output is ten lines, expands to thirty, and displays differing cwd", () =>
  legacyMessageScene(
    "contract-messages-recorded-tools",
    "otk-dark",
    async ({ b, capture }) => {
      const selector = "[data-tool=bash][data-tool-status=completed]";
      await reveal(b, selector + " .otk-tool-toggle");
      await b.click(selector + " .otk-tool-toggle");
      await b.poll(
        `document.querySelector('${selector} .otk-tool-output')?.textContent.split('\\n').length===10`,
      );
      await capture("bash-ten");
      await b.click(selector + " .otk-output-toggle");
      await b.poll(
        `document.querySelector('${selector} .otk-tool-output')?.textContent.split('\\n').length===30`,
      );
      await capture("bash-thirty");
    },
  ));
for (const theme of ["otk-dark", "otk-light"]) {
  test(`R4 real read, directory listing, glob, grep, local fetch, skill and generic output forms (${theme})`, () =>
    legacyMessageScene(
      "contract-messages-recorded-tools",
      theme,
      async ({ b, capture }) => {
        for (const tool of ["read", "search", "fetch", "skill", "external"]) {
          const selector = `[data-tool=${tool}][data-tool-status=completed]`;
          await reveal(b, selector + " .otk-tool-toggle");
          const toggles = await b.evaluate<number>(
            `document.querySelectorAll('${selector} .otk-tool-toggle').length`,
          );
          for (let i = 0; i < toggles; i++) {
            await b.evaluate(
              `document.querySelectorAll('${selector} .otk-tool-toggle')[${i}].click()`,
            );
          }
          await b.poll(
            `!!document.querySelector('${selector} .otk-tool-body')`,
          );
          await capture(tool);
        }
        await reveal(b, "[data-tool=external] .otk-output-toggle");
        await b.click("[data-tool=external] .otk-output-toggle");
        await b.poll(
          "document.querySelector('[data-tool=external] .otk-tool-output')?.textContent.split('\\n').length===15",
        );
        await capture("generic-expanded");
      },
    ));
}
test("tool permission warning, denied strikethrough and expandable errors use one state contract", () =>
  legacyMessageScene(
    "contract-messages-recorded-tools",
    "otk-dark",
    async ({ b, capture }) => {
      for (const tool of ["bash", "websearch"]) {
        await reveal(b, `[data-tool=${tool}][data-tool-status=denied]`);
        await capture(tool + "-denied");
      }
      await reveal(
        b,
        "[data-tool=read][data-tool-status=error] .otk-tool-error-toggle",
      );
      await b.click(
        "[data-tool=read][data-tool-status=error] .otk-tool-error-toggle",
      );
      await b.poll("!!document.querySelector('.otk-tool-error')");
      assertEquals(
        await b.evaluate(
          "document.querySelector('[data-tool=websearch]')?.textContent.includes('count unavailable')??false",
        ),
        false,
      );
      await capture("error-expanded");
    },
  ));
