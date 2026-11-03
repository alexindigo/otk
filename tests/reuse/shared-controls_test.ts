// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { test } from "../support/resources.ts";
import { uiConsumer } from "../support/ui-consumer.ts";
import { selectionGeometry } from "../support/selection-geometry.ts";

async function capture(
  b: import("../support/cdp.ts").Cdp,
  name: string,
  region?: string,
) {
  const shots = Deno.env.get("OTK_SHARED_SHOTS");
  if (!shots) return;
  await Deno.mkdir(shots, { recursive: true });
  await b.evaluate("document.activeElement?.blur()");
  if (region) {
    await b.evaluate(
      `document.querySelector(${
        JSON.stringify(region)
      }).scrollIntoView({block:'end',behavior:'instant'})`,
    );
  }
  await b.evaluate(
    "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
  );
  await b.screenshot(join(shots, `${name}.png`));
  await b.evaluate(
    "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
  );
  await b.screenshot(join(shots, `${name}-stable.png`));
}

// C13 owns native preference reconciliation and injected-group behavior.
test("shared file collections preserve counts, inline labels and disclosure; icon frames preserve native geometry", async () => {
  const f = await uiConsumer("?shared-controls"), b = f.browser;
  try {
    await b.poll(
      "document.querySelectorAll('[data-diffs] .otk-tool-line').length===2",
    );
    assertEquals(
      await b.evaluate(
        "[...document.querySelectorAll('[data-diffs] .otk-tool-toggle')].map(e=>e.getAttribute('aria-expanded'))",
      ),
      ["false", "false"],
    );
    for (const tool of ["edit", "patch"]) {
      // Identity is feature data; consumers do not query the collection's internals to control it.
      await b.click(`[data-diffs] [data-tool=${tool}] .otk-tool-toggle`);
      await b.poll(
        `!document.querySelector('[data-diffs] [data-tool=${tool}] .otk-tool-body').hidden`,
      );
    }
    assertEquals(
      await b.evaluate(
        "[...document.querySelectorAll('[data-diffs] .otk-diff')].map(e=>[e.getAttribute('aria-label'),!!e.querySelector('header'),[...e.querySelectorAll('.otk-diff-text')].map(x=>x.textContent).join('|')])",
      ),
      [["Modified a.ts", false, "old|new"], [
        "Modified a.ts",
        false,
        "old|new",
      ]],
    );
    assertEquals(
      await b.evaluate(
        "[...document.querySelectorAll('[data-diffs] .otk-tool-toggle')].every(e=>e.textContent.includes('+1')&&e.textContent.includes('−1'))",
      ),
      true,
    );
    for (
      const [button, theme] of [["dark", "otk-dark"], ["light", "otk-light"]]
    ) {
      await b.evaluate(
        `document.querySelector('[data-${button}]').click();document.querySelector('[data-diffs]').scrollIntoView({block:'end',behavior:'instant'})`,
      );
      await capture(b, `${theme}-file-icons`);
    }
    const icons = await b.evaluate(
      `(()=>{const selectors=['.otk-inbox-brand svg','.otk-tool-icon svg','.otk-takeover-collapse svg'];return selectors.map(s=>{const e=document.querySelector(s),r=e.getBoundingClientRect();return [e.getAttribute('viewBox'),e.getAttribute('stroke-width'),e.getAttribute('aria-hidden'),r.width,r.height]})})()`,
    );
    assertEquals(icons, [["0 0 24 24", "1.75", "true", 16, 16], [
      "0 0 24 24",
      "1.75",
      "true",
      13,
      13,
    ], ["0 0 24 24", "1.75", "true", 16, 16]]);
    assertEquals(b.errors, []);
  } finally {
    await f.close();
  }
});

test("restored own answers size from content after collapse and remount; autocomplete uses permanent shared pointers", async () => {
  const f = await uiConsumer("?shared-controls"),
    b = f.browser,
    failures: unknown[] = [];
  try {
    await b.poll("!!document.querySelector('textarea[name=question-answer]')");
    const text = Array.from(
      { length: 6 },
      (_, i) => `Restored answer line ${i + 1}`,
    ).join("\n");
    await b.fill("textarea[name=question-answer]", text);
    for (const theme of ["otk-dark", "otk-light"]) {
      // This consumer's theme owner is shared with the ordinary reuse consumer.
      await b.evaluate(
        `document.querySelector('[data-${
          theme === "otk-dark" ? "dark" : "light"
        }]')?.click()`,
      );
      await b.click('[aria-label="Hide the question"]');
      await b.click('[aria-label="Show the question"]');
      await b.click("[data-remount]");
      await b.poll("!document.querySelector('textarea[name=question-answer]')");
      await b.click("[data-remount]");
      await b.poll(
        "!!document.querySelector('textarea[name=question-answer]')",
      );
      const dimensions = await b.evaluate<
        { height: number; scroll: number; value: string }
      >(`(()=>{const e=document.querySelector('textarea[name=question-answer]');return {height:e.clientHeight,scroll:e.scrollHeight,value:e.value}})()`);
      try {
        assertEquals(dimensions.value, text);
        assert(
          dimensions.height >= dimensions.scroll - 1,
          JSON.stringify(dimensions),
        );
      } catch (e) {
        failures.push(e);
      }
      await b.fill("textarea[name=prompt]", "@");
      await b.poll(
        "document.querySelectorAll('.otk-autocomplete button').length===2",
      );
      try {
        const geometry = await selectionGeometry(b, ".otk-autocomplete button");
        assertEquals(geometry.length, 2);
        for (const g of geometry) {
          assertEquals([g.orientation, g.w, g.h, g.shift], [
            "vertical",
            3,
            14,
            0,
          ]);
          assert(g.centred < .5);
        }
      } catch (e) {
        failures.push(e);
      }
      await capture(b, `${theme}-question-completion`, ".otk-question-dock");
      // C9 owns native completion keyboard/pointer outcomes; retain this fixed
      // per-theme selection geometry with the question-size visual remainder.
      await b.fill("textarea[name=prompt]", "");
    }
    // C11 owns the Dark collapse/remount and shrink contract in Playwright;
    // this remainder retains restored-height/selection geometry in both themes.
    assertEquals(b.errors, []);
    if (failures.length) {
      throw new AggregateError(
        failures,
        "Restored answers / shared completion selection",
      );
    }
  } finally {
    await f.close();
  }
});
