// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
const questions = [
  {
    header: "Rendering",
    question: "Choose the output",
    options: [{ label: "Typed", description: "OTK shapes" }, {
      label: "Raw",
      description: "Harness shapes",
    }],
  },
  {
    header: "Details",
    question: "Choose details",
    options: [{ label: "Files", description: "Include files" }, {
      label: "Tools",
      description: "Include tools",
    }],
    multiple: true,
  },
];

function contrast([outline, fill]: string[]): number {
  const luminance = (rgb: string) =>
    rgb.match(/[\d.]+/g)!.slice(0, 3).map((p) => Number(p) / 255).map((c) =>
      c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4
    ).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
  const x = luminance(outline), y = luminance(fill);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
test("U15 own-answer Enter and all question transitions focus visible controls; composer owns its rounded focus border", async () => {
  const f = await browserFixture();
  let c: WsClient | undefined;
  try {
    const session = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Focus ownership" },
    });
    const server = await f.sidecar(), b = await f.browser(server.url);
    await b.send("Emulation.setDeviceMetricsOverride", {
      width: 1600,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    c = new WsClient(server.url);
    await c.connect();
    await openSession(b, session.id);
    await b.type("textarea[name=prompt]", "Ask the interaction questions");
    for (const theme of ["otk-dark", "otk-light"]) {
      await c.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      const composer = await b.evaluate<
        { field: string; box: string; token: string }
      >("(()=>{const field=document.activeElement,box=field.closest('.otk-composer'),p=document.createElement('span');p.style.color='var(--otk-action-focus)';document.body.append(p);const token=getComputedStyle(p).color;p.remove();return {field:getComputedStyle(field).outlineStyle,box:getComputedStyle(box).borderColor,token}})()");
      assertEquals(composer.field, "none");
      assertEquals(composer.box, composer.token);
    }
    f.fake.queue({ tool: { name: "question", input: { questions } } });
    await b.key("Enter");
    const panel = ".otk-question-dock .otk-tabs-panel[data-active=true]";
    await b.poll(`!!document.querySelector('${panel} textarea')`);
    for (const theme of ["otk-dark", "otk-light"]) {
      await c.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await b.type(`${panel} textarea`, "My own output");
      assertEquals(
        await b.evaluate(
          "(()=>{const e=document.activeElement;return [getComputedStyle(e).outlineStyle,getComputedStyle(e.closest('[data-question-row]')).outlineStyle]})()",
        ),
        ["none", "solid"],
      );
      assert(
        await b.evaluate(
          "(()=>{const e=document.activeElement.closest('[data-question-row]'),r=e.getBoundingClientRect(),clip=e.closest('.otk-tabs-panels').getBoundingClientRect(),s=getComputedStyle(e),out=Math.max(0,parseFloat(s.outlineWidth)+parseFloat(s.outlineOffset));return r.left-out>=clip.left&&r.right+out<=clip.right&&r.top-out>=clip.top&&r.bottom+out<=clip.bottom})()",
        ),
      );
      await b.key("Enter");
      await b.poll(
        "document.activeElement===document.querySelector('.otk-question-actions .otk-primary')",
      );
      assertEquals(
        await b.evaluate(
          "getComputedStyle(document.activeElement).outlineStyle",
        ),
        "solid",
      );
      assert(
        contrast(
          await b.evaluate<string[]>(
            "(()=>{const s=getComputedStyle(document.activeElement);return [s.outlineColor,s.backgroundColor]})()",
          ),
        ) >= 3,
      );
      assertEquals(
        await b.evaluate(
          '(()=>{const prior=document.activeElement;const nodes=[\'<div tabindex="-1"></div>\',\'<div tabindex="0"></div>\',\'<div role="region" tabindex="0"></div>\',\'<div role="tabpanel" tabindex="0"></div>\',\'<section tabindex="0"></section>\'].map(html=>{const host=document.createElement(\'div\');host.innerHTML=html;const e=host.firstChild;document.body.append(e);e.focus();const outline=getComputedStyle(e).outlineStyle;e.remove();return outline});prior.focus();return nodes})()',
        ),
        ["none", "none", "none", "none", "none"],
      );
    }
  } finally {
    await c?.close();
    await f.stop();
  }
});
