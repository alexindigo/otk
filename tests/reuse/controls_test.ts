// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { test } from "../support/resources.ts";
import { uiConsumer } from "../support/ui-consumer.ts";
import type { Cdp } from "../support/cdp.ts";

async function capture(b: Cdp, name: string) {
  const dir = Deno.env.get("OTK_REMAINING_SHOTS");
  if (dir) {
    await Deno.mkdir(dir, { recursive: true });
    await b.screenshot(join(dir, `${name}.png`));
  }
}
async function icons(b: Cdp) {
  const result = await b.evaluate<{ count: number; gaps: number[][] }>(
    `(()=>{const controls=[...document.querySelectorAll('.otk-select select, .otk-control-trigger')].filter(e=>e.getBoundingClientRect().width&&getComputedStyle(e).visibility!=='hidden');return {count:controls.length,gaps:controls.map(control=>{const owner=control.matches('select')?control.parentElement:control,icon=owner.querySelector('.otk-control-accessory svg'),r=control.getBoundingClientRect(),s=getComputedStyle(control),i=icon.getBoundingClientRect();return [i.top-r.top-parseFloat(s.borderTopWidth),r.bottom-i.bottom-parseFloat(s.borderBottomWidth),r.right-i.right-parseFloat(s.borderRightWidth)]})}})()`,
  );
  assert(result.count >= 2, JSON.stringify(result));
  for (const gaps of result.gaps) {
    assert(Math.max(...gaps) - Math.min(...gaps) <= 1, JSON.stringify(result));
  }
}

test("controls: setup column, conditional captured credentials and uniform accessory slots", async () => {
  const f = await uiConsumer("?layout-controls"), b = f.browser;
  try {
    await b.poll("!!document.querySelector('select[name=type]')");
    for (const theme of ["dark", "light"]) {
      await b.click(`[data-${theme}]`);
      for (const zoom of [1, 2]) {
        for (const physicalWidth of [600, 800, 1280, 1920]) {
          const width = physicalWidth / zoom;
          await b.send("Emulation.setDeviceMetricsOverride", {
            width,
            height: 1000 / zoom,
            deviceScaleFactor: zoom,
            mobile: false,
          });
          await b.evaluate(
            "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
          );
          const g = await b.evaluate<
            {
              centre: number;
              edges: number[];
              headings: number;
              heights: number[];
            }
          >(`(()=>{const pane=document.querySelector('[data-auth-pane]'),form=pane.querySelector('form'),heading=pane.querySelector('h1,h2'),description=heading.nextElementSibling,r=pane.getBoundingClientRect(),f=form.getBoundingClientRect();return {centre:Math.abs((f.left+f.right-r.left-r.right)/2),edges:[heading,description,form,...form.querySelectorAll('input:not(.otk-form-choice-value),select')].map(e=>e.getBoundingClientRect().left),headings:pane.querySelectorAll('h1,h2').length,heights:[...form.querySelectorAll('input:not(.otk-form-choice-value),select')].map(e=>e.getBoundingClientRect().height)}})()`);
          assert(g.centre <= 1, JSON.stringify(g));
          assert(
            Math.max(...g.edges) - Math.min(...g.edges) <= 1,
            JSON.stringify(g),
          );
          assertEquals(g.headings, 1);
          assert(
            g.heights.every((h) => h === 32),
            JSON.stringify(g),
          );
          await icons(b);
          console.info("Setup geometry", { theme, physicalWidth, zoom, ...g });
        }
      }
      await b.send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await capture(b, `setup-password-${theme}`);
      await b.fill("input[name=username]", "Retained user");
      await b.fill("input[name=password]", "Retained password");
      await b.evaluate(
        "(()=>{const s=document.querySelector('select[name=type]');s.value='none';s.dispatchEvent(new Event('change',{bubbles:true}))})()",
      );
      await b.poll(
        "!document.querySelector('[data-auth-pane] input[name=username]')",
      );
      await capture(b, `setup-none-${theme}`);
      await b.click("[data-auth-pane] button[type=submit]");
      await b.poll(
        "document.querySelector('[data-payload]').textContent.includes('none')",
      );
      assertEquals(
        await b.evaluate(
          "JSON.parse(document.querySelector('[data-payload]').textContent)",
        ),
        { type: "none", username: "", password: "" },
      );
      await b.click("[data-reject]");
      await b.poll(
        "!document.querySelector('[data-auth-pane] form[aria-busy=true]')",
      );
      await b.evaluate(
        "(()=>{const s=document.querySelector('select[name=type]');s.value='password';s.dispatchEvent(new Event('change',{bubbles:true}))})()",
      );
      await b.poll(
        "document.querySelector('input[name=username]')?.value==='Retained user'",
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('input[name=password]').value",
        ),
        "Retained password",
      );
    }
    assertEquals(b.errors, []);
  } finally {
    await f.close();
  }
});

test("controls: automatic Diff uses its own measured width, independent of ancestor hints", async () => {
  const f = await uiConsumer("?layout-controls"), b = f.browser;
  try {
    await b.send("Emulation.setDeviceMetricsOverride", {
      width: 1920,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await b.poll(
      "!!document.querySelector('[data-independent-diff] .otk-diff')",
    );
    const actual = await b.evaluate<{ width: number; mode: string }>(
      "(()=>{const e=document.querySelector('[data-independent-diff] .otk-diff');return {width:e.getBoundingClientRect().width,mode:e.dataset.diffStyle}})()",
    );
    assertEquals(actual, { width: 800, mode: "unified" });
    for (const theme of ["dark", "light"]) {
      await b.click(`[data-${theme}]`);
      await capture(b, `diff-unified-${theme}`);
    }
    await b.click("[data-wide-diff]");
    await b.poll(
      "document.querySelector('[data-independent-diff] .otk-diff').dataset.diffStyle==='split'",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('[data-independent-diff] .otk-diff').getBoundingClientRect().width",
      ),
      1300,
    );
    for (const theme of ["dark", "light"]) {
      await b.click(`[data-${theme}]`);
      await capture(b, `diff-split-${theme}`);
    }
    assertEquals(b.errors, []);
  } finally {
    await f.close();
  }
});

test("controls: dialog pending and rejected action preserve form geometry and focus", async () => {
  const f = await uiConsumer("?layout-controls"), b = f.browser;
  try {
    await b.poll("!!document.querySelector('[data-task]')");
    for (const theme of ["dark", "light"]) {
      await b.click(`[data-${theme}]`);
      await b.click("[data-task]");
      await b.poll(
        "!!document.querySelector('dialog[open] input[name=taskName]')",
      );
      await b.fill("input[name=taskName]", "Retained task name");
      const box = () =>
        b.evaluate<number[]>(
          "['dialog[open] h2','dialog[open] input[name=taskName]','dialog[open] .otk-action-slot'].flatMap(s=>{const r=document.querySelector(s).getBoundingClientRect();return [r.x,r.y,r.width,r.height]})",
        );
      const idle = await box();
      await capture(b, `task-consumer-idle-${theme}`);
      await b.click("dialog[open] button[type=submit]");
      await b.poll(
        "!!document.querySelector('dialog[open] form[aria-busy=true]')",
      );
      const pending = await box();
      assert(
        pending.every((v, i) => Math.abs(v - idle[i]) <= 1),
        JSON.stringify({ idle, pending }),
      );
      await capture(b, `task-pending-${theme}`);
      // C12 owns pending control/focus and retained-form behavior in Playwright.
      // Keep only these fixed per-theme geometry and semantic danger states.
      // Fixture settlement models a server outcome, not an action through the modal.
      await b.evaluate("document.querySelector('[data-reject]').click()");
      await b.poll("!!document.querySelector('dialog[open] [role=alert]')");
      const error = await box();
      assert(
        error.every((v, i) => Math.abs(v - idle[i]) <= 1),
        JSON.stringify({ idle, error }),
      );
      assertEquals(
        await b.evaluate(
          "document.querySelectorAll('dialog[open] [role=alert]').length",
        ),
        1,
      );
      assertEquals(
        await b.evaluate(
          "getComputedStyle(document.querySelector('dialog[open] [role=alert]')).color",
        ),
        theme === "dark" ? "rgb(255, 128, 128)" : "rgb(181, 20, 26)",
        "Dialog failures use semantic danger, independently of primary action paint",
      );
      await capture(b, `task-error-${theme}`);
      await b.key("Escape");
    }
    assertEquals(b.errors, []);
  } finally {
    await f.close();
  }
});

for (const theme of ["dark", "light"]) {
  test(`controls: required chip editor preserves node and focus across30 typed characters and resizing (${theme})`, async () => {
    const f = await uiConsumer("?layout-tabs"), b = f.browser;
    try {
      await b.poll("!!document.querySelector('[data-crumb]')");
      await b.click(`[data-theme-${theme}]`);
      await b.click("[data-edit-chip]");
      await b.poll(
        "!!document.querySelector('input[aria-label=" +
          JSON.stringify("Rename session") + "]')",
      );
      const initial = await b.evaluate<
        { input: number[]; lane: number[]; inside: boolean }
      >("(()=>{const i=document.querySelector('input[aria-label=\"Rename session\"]').getBoundingClientRect(),r=document.querySelector('.otk-breadcrumb-row').getBoundingClientRect();return {input:[i.top,i.bottom],lane:[r.top,r.bottom],inside:i.top>=r.top-1&&i.bottom<=r.bottom+1}})()");
      assert(initial.inside, JSON.stringify(initial));
      await b.evaluate(
        "globalThis.retainedEditor=document.querySelector('input[aria-label=\"Rename session\"]')",
      );
      await b.click('input[aria-label="Rename session"]');
      const identity = () =>
        b.evaluate<{ same: boolean; focus: boolean; value: string }>(
          "({same:retainedEditor.isConnected&&retainedEditor===document.querySelector('input[aria-label=\"Rename session\"]'),focus:document.activeElement===retainedEditor,value:retainedEditor.value})",
        );
      const clicked = await identity();
      assert(clicked.same && clicked.focus, JSON.stringify(clicked));
      await b.key("a", 2);
      const text = "abcdefghijklmnopqrstuvwxyz1234";
      for (let i = 0; i < text.length; i++) {
        await b.send("Input.insertText", { text: text[i] });
        await b.evaluate(
          "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
        );
        assertEquals(await identity(), {
          same: true,
          focus: true,
          value: text.slice(0, i + 1),
        }, `Character ${i + 1}`);
      }
      for (const width of [600, 800, 1280, 1920, 600]) {
        await b.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 800,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await b.evaluate(
          "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
        );
        const g = await b.evaluate<
          {
            inside: boolean;
            same: boolean;
            selected: boolean;
            feedbackVisible: boolean;
          }
        >(`(()=>{const input=document.querySelector('input[aria-label="Rename session"]'),row=document.querySelector('.otk-breadcrumb-row'),r=row.getBoundingClientRect(),i=input.getBoundingClientRect(),feedback=document.getElementById(input.getAttribute('aria-describedby')),f=feedback.getBoundingClientRect();return {inside:i.top>=r.top-1&&i.bottom<=r.bottom+1,same:input===globalThis.retainedEditor&&input===document.activeElement&&input.value==='${text}',selected:!!document.querySelector('[data-crumb="tstv1-independent-6"]'),feedbackVisible:f.top>=r.bottom-1&&f.height>=20}})()`);
        assert(
          g.inside && g.same && g.selected && g.feedbackVisible,
          JSON.stringify({ width, g }),
        );
      }
      await b.key("Enter");
      await b.poll(
        "document.querySelector('input[aria-label=\"Rename session\"]').readOnly",
      );
      await capture(b, `chip-editor-pending-${theme}`);
      await b.evaluate("document.querySelector('[data-reject-chip]').click()");
      await b.poll("!!document.querySelector('[role=alert]')");
      assertEquals(
        await b.evaluate(
          "document.querySelector('input[aria-label=\"Rename session\"]').value",
        ),
        text,
      );
      await capture(b, `chip-editor-error-${theme}`);
      assert(
        await b.evaluate(
          "(()=>{const e=document.querySelector('[role=alert]'),r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('[role=alert]')===e})()",
        ),
        "Failed rename feedback is painted below the chip lane",
      );
      assertEquals(b.errors, []);
    } finally {
      await f.close();
    }
  });
}
