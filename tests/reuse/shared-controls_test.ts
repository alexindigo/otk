// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { test } from "../support/resources.ts";
import { uiConsumer } from "../support/ui-consumer.ts";
import { selectionGeometry } from "../support/selection-geometry.ts";
import { DEFAULT_PREFS } from "@otk/protocol";

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

test("shared native controls reconcile rejected intents and follow injected preference groups", async () => {
  const f = await uiConsumer("?shared-controls"), b = f.browser;
  try {
    await b.poll("!!document.querySelector('.otk-visual-settings input')");
    const failures: unknown[] = [];
    for (
      const selector of [
        ".otk-visual-settings input[name=reducedColors]",
        '.otk-notification-settings input[name="notify.sound"]',
      ]
    ) {
      await b.click(selector);
      await b.poll(
        "document.querySelector('[data-pending]').textContent==='1'",
      );
      await b.click("[data-reject]");
      await b.poll(
        "document.querySelector('[data-pending]').textContent==='0'",
      );
      try {
        assertEquals(
          await b.evaluate(
            `document.querySelector(${JSON.stringify(selector)}).checked`,
          ),
          false,
          selector,
        );
      } catch (e) {
        failures.push(e);
      }
    }
    await b.click("[data-display] button");
    const select = ".otk-display-preferences select[name=diffStyle]";
    await b.poll(`!!document.querySelector('${select}')`);
    await b.evaluate(
      `(()=>{const e=document.querySelector('${select}');e.value='split';e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await b.poll("document.querySelector('[data-pending]').textContent==='1'");
    await b.click("[data-reject]");
    await b.poll("document.querySelector('[data-pending]').textContent==='0'");
    try {
      assertEquals(
        await b.evaluate(`document.querySelector('${select}').value`),
        DEFAULT_PREFS.diffStyle,
      );
    } catch (e) {
      failures.push(e);
    }
    await b.key("Escape");
    for (
      const [region, name] of [["visual", "consumer.appearance"], [
        "notification",
        "consumer.notification",
      ]]
    ) {
      try {
        assertEquals(
          await b.evaluate(
            `!!document.querySelector('.otk-${region}-settings input[name="${name}"]')`,
          ),
          true,
          "injected group",
        );
      } catch (e) {
        failures.push(e);
      }
    }
    await b.click("[data-broadcast]");
    await b.poll(
      'document.querySelector(".otk-visual-settings input[name=reducedColors]").checked && document.querySelector(\'.otk-notification-settings input[name="notify.sound"]\').checked',
    );
    // A failed older intent cannot restore its captured value over a new broadcast.
    await b.click('.otk-notification-settings input[name="notify.sound"]');
    await b.poll("document.querySelector('[data-pending]').textContent==='1'");
    await b.click("[data-broadcast]");
    await b.click("[data-reject]");
    await b.poll(
      "document.querySelector('.otk-notification-settings input[name=\"notify.sound\"]').checked",
    );
    for (
      const [button, theme] of [["dark", "otk-dark"], ["light", "otk-light"]]
    ) {
      await b.click(`[data-${button}]`);
      await b.click("[data-display] button");
      await b.poll(
        "!!document.querySelector('.otk-popover-panel:popover-open')",
      );
      await capture(b, `${theme}-preferences`);
      await b.key("Escape");
    }
    try {
      assertEquals(b.errors, []);
    } catch (e) {
      failures.push(e);
    }
    if (failures.length) {
      throw new AggregateError(
        failures,
        "Native reconciliation / contributed groups",
      );
    }
  } finally {
    await f.close();
  }
});

test("both resize consumers guard readiness and own cancellation and pending final width", async () => {
  const f = await uiConsumer("?shared-controls"), b = f.browser;
  try {
    await b.poll("!!document.querySelector('.otk-inbox-resizer')");
    await b.click("[data-ready]");
    await b.evaluate(
      `(()=>{for(const s of ['.otk-inbox-resizer','.otk-panel-resizer']) document.querySelector(s).dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));})()`,
    );
    assertEquals(
      await b.evaluate("document.querySelector('[data-calls]').textContent"),
      "0",
      "unready columns cannot persist width",
    );
    await b.click("[data-ready]");
    for (
      const [selector, direction] of [[".otk-inbox-resizer", 1], [
        ".otk-panel-resizer",
        -1,
      ]] as const
    ) {
      const original = await b.evaluate<number>(
        `Number(document.querySelector('${selector}').getAttribute('aria-valuenow'))`,
      );
      const calls = await b.evaluate<number>(
        "Number(document.querySelector('[data-calls]').textContent)",
      );
      const begin = async () => {
        const point = await b.evaluate<{ x: number; y: number }>(
          `(()=>{const e=document.querySelector('${selector}');e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
        );
        await b.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          ...point,
          button: "left",
          buttons: 1,
          clickCount: 1,
        });
        return point;
      };
      const move = (point: { x: number; y: number }, delta: number) =>
        b.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: point.x + delta * direction,
          y: point.y,
          button: "left",
          buttons: 1,
        });
      const up = (point: { x: number; y: number }, delta: number) =>
        b.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: point.x + delta * direction,
          y: point.y,
          button: "left",
          buttons: 0,
          clickCount: 1,
        });
      for (const end of ["cancel", "lost", "unready"]) {
        const point = await begin();
        await move(point, 24);
        await b.poll(
          `document.querySelector('${selector}').getAttribute('aria-valuenow')==='${
            original + 24
          }'`,
        );
        if (end === "cancel") {
          await b.evaluate(
            `document.querySelector('${selector}').dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true}))`,
          );
        }
        if (end === "lost") {
          await b.evaluate(
            `document.querySelector('${selector}').releasePointerCapture(1)`,
          );
        }
        if (end === "unready") {
          await b.evaluate("document.querySelector('[data-ready]').click()");
        }
        await up(point, 24);
        await b.poll(
          `document.querySelector('${selector}').getAttribute('aria-valuenow')==='${original}'`,
        );
        assertEquals(
          await b.evaluate(
            "Number(document.querySelector('[data-calls]').textContent)",
          ),
          calls,
          end,
        );
        if (end === "unready") await b.click("[data-ready]");
      }
      const point = await begin();
      await move(point, 24);
      await up(point, 40);
      await b.poll(
        "document.querySelector('[data-pending]').textContent==='1'",
      );
      assertEquals(
        await b.evaluate(
          `Number(document.querySelector('${selector}').getAttribute('aria-valuenow'))`,
        ),
        original + 40,
        "pending width follows final pointer, not last painted move",
      );
      await b.evaluate(
        `document.querySelector('${selector}').dispatchEvent(new PointerEvent('pointerup',{pointerId:1,bubbles:true,clientX:999}))`,
      );
      assertEquals(
        await b.evaluate(
          "Number(document.querySelector('[data-calls]').textContent)",
        ),
        calls + 1,
        "one save per gesture",
      );
      await b.click("[data-reject]");
      await b.poll(
        `document.querySelector('${selector}').getAttribute('aria-valuenow')==='${original}'`,
      );
      await b.evaluate(
        `(()=>{const e=document.querySelector('${selector}');for(let i=0;i<2;i++)e.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',repeat:i>0,bubbles:true}))})()`,
      );
      await b.poll(
        "document.querySelector('[data-pending]').textContent==='2'",
      );
      assertEquals(
        await b.evaluate(
          `Number(document.querySelector('${selector}').getAttribute('aria-valuenow'))`,
        ),
        original + 16 * direction,
      );
      await b.click("[data-accept]");
      await b.poll(
        "document.querySelector('[data-pending]').textContent==='1'",
      );
      assertEquals(
        await b.evaluate(
          `Number(document.querySelector('${selector}').getAttribute('aria-valuenow'))`,
        ),
        original + 16 * direction,
        "older save cleanup cannot retire the newer intent",
      );
      await b.click("[data-accept]");
      await b.poll(
        "document.querySelector('[data-pending]').textContent==='0'",
      );
    }
    for (
      const [selector, width] of [[".otk-inbox-resizer", 360], [
        ".otk-panel-resizer",
        480,
      ]] as const
    ) {
      await b.evaluate(
        `document.querySelector('${selector}').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))`,
      );
      await b.poll(
        "document.querySelector('[data-pending]').textContent==='1'",
      );
      await b.click("[data-accept]");
      await b.poll(
        `document.querySelector('${selector}').getAttribute('aria-valuenow')==='${width}'`,
      );
    }
    assertEquals(b.errors, []);
  } finally {
    await f.close();
  }
});

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
      // Capture blurs the input for stable pixels; keyboard interaction is refocused explicitly.
      await b.click("textarea[name=prompt]");
      await b.key("ArrowDown");
      await b.key("Enter");
      await b.poll(
        "document.querySelector('textarea[name=prompt]').value==='Second option'",
      );
      await b.fill("textarea[name=prompt]", "@");
      await b.poll(
        "document.querySelectorAll('.otk-autocomplete button').length===2",
      );
      await b.click(".otk-autocomplete button:first-child");
      await b.poll(
        "document.querySelector('textarea[name=prompt]').value==='First option'",
      );
      await b.key("Escape");
      await b.fill("textarea[name=prompt]", "");
    }
    await b.fill("textarea[name=question-answer]", "Short answer");
    const shrunk = await b.evaluate<number>(
      "document.querySelector('textarea[name=question-answer]').clientHeight",
    );
    assert(shrunk <= 24, `own answer shrinks with its value: ${shrunk}`);
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

test("preference controls remain authoritative while pending, reject unready intent and accept injected settings", async () => {
  const f = await uiConsumer("?shared-controls"), b = f.browser;
  try {
    await b.poll(
      "!!document.querySelector('.otk-visual-settings input[name=\"consumer.appearance\"]')",
    );
    const field = '.otk-visual-settings input[name="consumer.appearance"]';
    await b.click(field);
    await b.poll("document.querySelector('[data-pending]').textContent==='1'");
    assertEquals(
      await b.evaluate(`document.querySelector('${field}').checked`),
      false,
    );
    await b.click("[data-accept]");
    await b.poll(`document.querySelector('${field}').checked`);
    await b.click("[data-ready]");
    const calls = await b.evaluate(
      "document.querySelector('[data-calls]').textContent",
    );
    await b.click(field);
    await b.poll(
      "document.querySelector('.otk-visual-settings [role=alert]')?.textContent==='Preferences are not ready yet'",
    );
    assertEquals(
      await b.evaluate(`document.querySelector('${field}').checked`),
      true,
    );
    assertEquals(
      await b.evaluate("document.querySelector('[data-calls]').textContent"),
      calls,
    );
    assertEquals(
      await b.evaluate(
        "!!document.querySelector('.otk-visual-settings :disabled')",
      ),
      false,
    );
    assertEquals(b.errors, []);
  } finally {
    await f.close();
  }
});
