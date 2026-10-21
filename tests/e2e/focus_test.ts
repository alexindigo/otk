// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  browserFixture,
  openSession,
  waitForReply,
} from "../support/browser-fixture.ts";
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

const panel = ".otk-question-dock .otk-tabs-panel[data-active=true]";
const primary = ".otk-question-actions .otk-primary";

// Same sRGB focus contrast contract as the theme's surface matrix, measured
// against the actual rendered fill rather than assuming a palette pairing.
function focusContrast([outline, fill]: string[]): number {
  const luminance = (rgb: string) =>
    rgb.match(/[\d.]+/g)!.slice(0, 3)
      .map((part) => Number(part) / 255)
      .map((c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
      .reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
  const x = luminance(outline), y = luminance(fill);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}

Deno.test("U15 own-answer Enter and all question transitions focus visible controls; composer owns its rounded focus border", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
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
    const client = new WsClient(server.url);
    await client.connect();
    try {
      await openSession(b, session.id);
      const shots = Deno.env.get("OTK_FOCUS_SHOTS");
      if (shots) await Deno.mkdir(shots, { recursive: true });
      const primaryColors: string[][] = [];
      const capture = async (state: string) => {
        for (
          const [theme, name] of [["otk-dark", "dark"], ["otk-light", "light"]]
        ) {
          await client.rpc("prefs.set", { key: "theme", value: theme });
          await b.poll(
            `document.documentElement.dataset.otkTheme==='${theme}'`,
          );
          if (shots) await b.screenshot(join(shots, `${state}-${name}.png`));
          if (state === "own-enter") {
            primaryColors.push(
              await b.evaluate<string[]>(
                `(()=>{const s=getComputedStyle(document.activeElement);return [s.outlineColor,s.backgroundColor]})()`,
              ),
            );
          }
        }
      };
      await b.type("textarea[name=prompt]", "Ask the interaction questions");
      await capture("composer");
      const composer = await b.evaluate<
        { field: string; box: string; token: string }
      >(`(()=>{const field=document.activeElement,box=field.closest('.otk-composer'),p=document.createElement('span');p.style.color='var(--otk-action-focus)';document.body.append(p);const token=getComputedStyle(p).color;p.remove();return {field:getComputedStyle(field).outlineStyle,box:getComputedStyle(box).borderColor,token}})()`);
      f.fake.queue({ tool: { name: "question", input: { questions } } }, {
        chunks: ["Answers recorded."],
      });
      await b.key("Enter");
      await b.poll(`!!document.querySelector('${panel} textarea')`);
      await b.type(`${panel} textarea`, "My own output");
      await capture("own-field");
      const ownFocus = await b.evaluate<string[]>(
        `(()=>{const e=document.activeElement;return [getComputedStyle(e).outlineStyle,getComputedStyle(e.closest('[data-question-row]')).outlineStyle]})()`,
      );
      const ownRingFits = await b.evaluate<boolean>(
        `(()=>{const e=document.activeElement.closest('[data-question-row]'),r=e.getBoundingClientRect(),clip=e.closest('.otk-tabs-panels').getBoundingClientRect(),s=getComputedStyle(e),out=Math.max(0,parseFloat(s.outlineWidth)+parseFloat(s.outlineOffset));return r.left-out>=clip.left&&r.right+out<=clip.right&&r.top-out>=clip.top&&r.bottom+out<=clip.bottom})()`,
      );
      await b.key("Enter");
      await capture("own-enter");
      const focus = await b.evaluate<
        {
          visible: boolean;
          interactive: boolean;
          oversized: string[];
          name: string;
        }
      >(`(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),card=document.querySelector('.otk-takeover').getBoundingClientRect();return {name:e.tagName+'.'+e.className,visible:r.width>0&&r.height>0&&!e.closest('[inert],[hidden]'),interactive:e.matches('button,input,textarea,a[href]'),oversized:[...document.querySelectorAll('*')].filter(n=>{const s=getComputedStyle(n),r=n.getBoundingClientRect();return s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>0&&(r.width>card.width+1||r.height>card.height+1)}).map(n=>n.className)}})()`);
      console.log(
        "U15 baseline/consumer focus",
        JSON.stringify({ composer, focus }),
      );
      assert(focus.visible && focus.interactive, focus.name);
      assertEquals(focus.oversized, []);
      assertEquals(composer.field, "none");
      assertEquals(
        ownFocus,
        ["none", "solid"],
        "The visible own-answer row owns keyboard focus paint",
      );
      assert(
        ownRingFits,
        "The complete focus perimeter fits inside the tab scrollport",
      );
      assertEquals(composer.box, composer.token);
      assertEquals(
        await b.evaluate(
          `getComputedStyle(document.activeElement).outlineStyle`,
        ),
        "solid",
        "Keyboard focus remains visible on the Answer action",
      );
      for (const colors of primaryColors) {
        assert(
          focusContrast(colors) >= 3,
          `Primary focus must contrast against its fill: ${
            JSON.stringify(colors)
          }`,
        );
      }
      assertEquals(
        await b.evaluate(
          `(()=>{const prior=document.activeElement;const nodes=['<div tabindex="-1"></div>','<div tabindex="0"></div>','<div role="region" tabindex="0"></div>','<div role="tabpanel" tabindex="0"></div>','<section tabindex="0"></section>'].map(html=>{const host=document.createElement('div');host.innerHTML=html;const e=host.firstChild;document.body.append(e);e.focus();const outline=getComputedStyle(e).outlineStyle;e.remove();return outline});prior.focus();return nodes})()`,
        ),
        ["none", "none", "none", "none", "none"],
      );
      await b.poll(
        `document.activeElement===document.querySelector('${primary}')`,
      );
      await b.click(primary);
      await b.poll(
        `document.activeElement===document.querySelector('${panel} button')`,
      );
      await b.key("ArrowDown");
      await b.poll(
        `document.activeElement===document.querySelector('${panel} button:nth-child(2)')`,
      );
      await b.key("ArrowDown");
      await b.poll(
        `document.activeElement===document.querySelector('${panel} textarea')`,
      );
      await b.key("Escape");
      await b.poll(
        `document.activeElement===document.querySelector('${primary}')`,
      );
      await b.type(`${panel} textarea`, "My own details");
      await b.key("Escape");
      await b.poll(
        `document.activeElement===document.querySelector('${primary}')`,
      );
      await b.click(primary);
      await b.poll(
        `document.querySelector('.otk-tabs-strip button:last-child').getAttribute('aria-selected')==='true' && document.activeElement===document.querySelector('${primary}')`,
      );
      await b.click(".otk-takeover-collapse");
      await b.poll(
        "document.activeElement===document.querySelector('.otk-takeover-collapse') && document.querySelector('.otk-takeover').dataset.collapsed==='true'",
      );
      await b.click(".otk-takeover-collapse");
      await b.poll(
        `document.activeElement===document.querySelector('${primary}')`,
      );
      await b.click(".otk-question-dock .otk-tabs-strip button:first-child");
      await b.poll(
        `document.activeElement===document.querySelector('${panel} button')`,
      );
      await b.key("ArrowRight");
      await b.poll(
        `document.querySelector('.otk-tabs-strip button:nth-child(2)').getAttribute('aria-selected')==='true' && document.activeElement===document.querySelector('${panel} button')`,
      );
      await b.click(".otk-question-submit");
      await b.poll(
        "!document.querySelector('.otk-question-dock') && document.activeElement===document.querySelector('textarea[name=prompt]')",
      );
      await b.poll(
        "document.querySelector('.otk-questions').textContent.includes('My own details')",
      );
      await waitForReply(b, session.id, "Answers recorded.");
      await b.key("Tab");
      for (
        const selector of [
          ".otk-user-bubble",
          ".otk-message-agent",
          ".otk-last-output-time",
        ]
      ) {
        await b.evaluate(
          `document.querySelector(${JSON.stringify(selector)}).focus()`,
        );
        assertEquals(
          await b.evaluate(
            "getComputedStyle(document.activeElement).outlineStyle",
          ),
          "solid",
          `Visible content keeps keyboard focus: ${selector}`,
        );
      }
      f.fake.queue({
        tool: { name: "question", input: { questions: [questions[0]] } },
      });
      await b.type("textarea[name=prompt]", "Ask to skip");
      await b.key("Enter");
      await b.poll("!!document.querySelector('.otk-question-dock')");
      await b.click(".otk-question-actions button:nth-child(2)");
      await b.poll(
        "!document.querySelector('.otk-question-dock') && document.activeElement===document.querySelector('textarea[name=prompt]')",
      );
      await b.poll(
        `document.querySelector('[data-session="${session.id}"]').dataset.status==='idle'`,
      );
      f.fake.queue({
        tool: { name: "question", input: { questions: [questions[0]] } },
      });
      await b.type("textarea[name=prompt]", "Ask while I use the sidebar");
      await b.key("Enter");
      await b.poll("!!document.querySelector('.otk-question-dock')");
      await b.click('.otk-project-sessions input[type="search"]');
      const pending = await client.rpc<{ id: string }[]>("question.list", {
        sessionID: session.id,
      });
      await client.rpc("question.reject", { requestID: pending[0].id });
      await b.poll(
        "!document.querySelector('.otk-question-dock') && document.activeElement===document.querySelector('.otk-project-sessions input[type=search]')",
      );
    } finally {
      await client.close();
    }
  } finally {
    await f.stop();
  }
});
