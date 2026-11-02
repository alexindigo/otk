// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assertEquals } from "@std/assert";
import { legacyMessageScene } from "../support/legacy-message-scene.ts";
for (
  const [title, profile, rows] of [
    [
      "U4 stored multi-step turn usage reaches the footer and hover/focus split; Display cost off persists after reload",
      "contract-messages-usage-priced",
      3,
    ],
    [
      "U4 unknown model prices show all five charged token categories without inventing costs",
      "contract-messages-usage-unknown",
      1,
    ],
    [
      "U4 queued prompts do not split a turn and category costs use each step's exact provider",
      "contract-messages-usage-queued",
      2,
    ],
  ] as const
) {
  test(title, async () => {
    for (const theme of ["otk-dark", "otk-light"]) {
      await legacyMessageScene(profile, theme, async ({ b, set, capture }) => {
        for (const cost of [true, false]) {
          await set("showCost", cost);
          await capture(cost ? "usage-footer" : "usage-footer-cost-off");
          await b.click("textarea[name=prompt]");
          await b.evaluate(
            "document.querySelector('.otk-turn-usage > button').focus()",
          );
          await b.poll(
            `document.querySelectorAll('.otk-usage-breakdown tbody tr').length===${rows}`,
          );
          assertEquals(
            await b.evaluate(
              "[...document.querySelectorAll('.otk-usage-breakdown tbody tr')].map(r=>r.children.length)",
            ),
            Array(rows).fill(cost ? 10 : 9),
          );
          await capture(cost ? "usage-split" : "usage-split-cost-off");
          await b.key("Escape");
          await b.key("Tab");
        }
      });
    }
  });
}
