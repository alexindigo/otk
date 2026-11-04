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
test("joined notice publications retain disclosure state, DOM identity and the available Restore action", () =>
  consumer("notice-lifetime", async (browser) => {
    // Keep this scene's fixed paint without replaying publication/lifetime work.
    await browser.evaluate("styleTest.resetNotice();styleTest.settleNotice()");
    if (
      await browser.evaluate(
        "document.querySelector('.otk-rollback-disclosure')?.getAttribute('aria-expanded')!=='true'",
      )
    ) await browser.click(".otk-rollback-disclosure");
    await browser.poll(
      "document.querySelector('.otk-rollback-disclosure')?.getAttribute('aria-expanded')==='true'&&!!document.querySelector('.otk-rollback-footer button')",
    );
  }));

test("feedback bindings release replaced owners and remount the original target's retained feedback", () =>
  consumer("feedback-owners", async (browser) => {
    // The replacement-owner scene remains in the visual remainder until T3.
    await browser.evaluate(
      "styleTest.mountFeedback(true);styleTest.feedbackOwner(1);styleTest.emitFeedback(1,'connection')",
    );
    await browser.poll(
      "document.querySelector('.is-reconnecting')?.textContent==='Replacement target'",
    );
  }));

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

test("request feedback reserves form geometry, shares notice centrelines and centres the transcript state in Dark and Linen", () =>
  consumer("requests", async (browser, root) => {
    const theme = await browser.evaluate<string>(
      "document.documentElement.dataset.otkTheme",
    );
    for (const width of [1280, 800]) {
      await browser.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 700,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const bounds: unknown[] = [];
      for (const state of ["clear", "pending", "error"]) {
        await browser.evaluate(`styleTest.feedback('${state}')`);
        await browser.evaluate(
          "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
        );
        const probe = await browser.evaluate<{
          field: number[];
          track: number[];
          disabled: number;
          colour: string;
          danger: string;
          focus: string;
          pane: number[];
          content: number[];
          rowCentres: number[];
        }>(`(() => {
          const rect = el => { const r = el.getBoundingClientRect(); return [r.x,r.y,r.width,r.height]; };
          const field = document.querySelector('.request-feedback-form input');
          const pane = document.querySelector('.request-feedback-pane');
          const items = [...pane.querySelectorAll('p,button')].map(el=>el.getBoundingClientRect());
          const left=Math.min(...items.map(r=>r.left)), right=Math.max(...items.map(r=>r.right)), top=Math.min(...items.map(r=>r.top)), bottom=Math.max(...items.map(r=>r.bottom));
          const operation=document.querySelector('.otk-operation-feedback');
          return { field:rect(field), track:rect(document.querySelector('#task-feedback')),
            disabled:document.querySelectorAll('[disabled],[aria-disabled="true"]').length,
            colour:getComputedStyle(operation).color,
            danger:getComputedStyle(document.documentElement).getPropertyValue('--otk-danger').trim(),
            focus:getComputedStyle(document.documentElement).getPropertyValue('--otk-focus').trim(),
            pane:rect(pane), content:[left,top,right-left,bottom-top],
            rowCentres:[...operation.children].map(el=>{const r=el.getBoundingClientRect();return r.y+r.height/2;}) };
        })()`);
        bounds.push({ field: probe.field, track: probe.track });
        assertEquals(probe.disabled, 0);
        assert(
          Math.abs(
            probe.pane[0] + probe.pane[2] / 2 - probe.content[0] -
              probe.content[2] / 2,
          ) < 1,
        );
        assert(
          Math.abs(
            probe.pane[1] + probe.pane[3] / 2 - probe.content[1] -
              probe.content[3] / 2,
          ) < 1,
        );
        assert(
          Math.max(...probe.rowCentres) - Math.min(...probe.rowCentres) < 1,
        );
        if (state === "error") {
          assert(probe.danger !== probe.focus);
          assertEquals(
            probe.colour,
            theme === "otk-dark" ? "rgb(255, 128, 128)" : "rgb(181, 20, 26)",
          );
        }
      }
      assertEquals(bounds[0], bounds[1]);
      assertEquals(bounds[1], bounds[2]);
      if (width === 1280) {
        await browser.screenshot(join(root, `requests-wide-${theme}.png`));
      }
    }
    for (const region of ["form", "notice", "pane"]) {
      const clip = await browser.evaluate<
        { x: number; y: number; width: number; height: number }
      >(`(() => { const r=document.querySelector('[data-feedback-region="${region}"]').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`);
      const result = await browser.send("Page.captureScreenshot", {
        format: "png",
        clip: { ...clip, scale: 2 },
      }) as { data: string };
      await Deno.writeFile(
        join(root, `review-requests-${theme}-${region}.png`),
        Uint8Array.from(atob(result.data), (value) => value.charCodeAt(0)),
      );
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

test("Blocks owns prose and concealment equally standalone, in reasoning and as a text part", () =>
  consumer("prose", async (browser) => {
    await browser.evaluate("styleTest.conceal(false)");
    const values = await browser.evaluate<
      {
        font: string;
        line: string;
        code: string;
        mark: string;
        nested: string;
        pre: string;
      }[]
    >(`['standalone','reasoning','textpart'].map(id=>{const root=document.getElementById(id),p=root.querySelector('p'),code=p.querySelector('code'),strong=p.querySelector('strong');return {font:getComputedStyle(p).fontSize,line:getComputedStyle(p).lineHeight,code:getComputedStyle(code).backgroundColor,mark:getComputedStyle(strong,'::before').content,nested:getComputedStyle(root.querySelector('blockquote')).borderLeftWidth,pre:getComputedStyle(root.querySelector('pre')).lineHeight}})`);
    for (const value of values) {
      assertEquals(value.font, "14px");
      assertEquals(value.line, "24px");
      assertEquals(value.mark, '"**"');
      assertEquals(value.nested, "2px");
      assertEquals(value.pre, "20px", "Prose must not restyle Code internals");
    }
    assertEquals(values[0], values[1]);
    assertEquals(values[0], values[2]);
    assertEquals(
      await browser.evaluate(
        "getComputedStyle(document.querySelector('#standalone pre'),'::before').content",
      ),
      '"```"',
    );
    await browser.evaluate(
      "styleTest.conceal(true);document.body.classList.add('otk-unconcealed')",
    );
    await browser.poll(
      "getComputedStyle(document.querySelector('#standalone strong'),'::before').content==='none'",
    );
    assertEquals(
      await browser.evaluate(
        "getComputedStyle(document.querySelector('#textpart strong'),'::before').content",
      ),
      "none",
      "Consumer ancestor must not override explicit concealment",
    );
    assertEquals(
      await browser.evaluate(
        "getComputedStyle(document.querySelector('#standalone pre'),'::before').content",
      ),
      "none",
    );
    await browser.evaluate(
      "document.body.classList.remove('otk-unconcealed');styleTest.conceal(false)",
    );
  }));

test("PermissionActivity preserves the independent summary file and scope list geometry", () =>
  consumer("journal", async (browser) => {
    await browser.evaluate(
      "document.querySelectorAll('.otk-permission-patterns').forEach(el=>el.open=true)",
    );
    const values = await browser.evaluate<string[][]>(
      `['summary','activity'].map(id=>[...document.getElementById(id).querySelectorAll('.otk-permission-summary li')].map(el=>{const s=getComputedStyle(el);return [s.display,s.paddingBottom,s.borderBottomWidth,s.flexDirection,s.listStyleType,el.getBoundingClientRect().height].join('|')}))`,
    );
    assertEquals(
      values[1],
      values[0],
      "Journal entry paint leaked into PermissionSummary",
    );
    assertEquals(values[0].length, 4);
  }));

test("WorkLog Settings RolledBackStrip and empty Sidebar own their styles without sibling renderers", () =>
  consumer("siblings", async (browser) => {
    assertEquals(
      await browser.evaluate(
        "document.querySelector('.otk-rollback-disclosure').getAttribute('aria-expanded')",
      ),
      "false",
    );
    await browser.click(".otk-rollback-disclosure");
    await browser.poll(
      "document.querySelector('.otk-rollback-disclosure').getAttribute('aria-expanded')==='true' && document.querySelectorAll('.otk-rollback-file').length===1",
    );
    const colors = await browser.evaluate<string[]>(
      "['.otk-path','.otk-diff-add','.otk-diff-del'].map(selector=>getComputedStyle(document.querySelector('.otk-rollback-file '+selector)).color)",
    );
    assertEquals({
      work: await browser.evaluate(
        "getComputedStyle(document.querySelector('.otk-work-fold')).display",
      ),
      header: await browser.evaluate(
        "getComputedStyle(document.querySelector('.otk-view-header')).display",
      ),
      empty: await browser.evaluate(
        "getComputedStyle(document.querySelector('.otk-empty')).padding",
      ),
      additions: colors[1] !== colors[0],
      deletions: colors[2] !== colors[0],
    }, {
      work: "flex",
      header: "flex",
      empty: "12px",
      additions: true,
      deletions: true,
    });
    await browser.click(".otk-work-fold");
    await browser.poll("!document.querySelector('.otk-work-body')");
    await browser.click(".otk-work-fold");
    await browser.poll("!document.querySelector('.otk-work-body').hidden");
    await browser.click(".otk-rollback-disclosure");
    await browser.poll(
      "document.querySelector('.otk-rollback-disclosure').getAttribute('aria-expanded')==='false' && !document.querySelector('.otk-rollback-file')",
    );
  }));
