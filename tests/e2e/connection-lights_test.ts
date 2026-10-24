// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { test } from "../support/resources.ts";
import { uiConsumer } from "../support/ui-consumer.ts";

test("independent connection and activity indicators keep domain states, theme paint, glyphs and motion", async () => {
  const f = await uiConsumer("?indicators"), b = f.browser;
  try {
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await b.click(`[data-theme=${theme}]`);
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      for (
        const [state, glyph, slot] of [
          ["connected", "✓", "connected"],
          ["connecting", "◌", "connecting"],
          ["reconnecting", "↻", "connecting"],
          ["disconnected", "○", "disconnected"],
          ["error", "×", "error"],
        ]
      ) {
        await b.click(`[data-case=${state}]`);
        const selector =
          `[data-independent-connection] [data-connection-state=${state}]`;
        await b.poll(`!!document.querySelector(${JSON.stringify(selector)})`);
        const paint = await b.evaluate<
          { color: string; token: string; width: number; label: string }
        >(`(()=>{const el=document.querySelector(${
          JSON.stringify(selector)
        });return {color:getComputedStyle(el).getPropertyValue('--connection-color').trim(),token:getComputedStyle(document.documentElement).getPropertyValue('--otk-connection-${slot}').trim(),width:el.getBoundingClientRect().width,label:el.getAttribute('aria-label')}})()`);
        assert(/^#[\da-f]{6}$/i.test(paint.token));
        assertEquals(paint.color, paint.token);
        assertEquals(paint.width, 10);
        assert(paint.label.length > 0);
        if (state !== "disconnected") {
          await b.poll(
            `!!document.querySelector('.otk-sidebar .otk-connection-light[data-connection-state=${state}]')`,
          );
        }
        await b.evaluate(
          "document.documentElement.setAttribute('data-otk-reduced-colors','')",
        );
        assertEquals(
          await b.evaluate(
            `(()=>{const el=document.querySelector(${
              JSON.stringify(selector)
            });return [el.textContent.trim(),getComputedStyle(el.querySelector('.otk-connection-dot')).display,getComputedStyle(el.querySelector('.otk-connection-shape')).display]})()`,
          ),
          [glyph, "none", "block"],
        );
        await b.evaluate(
          "document.documentElement.removeAttribute('data-otk-reduced-colors')",
        );
      }
    }
    assertEquals(
      await b.evaluate("document.querySelectorAll('.otk-status-light').length"),
      0,
    );
    await b.poll(
      "getComputedStyle(document.querySelector('.otk-activity-spinner')).animationName==='otk-activity-spin'",
    );
    assertEquals(
      await b.evaluate(
        "getComputedStyle(document.querySelector('.otk-activity-spinner')).animationDuration",
      ),
      "1.1s",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('.otk-activity-indicator').getBoundingClientRect().width",
      ),
      8,
    );
    for (const preference of ["setting", "system"]) {
      if (preference === "setting") {
        await b.evaluate(
          "document.documentElement.setAttribute('data-otk-animations-off','')",
        );
      } else {
        await b.evaluate(
          "document.documentElement.removeAttribute('data-otk-animations-off')",
        );
        await b.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-reduced-motion", value: "reduce" }],
        });
      }
      await b.poll(
        "getComputedStyle(document.querySelector('.otk-activity-spinner')).animationName==='none'",
      );
    }
    await b.evaluate(
      "document.documentElement.setAttribute('data-otk-reduced-colors','')",
    );
    assertEquals(
      await b.evaluate(
        "[document.querySelector('.otk-activity-shape').textContent,getComputedStyle(document.querySelector('.otk-activity-spinner')).display,getComputedStyle(document.querySelector('.otk-activity-shape')).display]",
      ),
      ["◐", "none", "block"],
    );
    assertEquals(b.errors, []);
  } finally {
    await f.close();
  }
});
