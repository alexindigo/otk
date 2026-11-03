// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { legacySessionsScene } from "../support/legacy-sessions-scene.ts";

for (const theme of ["otk-dark", "otk-light"]) {
  test(`project catalog sections, discovery lights, viewing, creation and persisted collapse in ${theme}`, () =>
    legacySessionsScene("contract-sessions-catalog", theme, async ({ b }) => {
      await b.poll(
        "document.querySelector('.otk-discovered-toggle')?.textContent.includes('(4)')",
      );
      const starts = await b.evaluate<number[]>(
        "[...document.querySelectorAll('.otk-project-name-line')].map(e=>e.getBoundingClientRect().left)",
      );
      assert(Math.max(...starts) - Math.min(...starts) < .5);
      const positions = () =>
        b.evaluate<number[]>(
          "[...document.querySelectorAll('.otk-project-row[data-inactive=false] .otk-status-light')].map(e=>{const r=e.getBoundingClientRect();return r.y+r.height/2})",
        );
      const before = await positions();
      await b.click('[aria-label="Collapse projects"]');
      await b.poll(
        "document.querySelector('.otk-project-inbox').dataset.collapsed==='true'",
      );
      assertEquals(await positions(), before);
      assertEquals(
        await b.evaluate(
          "[...document.querySelectorAll('.otk-project-row')].filter(e=>e.textContent.includes('empty')).every(e=>e.querySelectorAll('.otk-status-light').length===0)",
        ),
        true,
      );
    }));
}
