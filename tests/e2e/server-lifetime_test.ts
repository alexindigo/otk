// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { test } from "../support/resources.ts";
import { fixture } from "../support/config.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { Cdp } from "../support/cdp.ts";
import { WsClient } from "../support/ws-client.ts";

for (const theme of ["otk-dark", "otk-light"]) {
  test(`removing a loading direct-route server detaches its selection before closing transport in ${theme}`, async () => {
    const root = await fixture(), app = await coreBackendFixture(root);
    const control = new WsClient(app.url);
    await control.connect();
    await control.rpc("prefs.set", { key: "theme", value: theme });
    await control.rpc("prefs.set", { key: "animationsOff", value: true });
    const browser = await Cdp.launch(root);
    try {
      await browser.send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await browser.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
        localStorage.setItem('otk.sidecars', JSON.stringify([{id:'remote', baseUrl:${
          JSON.stringify(app.url)
        }, label:'Loading server'}]));
        window.heldSessionFrames = []; window.lifetimeSockets = []; window.holdSessionFrames = true;
        window.WebSocket = class extends WebSocket {
          constructor(...args) {
            super(...args); window.lifetimeSockets.push(this); this.sessionReads = new Set();
            this.addEventListener('message', event => {
              const frame = JSON.parse(event.data);
              if (!window.holdSessionFrames || !(frame.t === 'index.snapshot' || frame.t === 'index.patch' || (frame.t === 'rpc.result' && this.sessionReads.has(frame.id)))) return;
              event.stopImmediatePropagation();
              window.heldSessionFrames.push(() => this.dispatchEvent(new MessageEvent('message', {data:event.data})));
            });
          }
          send(data) { const frame=JSON.parse(data); if(frame.method==='session.get') this.sessionReads.add(frame.id); super.send(data); }
        };
        window.releaseSessionFrames = () => { window.holdSessionFrames=false; for(const deliver of window.heldSessionFrames.splice(0)) deliver(); };
      `,
      });
      await browser.goto(app.url + "/#/remote/core");
      await browser.poll(
        "window.heldSessionFrames.length>=3 && window.lifetimeSockets.length===2 && window.lifetimeSockets.every(socket=>socket.readyState===1)",
      );
      await browser.click(".otk-settings-entry");
      await browser.click('[data-settings-sidecar="remote"] > header button');
      await browser.poll(
        "!document.querySelector('[data-settings-sidecar=\"remote\"]')",
      );
      assertEquals(
        await browser.evaluate("location.hash"),
        "",
        "Removed loading server still owns the route",
      );
      await browser.poll(
        "window.lifetimeSockets.filter(socket=>socket.readyState===3).length===1",
      );
      assertEquals(
        await browser.evaluate(
          "JSON.parse(localStorage.getItem('otk.sidecars')).length",
        ),
        0,
      );
      await browser.evaluate("window.releaseSessionFrames()");
      await browser.poll("window.heldSessionFrames.length===0");
      assertEquals(await browser.evaluate("location.hash"), "");
      const shots = Deno.env.get("OTK_B6_SHOTS");
      if (shots) {
        await browser.screenshot(
          join(shots, `server-removed-settings-${theme}.png`),
        );
      }
      await browser.click(".otk-settings .otk-view-header button");
      await browser.poll(
        "!document.querySelector('.otk-settings') && !document.querySelector('textarea[name=prompt]')",
      );
      assertEquals(await browser.evaluate("location.hash"), "");
      if (shots) {
        await browser.screenshot(
          join(shots, `server-removed-home-${theme}.png`),
        );
      }
      assertEquals(browser.errors, []);
    } finally {
      await browser.close();
      await control.close();
      await app.app.stop();
    }
  });
}
