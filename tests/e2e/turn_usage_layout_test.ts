// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { legacyMessageScene } from "../support/legacy-message-scene.ts";
for (const count of [3, 120] as const) {
  test(`U14 ${count} calls keep summary, header and Total on screen, support pointer and keyboard and retain exact U12 values`, async () => {
    for (const theme of ["otk-dark", "otk-light"]) {
      await legacyMessageScene(
        count === 3 ? "contract-messages-usage3" : "contract-messages-usage120",
        theme,
        async ({ b, capture }) => {
          for (const [width, height] of [[1280, 720], [800, 600]]) {
            await b.send("Emulation.setDeviceMetricsOverride", {
              width,
              height,
              deviceScaleFactor: 1,
              mobile: false,
            });
            await b.click("textarea[name=prompt]");
            await b.evaluate(
              "document.querySelector('.otk-turn-usage > button').focus()",
            );
            await b.poll(
              `document.querySelectorAll('.otk-usage-breakdown tbody tr').length===${count}`,
            );
            const rect = await b.evaluate<number[]>(
              "(()=>{const r=document.querySelector('.otk-turn-usage :popover-open').getBoundingClientRect();return[r.left,r.top,r.right,r.bottom]})()",
            );
            assert(
              rect[0] >= 8 && rect[1] >= 8 && rect[2] <= width - 8 &&
                rect[3] <= height - 8,
            );
            const edges = await b.evaluate<number[]>(
              "[document.querySelector('tbody .otk-usage-context > span'),document.querySelector('tfoot tr').children[1]].map(e=>{const r=document.createRange();r.selectNodeContents(e);return r.getBoundingClientRect().right})",
            );
            assertAlmostEquals(edges[0], edges[1], .5);
            assertEquals(
              await b.evaluate(
                "(()=>{const e=document.querySelector('.otk-usage-activity span');return e.scrollWidth>e.clientWidth&&getComputedStyle(e).textOverflow==='ellipsis'})()",
              ),
              true,
            );
            await capture(`${count}-${width}-initial`);
            await b.evaluate(
              "(()=>{const s=document.querySelector('.otk-usage-scroll');s.scrollLeft=0;s.scrollTop=(s.scrollHeight-s.clientHeight)/2})()",
            );
            await capture(`${count}-${width}-middle`);
            await b.evaluate(
              "(()=>{const s=document.querySelector('.otk-usage-scroll');s.scrollTop=s.scrollHeight;s.scrollLeft=s.scrollWidth})()",
            );
            await b.poll(
              "(()=>{const s=document.querySelector('.otk-usage-scroll'),r=s.getBoundingClientRect();return ['thead th','tfoot th','tbody tr:last-child'].every(q=>{const b=s.querySelector(q).getBoundingClientRect();return b.top>=r.top&&b.bottom<=r.bottom})})()",
            );
            await capture(`${count}-${width}-end`);
            await b.key("Escape");
            await b.key("Tab");
          }
        },
      );
    }
  });
}
for (const theme of ["otk-dark", "otk-light"]) {
  test(`T1 usage hover waits for pointer rest, retains surface travel, closes after grace and focuses immediately in ${theme}`, async () => {
    await legacyMessageScene(
      "contract-messages-usage3",
      theme,
      async ({ b, capture }) => {
        await capture("hover-pending");
        for (const reduced of [false, true]) {
          await b.send("Emulation.setEmulatedMedia", {
            features: [{
              name: "prefers-reduced-motion",
              value: reduced ? "reduce" : "no-preference",
            }],
          });
          await b.click("textarea[name=prompt]");
          await b.evaluate(
            "document.querySelector('.otk-turn-usage > button').focus()",
          );
          await b.poll(
            "document.querySelectorAll('.otk-usage-breakdown tbody tr').length===3",
          );
          await capture(reduced ? "hover-open-reduced" : "hover-open");
          await b.key("Escape");
          await b.key("Tab");
        }
      },
    );
  });
}
