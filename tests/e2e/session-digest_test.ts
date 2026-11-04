// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { test } from "../support/resources.ts";
import { legacySessionsScene } from "../support/legacy-sessions-scene.ts";

for (const theme of ["otk-dark", "otk-light"]) {
  test(`unknown summaries and rejected detail never render a fictitious zero ledger (${theme})`, () =>
    legacySessionsScene("contract-sessions-unknown", theme, async ({ b }) => {
      await b.poll(
        "document.querySelector('.otk-turn-usage-trigger')?.textContent.includes('Tokens unavailable')&&document.querySelector('.otk-turn-usage-trigger').textContent.includes('Cost unavailable')",
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('.otk-message-footer').textContent.includes('$0.00')",
        ),
        false,
      );
    }, "tstv1-core"));
}
