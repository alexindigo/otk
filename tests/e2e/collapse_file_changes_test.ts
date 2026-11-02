// SPDX-License-Identifier: LGPL-3.0-only
// T2 fixed-state V remainder; preference persistence/remount is a Playwright contract.
import { test } from "../support/resources.ts";
import { assertEquals } from "@std/assert";
import { legacyMessageScene } from "../support/legacy-message-scene.ts";
test("U6 file changes start collapsed, disclose real content and follow the persisted Display preference", async () => {
  for (const theme of ["otk-dark", "otk-light"]) {
    await legacyMessageScene(
      "contract-messages-collapse",
      theme,
      async ({ b, capture, set }) => {
        await b.poll(
          "document.querySelectorAll('.otk-tool-line').length===4&&!document.querySelector('.otk-tool-body')",
        );
        await capture("collapsed");
        await set("collapseFileChanges", false);
        await b.poll(
          "document.querySelectorAll('[data-tool=edit] .otk-diff,[data-tool=patch] .otk-diff,[data-tool=write] .otk-code').length===3",
        );
        await capture("expanded");
        for (const tool of ["edit", "patch"]) {
          assertEquals(
            await b.evaluate(
              `document.querySelector('[data-tool=${tool}] .otk-tool-target').textContent`,
            ),
            `${tool}.ts`,
          );
          assertEquals(
            await b.evaluate(
              `document.querySelector('[data-tool=${tool}] .otk-tool-add').textContent`,
            ),
            "+1",
          );
          assertEquals(
            await b.evaluate(
              `document.querySelector('[data-tool=${tool}] .otk-tool-del').textContent`,
            ),
            "−1",
          );
        }
        await b.click(".otk-display-menu > button");
        await capture("display-expanded");
        await b.key("Escape");
      },
    );
  }
});
test("U6 one-token labels and literal fallback phrases reach plain and picker footers", async () => {
  for (const picker of [false, true]) {
    for (const theme of ["otk-dark", "otk-light"]) {
      await legacyMessageScene(
        picker ? "contract-messages-labels-picker" : "contract-messages-labels",
        theme,
        async ({ b, capture, mutate }) => {
          await b.poll("!!document.querySelector('.otk-message-footer')");
          await capture(`labels-${picker}`);
          if (!picker) {
            await mutate("release");
            await b.poll(
              "document.querySelector('.otk-rolled-back-strip')?.textContent.includes('1 prompt rolled back')",
            );
            await capture("literal-rollback");
          }
        },
      );
    }
  }
});
