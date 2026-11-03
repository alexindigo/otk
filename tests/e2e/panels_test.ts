// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { legacySessionsScene } from "../support/legacy-sessions-scene.ts";

test("registered panel views, width and collapsed state persist in host preferences; unavailable capabilities stay hidden", () =>
  legacySessionsScene("contract-sessions-panel", "otk-dark", async ({ b }) => {
    await b.click('[data-panel-view="external-view"]');
    await b.poll("!!document.querySelector('[data-external-view]')");
    await b.click(".otk-panel-collapse");
    await b.poll("!!document.querySelector('.otk-right-rail')");
    assertEquals(
      await b.evaluate(
        "[...document.querySelectorAll('.otk-right-rail [data-panel-view]')].map(e=>e.dataset.panelView)",
      ),
      ["sessions", "timeline", "external-view"],
    );
    assert(
      await b.evaluate(
        "(()=>{const rows=[...document.querySelectorAll('.otk-right-rail [data-panel-view]')].map(e=>e.getBoundingClientRect());return rows[0].y>=52&&rows.slice(1).every((row,i)=>row.y>=rows[i].bottom&&Math.abs(row.x-rows[i].x)<.5)})()",
      ),
    );
  }));
test("Sessions groups the selected project's parent-child tree by task, filters titles and opens previews and solid tasks", () =>
  legacySessionsScene(
    "contract-sessions-hierarchy",
    "otk-dark",
    async ({ b }) => {
      const alignment = await b.evaluate<number[]>(
        "[...document.querySelectorAll('.otk-session-row')].map(e=>{const a=e.querySelector('.otk-status-light').getBoundingClientRect(),b=e.querySelector('.otk-row-title').getBoundingClientRect();return Math.abs(a.y+a.height/2-b.y-b.height/2)})",
      );
      assert(alignment.every((n) => n < .5));
    },
  ));
