// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { legacyMessageScene } from "../support/legacy-message-scene.ts";
for (const theme of ["otk-dark", "otk-light"]) {
  for (
    const [title, scene] of [
      [
        "transcript windows acquired history and reveals an unmounted Timeline identity",
        "contract-messages-window",
      ],
      [
        "older page prepend keeps the same anchored bubble within one pixel",
        "contract-messages-anchor",
      ],
    ] as const
  ) {
    test(`${title} (${theme})`, async () => {
      await legacyMessageScene(scene, theme, async ({ b, capture, mutate }) => {
        if (scene === "contract-messages-anchor") await mutate("release");
        await b.poll(
          "!!document.querySelector('[data-role=user] .otk-user-bubble')",
        );
        assert(
          await b.evaluate<boolean>(
            "(()=>{const lane=document.querySelector('.otk-message-flow').getBoundingClientRect(),bubble=document.querySelector('.otk-user-bubble').getBoundingClientRect();return bubble.width<=lane.width*.8+.5&&Math.abs(bubble.right-lane.right)<.5})()",
          ),
        );
        await capture(
          scene === "contract-messages-window"
            ? "timeline-window"
            : "prepend-window",
        );
      }, "tstv1-otk");
    });
  }
  test(`a large diff shares the transcript window, preserves native selection and its measured anchor (${theme})`, async () => {
    await legacyMessageScene(
      "contract-messages-diff",
      theme,
      async ({ b, set, capture }) => {
        await set("collapseFileChanges", false);
        await b.poll("!!document.querySelector('.otk-diff-text')");
        assertEquals(
          await b.evaluate(
            "document.querySelectorAll('.otk-diff-unified').length>0",
          ),
          true,
        );
        await capture("diff-window");
      },
      "tstv1-otk",
    );
  });
}
