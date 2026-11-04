// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { resources, test } from "../support/resources.ts";
import { serve } from "../support/http.ts";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { consumerAssets } from "../support/consumer-builds.ts";

async function consumer(
  scene: string,
  run: (browser: Cdp, root: string) => Promise<void>,
) {
  const root = await fixture(), dist = await consumerAssets("styles");
  const server = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const name = new URL(request.url).pathname;
      const path = join(dist, name === "/" ? "index.html" : name);
      try {
        return new Response(await Deno.readFile(path), {
          headers: {
            "content-type": path.endsWith(".js")
              ? "text/javascript"
              : path.endsWith(".css")
              ? "text/css"
              : path.endsWith(".woff2")
              ? "font/woff2"
              : "text/html",
          },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  );
  resources().defer("component style server", () => server.shutdown());
  const browser = await Cdp.launch(root);
  try {
    await browser.goto(`http://127.0.0.1:${server.addr.port}/?scene=${scene}`);
    try {
      await browser.poll("document.documentElement.dataset.ready==='true'");
    } catch (cause) {
      console.error("Component consumer startup errors:", browser.errors);
      throw cause;
    }
    const failures: unknown[] = [];
    for (const theme of ["otk-dark", "otk-light"]) {
      await browser.evaluate(`styleTest.theme('${theme}')`);
      if (scene === "preference-feedback") {
        await browser.click(`[data-theme-choice="${theme}"]`);
      }
      await browser.poll(
        `document.documentElement.dataset.otkTheme==='${theme}'`,
      );
      await browser.evaluate(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
      try {
        await run(browser, root);
      } catch (error) {
        failures.push(error);
      }
      // Capture the same state on red and green trees, even after an assertion.
      await browser.evaluate(
        "document.body.className='';delete document.body.dataset.rightCollapsed;styleTest.conceal(false);styleTest.reserve(true);styleTest.collapse(true)",
      );
      await browser.evaluate(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
      await browser.screenshot(join(root, `${scene}-${theme}.png`));
    }
    assertEquals(browser.errors, []);
    console.info("B2 full screenshots:", root, scene);
    if (failures.length) {
      throw new AggregateError(failures, "Component style assertions failed");
    }
  } finally {
    await browser.close();
  }
}

// C13 owns component lifetimes, callbacks, native semantics and feedback focus.
// These remaining scenes retain the original per-theme geometry and paint.
test("theme and keymap saves share reserved pending/failure tracks with no disabled actions", () =>
  consumer("preference-feedback", async (browser, root) => {
    await browser.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const surface of ["theme", "keys"]) {
      const selector = `[data-preference-surface=${surface}]`;
      const before = await browser.evaluate<number[]>(
        `(() => {const r=document.querySelector('${selector}').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()`,
      );
      const label = surface === "theme" ? "Save theme" : "Reset all shortcuts";
      await browser.evaluate(
        `[...document.querySelectorAll('${selector} button')].find(button=>button.textContent.trim()==='${label}').setAttribute('data-feedback-save','true')`,
      );
      const button = `${selector} [data-feedback-save]`;
      try {
        await browser.click(button);
        await browser.evaluate(
          "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
        );
        assertEquals(
          await browser.evaluate(
            `document.querySelector('${selector}').querySelectorAll('[disabled],[aria-disabled=true]').length`,
          ),
          0,
        );
        await browser.poll(
          `!!document.querySelector('${selector} [role=status]')?.textContent`,
        );
        await browser.poll(
          "document.activeElement?.getAttribute('role')==='status'",
        );
        await browser.evaluate("styleTest.settlePreference()");
        await browser.poll(
          `!!document.querySelector('${selector} [role=alert]')?.textContent`,
        );
        assertEquals(
          await browser.evaluate(
            `(() => {const r=document.querySelector('${selector}').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()`,
          ),
          before,
        );
        const theme = await browser.evaluate<string>(
          "document.documentElement.dataset.otkTheme",
        );
        await browser.screenshot(
          join(root, `${surface}-feedback-${theme}.png`),
        );
      } finally {
        await browser.evaluate(
          "styleTest.settlePreference();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
        );
      }
    }
  }));

test("shipped Form captures once, retains readonly values and stable feedback geometry without disabled controls", () =>
  consumer("forms", async (browser) => {
    const before = await browser.evaluate<number[]>(
      `(() => {const r=document.querySelector('.otk-form').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()`,
    );
    const calls = await browser.evaluate<number>(
      "Number(document.querySelector('[data-form-calls]').dataset.formCalls)",
    );
    await browser.evaluate(
      "document.querySelector('form').requestSubmit();document.querySelector('form').requestSubmit()",
    );
    await browser.poll(
      `Number(document.querySelector('[data-form-calls]').dataset.formCalls)===${
        calls + 1
      }`,
    );
    const pending = await browser.evaluate<
      { disabled: number; readonly: boolean; value: string; bounds: number[] }
    >(`(() => {const f=document.querySelector('.otk-form'),r=f.getBoundingClientRect(),i=f.querySelector('input');return {disabled:f.querySelectorAll('[disabled],[aria-disabled="true"]').length,readonly:i.readOnly,value:i.value,bounds:[r.x,r.y,r.width,r.height]}})()`);
    await browser.evaluate("styleTest.feedback('error')");
    await browser.poll("!!document.querySelector('[role=alert]')?.textContent");
    const after = await browser.evaluate<number[]>(
      `(() => {const r=document.querySelector('.otk-form').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()`,
    );
    assertEquals(pending.disabled, 0);
    assert(pending.readonly);
    assertEquals(pending.value, "perf");
    assertEquals(pending.bounds, before);
    assertEquals(after, before);
    assertEquals(
      await browser.evaluate(
        "document.body.textContent.includes('/secret/path')",
      ),
      false,
    );
    assertEquals(
      await browser.evaluate("document.querySelector('input').readOnly"),
      false,
    );
  }));

test("every native form field shares captured feedback tracks and retains accessible descriptions", () =>
  consumer("forms", async (browser, root) => {
    for (const name of ["notes", "kind"]) {
      const selector = name === "notes"
        ? 'textarea[name="notes"]'
        : 'select[name="kind"]';
      const before = await browser.evaluate<number[]>(
        `(() => {const r=document.querySelector('.otk-form').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()`,
      );
      await browser.click(".otk-form button[type=submit]");
      await browser.poll(
        "document.querySelector('.otk-form').getAttribute('aria-busy')==='true'",
      );
      await browser.poll(
        "document.activeElement?.getAttribute('role')==='status'",
      );
      assertEquals(
        await browser.evaluate("document.querySelector('textarea').readOnly"),
        true,
      );
      assertEquals(
        await browser.evaluate(
          "document.querySelector('.otk-form-choice-value').value",
        ),
        "Alpha",
      );
      await browser.evaluate(`styleTest.fieldFailure('${name}')`);
      await browser.poll(
        `document.querySelector('${selector}').getAttribute('aria-invalid')==='true'`,
      );
      const description = await browser.evaluate<
        { ids: string[]; errors: number; text: string }
      >(`(() => {const f=document.querySelector('${selector}'),ids=f.getAttribute('aria-describedby').split(' ');return {ids,errors:ids.map(id=>document.getElementById(id)).filter(e=>e?.getAttribute('role')==='alert').length,text:document.querySelector('[role=alert]').textContent}})()`);
      assertEquals(description.errors, 1);
      if (name === "notes") assert(description.ids.includes("notes-help"));
      assertEquals(description.text, "Could not finish this action. Try again");
      assertEquals(
        await browser.evaluate(
          `(() => {const r=document.querySelector('.otk-form').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()`,
        ),
        before,
      );
      assertEquals(
        await browser.evaluate("document.querySelector('textarea').value"),
        "Keep this text",
      );
      const theme = await browser.evaluate<string>(
        "document.documentElement.dataset.otkTheme",
      );
      await browser.screenshot(join(root, `field-${name}-${theme}.png`));
    }
  }));

test("command menu pending slots keep geometry and visible focus, then expose one reserved safe failure", () =>
  consumer("lists", async (browser, root) => {
    await browser.evaluate("styleTest.holdMenu(true)");
    await browser.click('button[aria-label="Reactive list menu"]');
    await browser.poll(
      "!!document.querySelector(':popover-open [data-context-command=\"list.one\"]')",
    );
    const before = await browser.evaluate<number[]>(
      `(() => {const r=document.querySelector(':popover-open').getBoundingClientRect();return [r.width,r.height]})()`,
    );
    await browser.evaluate(
      "document.querySelector('[data-context-command=\"list.one\"]').focus()",
    );
    await browser.key("Enter");
    await browser.poll(
      "!!document.querySelector(':popover-open [role=status]')?.textContent",
    );
    const pending = await browser.evaluate<
      {
        bounds: number[];
        visibleActions: number;
        focus: boolean;
        disabled: number;
      }
    >(`(() => {const p=document.querySelector(':popover-open'),r=p.getBoundingClientRect(),s=p.querySelector('[role=status]');return {bounds:[r.width,r.height],visibleActions:[...p.querySelectorAll('[role=menuitem]')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden').length,focus:document.activeElement===s,disabled:p.querySelectorAll('[disabled],[aria-disabled=true]').length}})()`);
    assertEquals(pending.bounds, before);
    assertEquals(pending.visibleActions, 0);
    assert(pending.focus);
    assertEquals(pending.disabled, 0);
    const theme = await browser.evaluate<string>(
      "document.documentElement.dataset.otkTheme",
    );
    await browser.screenshot(join(root, `menu-pending-${theme}.png`));
    await browser.evaluate("styleTest.settleMenu(true)");
    await browser.poll(
      "!!document.querySelector(':popover-open [role=alert]')?.textContent",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector(':popover-open [role=alert]').textContent",
      ),
      "Could not finish this action. Try again",
    );
    assertEquals(
      await browser.evaluate(
        `(() => {const r=document.querySelector(':popover-open').getBoundingClientRect();return [r.width,r.height]})()`,
      ),
      before,
    );
    await browser.poll(
      "document.activeElement?.dataset.contextCommand==='list.one'",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelectorAll(':popover-open [role=alert]').length",
      ),
      1,
    );
    await browser.screenshot(join(root, `menu-error-${theme}.png`));
    await browser.key("Escape");
    await browser.poll("!document.querySelector(':popover-open')");
    await browser.evaluate("styleTest.holdMenu(false)");
  }));
