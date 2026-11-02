// SPDX-License-Identifier: LGPL-3.0-only
// T2 fixed-state V remainder; complete/live/persisted usage is owned by Playwright.
import { test } from "../support/resources.ts";
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { legacyMessageScene } from "../support/legacy-message-scene.ts";
for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
  test(`U5 Sessions rows present whole-session usage for unopened sessions and helpers, refresh live and respect persisted Show cost (${theme})`, () =>
    legacyMessageScene(
      "contract-messages-session-cost",
      theme,
      async ({ b, capture, set, layout }) => {
        await b.poll(
          "document.querySelector('.otk-turn-usage > button')?.textContent==='102 model calls · 102 tokens · $1.02'",
        );
        await b.click('[aria-label="Open right panel"]');
        await b.poll(
          "document.querySelectorAll('.otk-session-cost').length===3",
        );
        const geometry = async () => {
          const boxes = await b.evaluate<
            {
              right: number;
              centre: number;
              titleCentre: number;
              lightCentre: number;
              height: number;
              overflow: boolean;
            }[]
          >(`[...document.querySelectorAll('.otk-session-row')].filter(r=>r.querySelector('.otk-session-cost')).map(r=>{const c=r.querySelector('.otk-session-cost').getBoundingClientRect(),t=r.querySelector('.otk-row-title').getBoundingClientRect(),l=r.querySelector('.otk-status-light').getBoundingClientRect(),b=r.getBoundingClientRect();return{right:c.right,centre:c.y+c.height/2,titleCentre:t.y+t.height/2,lightCentre:l.y+l.height/2,height:b.height,overflow:r.scrollWidth>r.clientWidth}})`);
          assertEquals(boxes.length, 3);
          for (const box of boxes) {
            assertAlmostEquals(box.right, boxes[0].right, .5);
            assertAlmostEquals(box.centre, box.titleCentre, .5);
            assertAlmostEquals(box.centre, box.lightCentre, .5);
            assertEquals(box.height, 30);
            assertEquals(box.overflow, false);
          }
        };
        await geometry();
        await capture("rows");
        // Resize only the fixture's panel; no native session or preference journey.
        await layout({ rightWidth: 280 });
        await b.poll(
          "document.querySelector('.otk-right-panel').getBoundingClientRect().width===280",
        );
        await geometry();
        await capture("narrow");
        await set("showCost", false);
        await b.poll(
          "!document.querySelector('.otk-session-cost')&&!document.querySelector('.otk-project-sessions [aria-label*=\"$\"]')",
        );
        assert(
          await b.evaluate(
            "!document.querySelector('.otk-turn-usage > button').textContent.includes('$')",
          ),
        );
        await capture("cost-off");
      },
    ));
}
