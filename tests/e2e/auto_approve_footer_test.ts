// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { WsClient } from "../support/ws-client.ts";

Deno.test("U10 auto-approve leads the footer, uses the theme accent when on and preserves picker geometry", async () => {
  const f = await browserFixture(undefined, {
    config: { model: "polish/scripted" },
    providers: {
      polish: {
        fake: new FakeLlm(),
        name: "Polish fixture",
        models: {
          scripted: { name: "Scripted", variants: { high: {} } },
        },
      },
    },
  });
  let client: WsClient | undefined;
  const shots = Deno.env.get("OTK_AUTO_FOOTER_SHOTS");
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Auto-approve footer" },
    });
    const server = await f.sidecar(), b = await f.browser(server.url);
    client = new WsClient(server.url);
    await client.connect();
    await client.rpc("prefs.set", { key: "animationsOff", value: true });
    await openSession(b, session.id);
    await b.poll(
      "document.querySelector('.otk-composer-provider')?.textContent==='Polish fixture' && !!document.querySelector('.otk-variant-picker > button') && document.querySelector('.otk-auto-approve-toggle')?.getAttribute('aria-pressed')==='false'",
    );
    await b.evaluate("document.fonts.ready.then(()=>true)");
    if (shots) await Deno.mkdir(shots, { recursive: true });
    const measure = () =>
      b.evaluate<{
        order: string[];
        pickerLefts: number[];
        centres: number[];
        toggle: { width: number; height: number };
        selected: boolean;
        named: boolean;
        colour: string;
        primary: string;
        quiet: string;
        inside: boolean;
      }>(`(async()=>{
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const footer=document.querySelector('.otk-prompt-actions'),
          toggle=footer.querySelector('.otk-auto-approve-toggle'),
          controls=[...footer.querySelectorAll(':scope > button,.otk-prompt-context > button,.otk-prompt-context > .otk-popover > button')],
          pickers=['agent','model','variant'].map(kind=>footer.querySelector('.otk-'+kind+'-picker > button')),
          bounds=footer.getBoundingClientRect(),rect=toggle.getBoundingClientRect(),
          probe=document.createElement('span');
        footer.append(probe);
        probe.style.color='var(--otk-action-text)';
        const primary=getComputedStyle(probe).color;
        probe.style.color='var(--otk-fg-3)';
        const quiet=getComputedStyle(probe).color;
        probe.remove();
        return {
          order:controls.map(e=>e.getAttribute('aria-label')?.split(':')[0]),
          pickerLefts:pickers.map(e=>e.getBoundingClientRect().left),
          centres:controls.map(e=>{const r=e.getBoundingClientRect();return r.y+r.height/2}),
          toggle:{width:rect.width,height:rect.height},
          selected:toggle.classList.contains('is-selected'),
          named:toggle.getAttribute('aria-label')==='Auto-approve',
          colour:getComputedStyle(toggle).color,primary,quiet,
          inside:controls.every(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.left>=bounds.left&&r.right<=bounds.right})&&footer.scrollWidth<=footer.clientWidth
        };
      })()`);
    const samples = [];
    for (
      const [theme, suffix] of [["otk-dark", "dark"], ["otk-light", "light"]]
    ) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      for (const width of [1280, 1060]) {
        await b.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 657,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const states = [];
        for (const enabled of [false, true, false]) {
          if (states.length) await b.click(".otk-auto-approve-toggle");
          await b.poll(
            `document.querySelector('.otk-auto-approve-toggle')?.getAttribute('aria-pressed')==='${enabled}'`,
          );
          // Keep toggle hover/focus out of the state comparison captures.
          await b.click("textarea[name=prompt]");
          const state = await measure();
          states.push(state);
          if (shots && width === 1280 && states.length <= 2) {
            await b.screenshot(
              join(shots, `${suffix}-${enabled ? "on" : "off"}.png`),
            );
          }
        }
        samples.push({ theme, width, states });
      }
    }
    for (const { theme, width, states } of samples) {
      const [off, on, offAgain] = states;
      console.info("U10 footer geometry", { theme, width, off, on, offAgain });
      for (const [index, state] of states.entries()) {
        assertEquals(state.order, [
          "Auto-approve",
          "Agent",
          "Model",
          "Variant",
          "Attach files",
          "Edit prompt",
          "Send",
        ]);
        assertEquals(state.toggle, { width: 28, height: 28 });
        assert(state.named && state.inside, JSON.stringify(state));
        assert(Math.max(...state.centres) - Math.min(...state.centres) < .5);
        assertEquals(state.selected, index === 1);
        assertEquals(state.colour, index === 1 ? state.primary : state.quiet);
      }
      assertEquals(on.pickerLefts, off.pickerLefts);
      assertEquals(offAgain.pickerLefts, off.pickerLefts);
    }
  } finally {
    await client?.close();
    await f.stop();
  }
});
