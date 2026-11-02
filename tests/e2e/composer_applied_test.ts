// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { WsClient } from "../support/ws-client.ts";
import { selectionGeometry } from "../support/selection-geometry.ts";
import { promptFooterControls } from "../support/prompt-footer.ts";

// Fixed origin-paint scenes. C9 owns native Default/explicit/restore journeys.
for (const nativeTheme of ["otk-dark", "otk-light", "otk-light-stone"]) {
  test(`P6 Default shows the muted backend-applied variant at the native consumer; explicit and restored choices are unmuted (${nativeTheme})`, async () => {
    const fake2 = new FakeLlm();
    const f = await browserFixture({}, {
      providers: {
        fake2: {
          fake: fake2,
          name: "Second fixture provider",
          models: {
            scripted: {
              name: "Scripted with variants",
              variants: {
                low: { reasoningEffort: "low" },
                high: { reasoningEffort: "high" },
              },
            },
          },
        },
      },
      config: {
        default_agent: "reviewer",
        agent: {
          reviewer: {
            mode: "primary",
            model: "fake2/scripted",
            variant: "high",
            color: "#12abEF",
          },
        },
      },
    });
    let client: WsClient | undefined;
    try {
      const session = await f.oc.session<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Applied choice scenes" },
      });
      const server = await f.sidecar(), b = await f.browser(server.url);
      client = new WsClient(server.url);
      await client.connect();
      await client.rpc("prefs.set", { key: "theme", value: nativeTheme });
      await b.poll(
        `document.documentElement.dataset.otkTheme==='${nativeTheme}'`,
      );
      await openSession(b, session.id);
      const trigger = ".otk-variant-picker > button";
      await b.poll(
        `document.querySelector('${trigger}')?.getAttribute('aria-label')==='Variant: High (agent default)'`,
      );
      await b.type("textarea[name=prompt]", "P6-DEFAULT");
      const pick = async (key: string) => {
        await b.click(trigger);
        await b.click(
          `.otk-variant-picker [data-picker-key=${
            JSON.stringify(key)
          }] .otk-picker-option`,
        );
        await b.poll(
          "document.activeElement?.name==='prompt' && !document.querySelector('.otk-popover-panel:popover-open')",
        );
      };
      const measure = () =>
        b.evaluate<
          {
            rects: unknown[];
            centres: number[];
            color: string;
            muted: string;
            font: string;
            text: string;
          }
        >(`(()=>{const buttons=[...document.querySelectorAll('${promptFooterControls}')],t=document.querySelector('${trigger}'),s=getComputedStyle(t),probe=document.createElement('span');probe.style.color='var(--applied-fg)';document.body.append(probe);const muted=getComputedStyle(probe).color;probe.remove();return {rects:buttons.map(e=>e.getBoundingClientRect().toJSON()),centres:buttons.map(e=>{const r=e.getBoundingClientRect();return r.y+r.height/2}),color:s.color,muted,font:s.font,text:t.textContent}})()`);
      const modelLabel = async (applied: boolean) => {
        const m = await b.evaluate<
          {
            provider: string;
            name: string;
            applied: boolean;
            providerMuted: boolean;
            modelMuted: boolean;
            gap: number;
            centre: number;
          }
        >("(()=>{const t=document.querySelector('.otk-model-picker > button'),p=t.querySelector('.otk-composer-provider'),m=t.querySelector('.otk-composer-model-name'),a=p.getBoundingClientRect(),r=m.getBoundingClientRect(),probe=document.createElement('span');probe.style.color='var(--applied-fg)';document.body.append(probe);const muted=getComputedStyle(probe).color;probe.remove();return {provider:p.textContent,name:m.textContent,applied:t.classList.contains('is-applied'),providerMuted:getComputedStyle(p).color===muted,modelMuted:getComputedStyle(m).color===muted,gap:r.left-a.right,centre:Math.abs(a.y+a.height/2-r.y-r.height/2)}})()");
        assertEquals([
          m.provider,
          m.name,
          m.applied,
          m.providerMuted,
          m.modelMuted,
          m.gap,
        ], [
          "Second fixture provider",
          "Scripted with variants",
          applied,
          true,
          applied,
          8,
        ]);
        assert(m.centre < .5);
      };
      await modelLabel(true);
      await pick("high");
      await b.poll(
        `document.querySelector('${trigger}').getAttribute('aria-label')==='Variant: High' && !document.querySelector('${trigger}').classList.contains('is-applied')`,
      );
      const explicit = await measure();
      await pick("");
      await b.poll(
        `document.querySelector('${trigger}').getAttribute('aria-label')==='Variant: High (agent default)' && document.querySelector('${trigger}').classList.contains('is-applied')`,
      );
      const muted = await measure();
      assertEquals(muted.rects, explicit.rects);
      assertEquals(muted.text, explicit.text);
      assertEquals(muted.font, explicit.font);
      assert(muted.color !== explicit.color);
      assertEquals(muted.color, muted.muted);
      assertEquals(muted.centres.length, 7);
      assert(Math.max(...muted.centres) - Math.min(...muted.centres) < .5);
      await b.click(trigger);
      await b.poll(
        "document.querySelector('.otk-variant-picker [data-picker-key=\"\"]')?.getAttribute('aria-selected')==='true'",
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('.otk-variant-picker [data-picker-key=\"\"] small')?.textContent",
        ),
        "High",
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('.otk-variant-picker [data-picker-key=high]').getAttribute('aria-selected')",
        ),
        "false",
      );
      const pointer = await selectionGeometry(
        b,
        '.otk-variant-picker [data-picker-key=""]',
      );
      assertEquals(pointer.length, 1);
      assertEquals([pointer[0].w, pointer[0].h, pointer[0].selected], [
        3,
        14,
        true,
      ]);
      assert(pointer[0].centred < .5);
      await b.key("Escape");
      await f.oc.request(`/session/${session.id}/message`, {
        method: "POST",
        body: {
          noReply: true,
          agent: "reviewer",
          model: { providerID: "fake2", modelID: "scripted" },
          variant: "high",
          parts: [{ type: "text", text: "Restored visual choice" }],
        },
      });
      await b.reload();
      await b.poll(
        `document.querySelector('${trigger}')?.getAttribute('aria-label')==='Variant: High' && !document.querySelector('${trigger}').classList.contains('is-applied')`,
      );
      await modelLabel(false);
      for (const kind of ["agent", "model"]) {
        assertEquals(
          await b.evaluate(
            `document.querySelector('.otk-${kind}-picker > button').classList.contains('is-applied')`,
          ),
          false,
        );
      }
    } finally {
      await client?.close();
      await f.stop();
    }
  });
}
