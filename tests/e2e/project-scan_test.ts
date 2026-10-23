// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { browserFixture } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";

for (const theme of ["otk-dark", "otk-light"]) {
  test(`project dialog retires a disconnected scan and reloads its current connection before adding the chosen directory in ${theme}`, async () => {
    const f = await browserFixture();
    try {
      const server = await f.sidecar(), client = new WsClient(server.url);
      await client.connect();
      const directory = join(f.oc.directory, "scan-target");
      await Deno.mkdir(directory);
      await client.rpc("projects.templates", { templates: [directory] });
      await client.rpc("prefs.set", { key: "theme", value: theme });
      const b = await f.browser(server.url);
      await b.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
        window.scanSockets = [];
        window.scanReplies = new Set();
        window.heldScans = [];
        window.heldScanWelcome = [];
        window.holdScans = true;
        window.holdScanWelcome = false;
        window.WebSocket = class extends WebSocket {
          constructor(...args) {
            super(...args);
            window.scanSockets.push(this);
            this.addEventListener('message', event => {
              const frame = JSON.parse(event.data);
              const queue = frame.t === 'rpc.result' && window.scanReplies.has(frame.id) && window.holdScans
                ? window.heldScans
                : window.holdScanWelcome ? window.heldScanWelcome : undefined;
              if (!queue) return;
              event.stopImmediatePropagation();
              queue.push(() => this.dispatchEvent(new MessageEvent('message', {data:event.data})));
            });
          }
          send(data) {
            const frame = JSON.parse(data);
            if (frame.method === 'projects.scan') window.scanReplies.add(frame.id);
            super.send(data);
          }
        };
        window.releaseScanWelcome = () => {
          window.holdScanWelcome = false;
          for (const deliver of window.heldScanWelcome.splice(0)) deliver();
        };
        window.releaseScans = () => {
          window.holdScans = false;
          for (const deliver of window.heldScans.splice(0)) deliver();
        };
      `,
      });
      await b.reload();
      await b.click('[aria-label="Add project"]');
      await b.poll(
        "window.heldScans.length===1 && document.querySelector('.otk-template-paths').textContent.includes('Scanning directories…')",
      );
      await b.evaluate(
        "window.holdScanWelcome=true; window.scanSockets.at(-1).close()",
      );
      // The native option is the current adapter's rendered connection state,
      // not a guessed quiet interval for the rejected scan continuation.
      await b.poll(
        "document.querySelector('select[name=server] option:checked')?.disabled && window.heldScanWelcome.length>0",
      );
      await b.evaluate(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
      if (Deno.env.get("OTK_PROJECT_SCAN_SHOTS")) {
        await b.screenshot(
          join(f.oc.root, `project-disconnected-${theme}.png`),
        );
        console.info("Project disconnected screenshot:", f.oc.root);
      }
      assertEquals(
        await b.evaluate(
          "document.querySelector('.otk-template-paths').textContent.includes('Scanning directories…')",
        ),
        false,
        "Disconnected scan still claims to be loading",
      );
      await b.evaluate("window.releaseScanWelcome()");
      await b.poll("window.heldScans.length===2");
      await b.evaluate("window.releaseScans()");
      await b.poll(
        `document.querySelector('.otk-template-paths button')?.textContent===${
          JSON.stringify(directory)
        }`,
      );
      if (Deno.env.get("OTK_PROJECT_SCAN_SHOTS")) {
        await b.screenshot(join(f.oc.root, `project-scan-${theme}.png`));
        console.info("Project scan screenshots:", f.oc.root);
      }
      await b.click(".otk-template-paths button");
      await b.click("dialog[open] button[type=submit]");
      await b.poll("!document.querySelector('dialog[open]')");
      await b.poll(
        `location.hash.includes(encodeURIComponent(${
          JSON.stringify(directory)
        }))`,
      );
      const inbox = await client.rpc<{ projects: { directory: string }[] }>(
        "inbox.get",
        {},
      );
      assertEquals(
        inbox.projects.some((row) => row.directory === directory),
        true,
      );
      await client.close();
    } finally {
      await f.stop();
    }
  });
}
