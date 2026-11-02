// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { WsClient } from "../support/ws-client.ts";
import { selectionGeometry } from "../support/selection-geometry.ts";
import { promptFooterControls } from "../support/prompt-footer.ts";

// Fixed visual scenes only. Native choices/catalog outcomes are owned by C9.
for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
  test(`V5 composer picks reach native messages and the selected provider; restore, favourites, keyboard, slash and shell keep the same selection (${theme})`, async () => {
    const fake2 = new FakeLlm();
    const f = await browserFixture({ bash: "allow" }, {
      providers: {
        fake2: {
          fake: fake2,
          name: "Second fixture provider",
          models: {
            scripted: {
              name: "Scripted with variants",
              release_date: "2026-10-17",
              variants: {
                low: { reasoningEffort: "low" },
                high: { reasoningEffort: "high" },
              },
            },
            plain: { name: "Plain model", release_date: "2026-10-16" },
          },
        },
      },
      config: {
        agent: {
          reviewer: {
            mode: "primary",
            description: "Review changes",
            color: "#12abEF",
          },
        },
      },
    });
    let client: WsClient | undefined;
    try {
      const session = await f.oc.session<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Composer picker scenes" },
      });
      const server = await f.sidecar(), b = await f.browser(server.url);
      client = new WsClient(server.url);
      await client.connect();
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await openSession(b, session.id);
      const option = (key: string) =>
        `[data-picker-key=${JSON.stringify(key)}]`;
      const model = `.otk-model-picker ${
        option(JSON.stringify(["fake2", "scripted"]))
      }`;
      const open = async (kind: string) => {
        const before = await b.evaluate(
          "document.querySelector('.otk-prompt').getBoundingClientRect().toJSON()",
        );
        await b.click(`.otk-${kind}-picker > button`);
        await b.poll(
          `document.querySelector('.otk-${kind}-picker .otk-popover-panel')?.contains(document.activeElement)`,
        );
        const geometry = await b.evaluate<
          { panel: DOMRect; trigger: DOMRect; width: number }
        >(`(()=>{const p=document.querySelector('.otk-${kind}-picker .otk-surface').getBoundingClientRect(),t=document.querySelector('.otk-${kind}-picker > button').getBoundingClientRect();return {panel:p.toJSON(),trigger:t.toJSON(),width:innerWidth}})()`);
        assertEquals(
          await b.evaluate(
            "document.querySelector('.otk-prompt').getBoundingClientRect().toJSON()",
          ),
          before,
        );
        assert(geometry.panel.bottom <= geometry.trigger.top + .5);
        assert(
          geometry.panel.left >= 0 && geometry.panel.right <= geometry.width,
        );
        assert(
          Math.abs(
            geometry.trigger.left + geometry.panel.width <= geometry.width
              ? geometry.panel.left - geometry.trigger.left
              : geometry.panel.right - geometry.trigger.right,
          ) < .5,
        );
      };
      const pointer = async (selector: string) => {
        await b.poll(
          "!document.querySelector('.otk-popover-panel:popover-open [role=status]')",
        );
        const rows = await selectionGeometry(b, selector);
        assertEquals(rows.length, 1);
        assertEquals([
          rows[0].selected,
          rows[0].ariaSelected,
          rows[0].w,
          rows[0].h,
          rows[0].start,
          rows[0].shift,
        ], [true, "true", 3, 14, 3, 0]);
        assert(rows[0].centred < .5);
        assert(
          await b.evaluate(
            `(()=>{const e=document.querySelector(${
              JSON.stringify(selector)
            }),r=e.getBoundingClientRect(),l=e.closest('.otk-picker-groups').getBoundingClientRect();return r.top>=l.top-.5&&r.bottom<=l.bottom+.5&&r.top>=0&&r.bottom<=innerHeight})()`,
          ),
        );
      };
      const footer = async (draft: boolean) => {
        await b.poll(`!!document.querySelector('.otk-send-button')===${draft}`);
        const centres = await b.evaluate<number[]>(
          `[...document.querySelectorAll('${promptFooterControls}')].map(e=>{const r=e.getBoundingClientRect();return r.y+r.height/2})`,
        );
        assertEquals(centres.length, draft ? 7 : 6);
        assert(Math.max(...centres) - Math.min(...centres) < .5);
        const chevrons = await b.evaluate<{ delta: number; label: string }[]>(
          "[...document.querySelectorAll('.otk-prompt-context > .otk-popover > button')].map(e=>{const a=e.querySelector('span').getBoundingClientRect(),b=e.querySelector('svg').getBoundingClientRect();return {delta:Math.abs(a.y+a.height/2-b.y-b.height/2),label:e.getAttribute('aria-label')}})",
        );
        assertEquals(chevrons.map((e) => e.label), [
          "Agent: Reviewer",
          "Model: Second fixture provider Scripted with variants",
          "Variant: High",
        ]);
        assert(chevrons.every((e) => e.delta < .5));
        const m = await b.evaluate<
          {
            gap: number;
            centre: number;
            full: boolean;
            muted: boolean;
            foreground: boolean;
          }
        >("(()=>{const t=document.querySelector('.otk-model-picker > button'),p=t.querySelector('.otk-composer-provider'),m=t.querySelector('.otk-composer-model-name'),a=p.getBoundingClientRect(),b=m.getBoundingClientRect(),probe=document.createElement('span');probe.style.color='var(--otk-fg-2)';document.body.append(probe);const muted=getComputedStyle(p).color===getComputedStyle(probe).color;probe.remove();return {gap:b.left-a.right,centre:Math.abs(a.y+a.height/2-b.y-b.height/2),full:p.scrollWidth<=p.clientWidth&&m.scrollWidth<=m.clientWidth,muted,foreground:getComputedStyle(m).color===getComputedStyle(t).color}})()");
        assertEquals(m.gap, 8);
        assert(m.centre < .5 && m.full && m.muted && m.foreground);
      };
      await open("agent");
      await b.click(`.otk-agent-picker ${option("reviewer")}`);
      assertEquals(
        await b.evaluate(
          "getComputedStyle(document.querySelector('.otk-composer-agent')).color",
        ),
        "rgb(18, 171, 239)",
      );
      await open("model");
      await b.fill(
        ".otk-model-picker input[type=search]",
        "Scripted with variants",
      );
      await b.click(model);
      await open("variant");
      await b.click(`.otk-variant-picker ${option("high")}`);
      await footer(false);
      await b.fill(
        "textarea[name=prompt]",
        "Measure all available footer controls",
      );
      await footer(true);
      for (
        const [width, modelTruncated] of [[1180, false], [1060, true]] as const
      ) {
        await b.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 657,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const g = await b.evaluate<
          {
            provider: boolean;
            model: boolean;
            centres: number[];
            inside: boolean;
            overflow: boolean;
          }
        >(`(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);const f=document.querySelector('.otk-prompt-actions'),r=f.getBoundingClientRect(),p=document.querySelector('.otk-composer-provider'),m=document.querySelector('.otk-composer-model-name'),rects=[...document.querySelectorAll('${promptFooterControls}')].map(e=>e.getBoundingClientRect());return {provider:p.scrollWidth>p.clientWidth,model:m.scrollWidth>m.clientWidth,centres:rects.map(b=>b.y+b.height/2),inside:rects.every(b=>b.left>=r.left-.5&&b.right<=r.right+.5),overflow:f.scrollWidth>f.clientWidth}})()`);
        assertEquals(g.provider, true);
        assertEquals(g.model, modelTruncated);
        assertEquals(g.centres.length, 7);
        assert(
          Math.max(...g.centres) - Math.min(...g.centres) < .5 && g.inside &&
            !g.overflow,
        );
      }
      await b.send("Emulation.clearDeviceMetricsOverride");
      await b.fill("textarea[name=prompt]", "");
      for (
        const [kind, selector] of [
          ["agent", `.otk-agent-picker ${option("reviewer")}`],
          ["model", model],
          ["variant", `.otk-variant-picker ${option("high")}`],
        ]
      ) {
        await open(kind);
        await pointer(selector);
        if (kind === "model") {
          assertEquals(
            await b.evaluate(
              "[...document.querySelectorAll('.otk-model-picker section')].filter(s=>!['Favourites','Recent'].includes(s.querySelector('h3')?.textContent)).flatMap(s=>[...s.querySelectorAll('.otk-picker-name small')]).length",
            ),
            0,
          );
          const action = async () => {
            const g = await b.evaluate<
              {
                inside: boolean;
                shared: boolean;
                centre: number;
                icon: number;
                common: number;
              }
            >(`(()=>{const row=document.querySelector(${
              JSON.stringify(model)
            }),action=row.querySelector('.otk-picker-action'),r=row.getBoundingClientRect(),a=action.getBoundingClientRect();return {inside:a.left>=r.left&&a.right<=r.right&&a.top>=r.top&&a.bottom<=r.bottom,shared:action.closest('[data-otk-selection]')===row,centre:Math.abs(a.y+a.height/2-r.y-r.height/2),icon:action.querySelector('svg').getBoundingClientRect().width,common:document.querySelector('.otk-prompt-actions > button svg').getBoundingClientRect().width}})()`);
            assert(g.inside && g.shared && g.centre < .5);
            assertEquals(g.icon, g.common);
          };
          await action();
          await b.fill(
            ".otk-model-picker input[type=search]",
            "Scripted with variants",
          );
          await b.click(
            '[aria-label="Add Scripted with variants to favourites"]',
          );
          await b.poll(
            "document.querySelector('.otk-model-picker h3')?.textContent==='Favourites'",
          );
          await pointer(model);
          await action();
          assertEquals(
            await b.evaluate(
              "document.querySelector('.otk-model-picker .otk-picker-name small')?.textContent",
            ),
            "Second fixture provider",
          );
        }
        await b.key("Escape");
      }
    } finally {
      await client?.close();
      await f.stop();
    }
  });
}
