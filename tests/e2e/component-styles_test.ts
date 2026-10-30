// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { resources, test } from "../support/resources.ts";
import { serve } from "../support/http.ts";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";

async function consumer(
  scene: string,
  run: (browser: Cdp, root: string) => Promise<void>,
) {
  const root = await fixture(), dist = join(root, "dist");
  const build = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "npm:vite@8.2.0",
      "build",
      "--config",
      "packages/ui/tests/style-consumer/vite.config.ts",
      "--outDir",
      dist,
      "--logLevel",
      "warn",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(build.code, 0, new TextDecoder().decode(build.stderr));
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
    await browser.poll("document.documentElement.dataset.ready==='true'");
    const failures: unknown[] = [];
    for (const theme of ["otk-dark", "otk-light"]) {
      await browser.evaluate(`styleTest.theme('${theme}')`);
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

test("keyed breadcrumbs and menu rows retain identity through folding, replacement and shrinking", () =>
  consumer("lists", async (browser) => {
    const ids = Array.from({ length: 10 }, (_, i) => `session-${i}`);
    await browser.evaluate(
      `styleTest.lists(${JSON.stringify(ids)},'session-4','session-7')`,
    );
    await browser.poll(
      "document.querySelector('[data-crumb=\"session-7\"] input')?.value==='session-7'",
    );
    assertEquals(
      await browser.evaluate(
        "[...document.querySelectorAll('[data-crumb]')].map(el=>el.dataset.crumb)",
      ),
      [
        "session-0",
        "session-1",
        "session-3",
        "session-4",
        "session-5",
        "session-7",
        "session-8",
        "session-9",
      ],
    );
    await browser.evaluate("styleTest.lists(['replacement'],'replacement')");
    await browser.poll(
      "document.querySelectorAll('[data-crumb]').length===1 && !!document.querySelector('[data-crumb=\"replacement\"]')",
    );
    await browser.evaluate("styleTest.lists([])");
    await browser.poll("document.querySelectorAll('[data-crumb]').length===0");
    await browser.evaluate(
      `styleTest.lists(${JSON.stringify(ids.slice().reverse())},'session-4')`,
    );
    await browser.poll(
      "!!document.querySelector('[data-crumb=\"session-4\"]')",
    );
    await browser.click('button[aria-label="Reactive list menu"]');
    await browser.poll(
      "document.querySelectorAll(':popover-open [role=menuitem]').length===3",
    );
    await browser.evaluate("styleTest.menuItems(['delete'])");
    await browser.poll(
      "document.querySelectorAll(':popover-open [role=menuitem]').length===1",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector(':popover-open [role=menuitem]').dataset.contextCommand",
      ),
      "list.delete",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelectorAll(':popover-open [role=group] [role=separator]').length",
      ),
      1,
    );
    await browser.evaluate("styleTest.menuItems(['one','two','delete'])");
    await browser.poll(
      "document.querySelectorAll(':popover-open [role=menuitem]').length===3",
    );
    await browser.key("Escape");
    await browser.evaluate("styleTest.lists([])");
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

test("ProjectTabs layout is input-owned and collapsed inbox hides only its label", () =>
  consumer("chrome", async (browser) => {
    const padding = () =>
      browser.evaluate<string>(
        "getComputedStyle(document.querySelector('.otk-task-strip')).paddingRight",
      );
    await browser.evaluate(
      "styleTest.reserve(false);styleTest.collapse(false)",
    );
    const normal = await padding();
    await browser.evaluate(
      "document.body.className='otk-app';document.body.dataset.rightCollapsed='true'",
    );
    assertEquals(
      await padding(),
      normal,
      "ProjectTabs reads its consumer's state",
    );
    await browser.evaluate(
      "document.body.className='';styleTest.reserve(true)",
    );
    await browser.poll(
      "getComputedStyle(document.querySelector('.otk-task-strip')).paddingRight!=='12px'",
    );
    const reserved = await padding();
    assert(reserved !== normal);
    await browser.evaluate("styleTest.collapse(true)");
    await browser.poll(
      "document.querySelector('.otk-project-inbox').dataset.collapsed==='true'",
    );
    assertEquals(
      await browser.evaluate(
        "getComputedStyle(document.querySelector('.otk-server-status > span:last-child')).display",
      ),
      "none",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('.otk-server-status [role=img]').getBoundingClientRect().width>0",
      ),
      true,
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('button[aria-label=\"Slot control\"]').classList.contains('consumer-trigger')",
      ),
      true,
      "Popover did not forward the public trigger style slot",
    );
  }));
