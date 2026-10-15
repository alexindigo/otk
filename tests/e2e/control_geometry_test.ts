// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { Cdp } from "../support/cdp.ts";
import { fixture } from "../support/config.ts";

// No consumer width/padding escape hatch: exercise the owning stylesheet with
// native inputs, including HTML's default/invalid text state and mixed-case types.
Deno.test("shared field geometry excludes native compact inputs without consumer overrides", async () => {
  const root = await fixture();
  const css = await Deno.readTextFile("packages/ui/theme.css");
  const fields = [
    "",
    "unknown",
    "text",
    "SEARCH",
    "tel",
    "url",
    "email",
    "password",
    "number",
    "date",
    "datetime-local",
    "month",
    "week",
    "time",
  ];
  const compact = [
    "checkbox",
    "RADIO",
    "range",
    "color",
    "file",
    "button",
    "submit",
    "reset",
    "image",
  ];
  const html = `<style>${css}</style><main style="width:320px">
    ${
    fields.map((type, i) =>
      `<input data-field="${i}" ${type ? `type="${type}"` : ""}>`
    ).join("")
  }
    <textarea data-field="area"></textarea><select data-field="select"><option>Choice</option></select>
    ${
    compact.map((type, i) =>
      `<label data-row="${i}" style="display:flex;align-items:center;gap:10px"><input data-compact="${i}" type="${type}" ${
        type === "image"
          ? "alt=\"Image\" src=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3C/svg%3E\""
          : ""
      }><span>Pick</span></label>`
    ).join("")
  }
    <input type="hidden"><div id="native"></div></main>`;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () => new Response(html, { headers: { "content-type": "text/html" } }),
  );
  let browser: Cdp | undefined;
  try {
    browser = await Cdp.launch(root);
    await browser.goto(`http://127.0.0.1:${server.addr.port}`);
    // Shadow-root UA controls supply platform-native dimensions, rather than a
    // hardcoded checkbox glyph size or another copy of the corrected selector.
    await browser.evaluate(`(() => {
      const shadow=document.querySelector('#native').attachShadow({mode:'open'});
      shadow.innerHTML=${
      JSON.stringify(
        compact.map((type, i) =>
          `<label style="display:flex;align-items:center;gap:10px"><input data-native="${i}" type="${type}" ${
            type === "image"
              ? "alt=\"Image\" src=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3C/svg%3E\""
              : ""
          }><span>Pick</span></label>`
        ).join(""),
      )
    };
      for(const el of shadow.querySelectorAll('input')) { el.style.font='inherit';el.style.color='inherit';el.style.boxSizing='border-box'; }
    })()`);
    for (const mode of ["dark", "light"]) {
      const theme = JSON.parse(
        await Deno.readTextFile(`packages/ui/features/theme/otk-${mode}.json`),
      );
      await browser.evaluate(`(() => {
        const root=document.documentElement;
        for(const [name,value] of Object.entries(${
        JSON.stringify(theme.colors)
      }))root.style.setProperty('--otk-'+name,value);
        root.style.colorScheme=${JSON.stringify(mode)};
      })()`);
      for (const width of [320, 920]) {
        await browser.evaluate(
          `document.querySelector('main').style.width='${width}px'`,
        );
        const result = await browser.evaluate<{
          fields: {
            width: number;
            padding: number;
            bg: string;
            border: string;
            font: string;
            color: string;
          }[];
          compact: {
            width: number;
            height: number;
            nativeWidth: number;
            nativeHeight: number;
            nativeCenters: number;
            gap: number;
            centers: number;
            right: number;
            rowRight: number;
            font: string;
            color: string;
          }[];
          bg: string;
          border: string;
          color: string;
          font: string;
          hidden: number;
        }>(`(() => {
          const root=getComputedStyle(document.documentElement), shadow=document.querySelector('#native').shadowRoot;
          const probe=document.createElement('div');probe.style.background='var(--bg)';probe.style.border='1px solid var(--muted)';document.body.append(probe);
          const paint=getComputedStyle(probe), bg=paint.backgroundColor,border=paint.borderTopColor;probe.remove();
          return {bg,border,color:root.color,font:root.fontFamily,hidden:document.querySelector('input[type=hidden]').getBoundingClientRect().width,
            fields:[...document.querySelectorAll('[data-field]')].map(el=>{const c=getComputedStyle(el);return {width:el.getBoundingClientRect().width,padding:parseFloat(c.paddingLeft),bg:c.backgroundColor,border:c.borderTopColor,font:c.fontFamily,color:c.color}}),
            compact:[...document.querySelectorAll('[data-compact]')].map((el,i)=>{
              const r=el.getBoundingClientRect(),row=el.parentElement.getBoundingClientRect(),label=el.nextElementSibling.getBoundingClientRect(),native=shadow.querySelector('[data-native="'+i+'"]'),n=native.getBoundingClientRect(),nl=native.nextElementSibling.getBoundingClientRect(),c=getComputedStyle(el);
              return {width:r.width,height:r.height,nativeWidth:n.width,nativeHeight:n.height,nativeCenters:Math.abs(n.y+n.height/2-nl.y-nl.height/2),gap:label.left-r.right,centers:Math.abs(r.y+r.height/2-label.y-label.height/2),right:label.right,rowRight:row.right,font:c.fontFamily,color:c.color};
            })};
        })()`);
        console.info("Shared native control geometry", {
          mode,
          width,
          fieldCount: result.fields.length,
          compact: result.compact,
        });
        for (const field of result.fields) {
          assertEquals(field.width, width);
          assert(Math.abs(field.padding - 9.1) < .05);
          assertEquals(field.bg, result.bg);
          assertEquals(field.border, result.border);
          assertEquals(field.font, result.font);
          assertEquals(field.color, result.color);
        }
        for (const [i, control] of result.compact.entries()) {
          assert(
            Math.abs(control.width - control.nativeWidth) < .1,
            `${compact[i]} must retain native width`,
          );
          assert(
            Math.abs(control.height - control.nativeHeight) < .1,
            `${compact[i]} must retain native height`,
          );
          assert(
            control.gap >= 10 && control.gap <= 15,
            `${compact[i]} label adjacency`,
          );
          assert(
            Math.abs(control.centers - control.nativeCenters) <= .5,
            `${compact[i]} native flex centerline`,
          );
          assert(
            control.right <= control.rowRight + .5,
            `${compact[i]} label must fit`,
          );
          assertEquals(control.font, result.font);
          assertEquals(control.color, result.color);
        }
        assertEquals(result.hidden, 0);
      }
    }
    await browser.click('[data-compact="0"]');
    await browser.poll(
      "document.querySelector('[data-compact=\"0\"]').checked",
    );
    await browser.click('[data-compact="1"]');
    await browser.poll(
      "document.querySelector('[data-compact=\"1\"]').checked",
    );
    assertEquals(browser.errors, []);
    console.info("Shared control fixture evidence:", root);
  } finally {
    await browser?.close();
    await server.shutdown();
  }
});

Deno.test("Display and Markdown consumers retain native checkbox bounds and field/select semantics", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Control geometry" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    f.fake.queue({ chunks: ["- [ ] Unchecked task\n- [x] Checked task\n"] });
    await browser.type("textarea[name=prompt]", "Show task controls");
    await browser.key("Enter");
    await browser.poll(
      "document.querySelectorAll('.otk-text li > input[type=checkbox]').length===2 && !!document.querySelector('.otk-prompt')",
    );
    await browser.fill("textarea[name=prompt]", "Retain this draft");
    await browser.click(".otk-display-menu summary");
    await browser.poll(
      "!document.querySelector('.otk-display-menu fieldset').disabled",
    );
    const geometry = await browser.evaluate<{
      controls: {
        width: number;
        height: number;
        padding: number;
        right: number;
        parentRight: number;
      }[];
      labels: {
        gap: number;
        centers: number;
        right: number;
        parentRight: number;
      }[];
      selects: {
        padding: number;
        right: number;
        parentRight: number;
        gap: number;
        centers: number;
        value: string;
      }[];
      tasks: {
        checked: boolean;
        disabled: boolean;
        text: string;
        margin: number;
      }[];
    }>(`(() => {
      const bounds=el=>{const r=el.getBoundingClientRect(),p=el.parentElement.getBoundingClientRect();return {width:r.width,height:r.height,padding:parseFloat(getComputedStyle(el).paddingLeft),right:r.right,parentRight:p.right}};
      const textBounds=el=>{const range=document.createRange();range.selectNodeContents(el.parentElement);const node=[...el.parentElement.childNodes].find(n=>n.nodeType===Node.TEXT_NODE && n.textContent.trim());range.selectNodeContents(node);return range.getBoundingClientRect()};
      return {controls:[...document.querySelectorAll('.otk-display-menu input,.otk-text li > input')].map(bounds),
        labels:[...document.querySelectorAll('.otk-display-menu input')].map(el=>{const r=el.getBoundingClientRect(),t=textBounds(el),p=el.parentElement.getBoundingClientRect();return {gap:t.left-r.right,centers:Math.abs(r.y+r.height/2-t.y-t.height/2),right:t.right,parentRight:p.right}}),
        selects:[...document.querySelectorAll('.otk-display-menu select')].map(el=>{const r=el.getBoundingClientRect(),t=textBounds(el),p=el.parentElement.getBoundingClientRect();return {padding:parseFloat(getComputedStyle(el).paddingLeft),right:r.right,parentRight:p.right,gap:r.left-t.right,centers:Math.abs(r.y+r.height/2-t.y-t.height/2),value:el.value}}),
        tasks:[...document.querySelectorAll('.otk-text li > input')].map(el=>({checked:el.checked,disabled:el.disabled,text:el.parentElement.textContent,margin:parseFloat(getComputedStyle(el).marginRight)}))};
    })()`);
    console.info("Actual Display/Markdown geometry", geometry);
    await Deno.writeTextFile(
      join(f.oc.root, "control-geometry.json"),
      JSON.stringify(geometry, null, 2),
    );
    assertEquals(geometry.controls.length, 9);
    for (const c of geometry.controls) {
      assert(
        c.width > 0 && c.width <= 18 && c.height > 0 && c.height <= 18,
        "Native checkbox hitbox must not contain field padding",
      );
      assertEquals(c.padding, 0);
      assert(c.right <= c.parentRight);
    }
    for (const label of geometry.labels) {
      assert(label.gap >= 9.05 && label.gap <= 15);
      assert(label.centers <= .5);
      assert(label.right <= label.parentRight + .5);
    }
    for (const select of geometry.selects) {
      assert(Math.abs(select.padding - 9.1) < .05);
      assert(select.gap >= 9.05 && select.gap <= 10);
      assert(select.centers <= .5);
      assert(Math.abs(select.right - select.parentRight) <= .5);
    }
    assertEquals(geometry.selects.map((s) => s.value), ["hide", "auto"]);
    assertEquals(geometry.tasks.map((t) => [t.checked, t.disabled, t.margin]), [
      [false, true, 6.5],
      [true, true, 6.5],
    ]);
    assert(geometry.tasks[0].text.includes("Unchecked task"));
    assert(geometry.tasks[1].text.includes("Checked task"));
    await browser.click("input[name=timestamps]");
    await browser.poll(
      "document.querySelector('input[name=timestamps]').checked",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('textarea[name=prompt]').value",
      ),
      "Retain this draft",
    );
    await browser.click(".otk-display-menu summary");
    await browser.key("k", 2);
    await browser.poll(
      "!!document.querySelector('input[name=command-search]')",
    );
    await browser.fill("input[name=command-search]", "Settings");
    await browser.click("[data-command='settings.open']");
    await browser.poll(
      "!!document.querySelector('.otk-settings input[name=url]')",
    );
    const fields = await browser.evaluate<
      { width: number; parentWidth: number; padding: number }[]
    >(`[...document.querySelectorAll('.otk-settings input')].map(el=>({width:el.getBoundingClientRect().width,parentWidth:el.parentElement.getBoundingClientRect().width,padding:parseFloat(getComputedStyle(el).paddingLeft)}))`);
    assertEquals(fields.length, 2);
    for (const field of fields) {
      assertEquals(field.width, field.parentWidth);
      assert(Math.abs(field.padding - 9.1) < .05);
    }
  } finally {
    await f.stop();
  }
});
