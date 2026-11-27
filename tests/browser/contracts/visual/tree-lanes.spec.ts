// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { seed } from "../../pages/attention.ts";
import { treeLaneFindings } from "../tree-lanes-contract.ts";

for (const zoom of [1, 1.25, 1.5, 1.75, 2]) {
  test.describe(`${zoom * 100}%`, () => {
    test.use({
      viewport: {
        width: Math.round(1684 / zoom),
        height: Math.round(1300 / zoom),
      },
      deviceScaleFactor: zoom,
    });
    for (const tree of ["projects", "sessions"] as const) {
      test.describe(tree, () => {
        test.use({
          profile: tree === "projects"
            ? "contract-sessions-sidebar"
            : "isolated",
        });
        for (const root of [13, 20]) {
          test(
            `visual.tree-lanes.${zoom * 100}.${tree}${
              root === 20 ? ".root20" : ""
            }`,
            { tag: ["@visual", "@isolated"] },
            async ({ isolatedState: state, page }) => {
              await state.product("prefs.set", {
                key: "animationsOff",
                value: true,
              });
              await state.product("layout.patch", {
                leftWidth: 248,
                leftCollapsed: false,
                rightWidth: 320,
                rightCollapsed: false,
                rightView: "sessions",
              });
              const side = tree === "projects" ? "left" : "right";
              const list = page.locator(
                `.otk-sidebar-rail[data-side="${side}"]`,
              );
              if (tree === "projects") {
                await openSession(state, page, "tstv1-sidebar-all-required-0");
                const { root } = await state.observe<{ root: string }>();
                const project = (name: string) =>
                  list.locator(
                    `.otk-project-row[data-project=${
                      JSON.stringify(`${root}/sidebar/${name}`)
                    }]`,
                  );
                const parent = project("all-required");
                const child = project("all-required-child-0");
                await expect(parent).toBeVisible();
                if (!await child.isVisible()) {
                  await parent.locator("xpath=ancestor::*[@data-tree-node][1]")
                    .locator(".otk-tree-toggle").click();
                }
                await expect(child).toBeVisible();
                await expect(list.locator(".otk-archived-toggle").first())
                  .toBeVisible();
              } else {
                const parent = await seed(
                  state,
                  "Execution and dependency review",
                );
                const child = await seed(
                  state,
                  "Validate the release configuration",
                  parent.id,
                );
                await seed(
                  state,
                  "Review the reporting and evaluation contracts",
                  parent.id,
                );
                await seed(
                  state,
                  "Summarize the browser verification evidence",
                  parent.id,
                );
                const grandchild = await seed(
                  state,
                  "Confirm the transitive dependency inventory",
                  child.id,
                );
                await openSession(state, page, parent.id);
                await expect(list.locator(`[data-session="${parent.id}"]`))
                  .toHaveClass(/is-selected/);
                await expect(list.locator(`[data-session="${grandchild.id}"]`))
                  .toBeVisible();
              }
              if (root === 20) {
                await page.addStyleTag({ content: ":root{font-size:20px}" });
              }
              await expect.poll(() => treeLaneFindings(list)).toEqual([]);
            },
          );
        }
      });
    }
  });
}
