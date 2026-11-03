// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { legacySessionsScene } from "../support/legacy-sessions-scene.ts";

for (const theme of ["otk-dark", "otk-light"]) {
  test(`Sessions retains measured identity, focus, menu, search and scope in ${theme}`, () =>
    legacySessionsScene(
      "contract-sessions-window",
      theme,
      async ({ b, rpc }) => {
        for (const width of [280, 480]) {
          await rpc("layout.patch", { rightWidth: width });
          await b.poll(
            `Math.abs(document.querySelector('.otk-right-panel').getBoundingClientRect().width-${width})<1`,
          );
          const differences = await b.evaluate<number[]>(
            "[...document.querySelectorAll('.otk-session-row')].map(e=>{const a=e.querySelector('.otk-status-light').getBoundingClientRect(),b=e.querySelector('.otk-row-title').getBoundingClientRect();return Math.abs(a.y+a.height/2-b.y-b.height/2)})",
          );
          assert(differences.every((n) => n <= 1));
          assertEquals(
            await b.evaluate(
              "[...document.querySelectorAll('.otk-session-row .otk-row-title')].every(e=>getComputedStyle(e).whiteSpace==='nowrap')",
            ),
            true,
          );
          const gaps = await b.evaluate<number[]>(
            "(()=>{const c=document.querySelector('.otk-panel-new-session').getBoundingClientRect(),i=document.querySelector('.otk-panel-new-session svg').getBoundingClientRect();return [i.top-c.top,c.bottom-i.bottom,c.right-i.right,i.left-c.left]})()",
          );
          assert(Math.max(...gaps) - Math.min(...gaps) <= 1);
        }
        await b.rightClick("[data-session=tstv1-w-0]");
        await b.poll(
          "!!document.querySelector('[data-context-command=\"session.rename\"]')",
        );
        await b.click('[data-context-command="session.rename"]');
        await b.fill('[aria-label="Rename session"]', "Retained editor");
        await b.key("Enter");
        await b.poll(
          "!!document.querySelector('.otk-title-editor [role=alert]')",
        );
        assert(
          await b.evaluate(
            "(()=>{const row=document.querySelector('.otk-session-row.is-editing'),a=row.querySelector('input').getBoundingClientRect(),b=row.querySelector('.otk-status-light').getBoundingClientRect(),c=row.querySelector('.otk-list-row-trailing').getBoundingClientRect();const centre=r=>r.y+r.height/2;return Math.abs(centre(a)-centre(b))<=1&&Math.abs(centre(a)-centre(c))<=1})()",
          ),
        );
        assert(
          await b.evaluate(
            "(()=>{const e=document.querySelector('.otk-project-session-tree');return e.scrollWidth<=e.clientWidth})()",
          ),
        );
      },
    ));
}
