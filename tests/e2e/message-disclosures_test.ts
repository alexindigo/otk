// SPDX-License-Identifier: LGPL-3.0-only
// T2 fixed-state visual remainder; ownership/cooling/draft journey is in Playwright.
import { test } from "../support/resources.ts";
import { legacyMessageScene } from "../support/legacy-message-scene.ts";
for (const theme of ["otk-dark", "otk-light"]) {
  test(`folded tools destroy expensive bodies and restore choices after virtual reentry (${theme})`, () =>
    legacyMessageScene(
      "contract-messages-disclosures",
      theme,
      async ({ b, capture }) => {
        await b.poll(
          "!!document.querySelector('.otk-tool-toggle')&&!document.querySelector('.otk-tool-body .otk-code')",
        );
        await b.click(".otk-tool-toggle");
        await b.poll(
          "document.querySelector('.otk-code')?.textContent.includes('foldedSecret')",
        );
        await capture("tool-open");
        await b.click(".otk-tool-toggle");
        await b.poll(
          "!document.querySelector('.otk-tool-body')&&document.querySelector('.otk-tool-toggle').getAttribute('aria-expanded')==='false'",
        );
        await capture("tool-folded");
      },
      "tstv1-otk",
    ));
}
