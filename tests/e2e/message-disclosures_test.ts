// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { Message } from "@otk/protocol";
import { test } from "../support/resources.ts";
import { fixture } from "../support/config.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { Cdp } from "../support/cdp.ts";
import { openSession } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";

for (const theme of ["otk-dark", "otk-light"]) {
  test(`folded tools destroy expensive bodies and restore choices after virtual reentry (${theme})`, async () => {
    const root = await fixture();
    const messages: Message[] = [{
      id: "answer",
      sessionID: "tstv1-otk",
      role: "assistant",
      agent: "build",
      replyTo: "prompt",
      model: { provider: "test", model: "test" },
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: 0,
      interrupted: false,
      time: { created: 1, completed: 2 },
      parts: [{
        id: "write",
        kind: "tool",
        call: {
          tool: "write",
          callID: "write",
          status: "completed",
          awaitingPermission: false,
          time: { start: 1, end: 2 },
          path: `${root}/project.ts`,
          content: "const foldedSecret = 42;",
          diagnostics: [],
        },
      }],
    }];
    const f = await inboxBrowserFixture(root, [], { "tstv1-otk": messages });
    const client = new WsClient(f.url);
    await client.connect();
    await client.rpc("prefs.set", { key: "theme", value: theme });
    const b = await Cdp.launch(root);
    await b.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await b.goto(f.url);
    await openSession(b, "tstv1-otk");
    await b.poll("!!document.querySelector('.otk-tool-toggle')");
    assertEquals(
      await b.evaluate(
        "document.querySelectorAll('.otk-tool-body .otk-code').length",
      ),
      0,
      "a folded renderer must not be constructed or hidden in DOM",
    );
    await b.click(".otk-tool-toggle");
    await b.poll(
      "document.querySelector('.otk-code')?.textContent.includes('foldedSecret')",
    );
    const shots = Deno.env.get("OTK_MESSAGES_SHOTS");
    if (shots) {
      await Deno.mkdir(shots, { recursive: true });
      await b.screenshot(join(shots, `${theme}-tool-open.png`));
    }
    await b.click(".otk-tool-toggle");
    await b.poll("document.querySelectorAll('.otk-tool-body').length===0");
    await b.click(".otk-work-fold");
    await b.poll("document.querySelectorAll('.otk-work-body').length===0");
    await b.click(".otk-work-fold");
    await b.poll(
      "document.querySelector('.otk-tool-toggle')?.getAttribute('aria-expanded')==='false'",
    );
    if (shots) await b.screenshot(join(shots, `${theme}-tool-folded.png`));
    await b.fill("textarea[name=prompt]", "Keep the disclosure draft");
    await b.evaluate(
      "Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>globalThis.bodyHidden?'hidden':'visible'});globalThis.bodyHidden=true;document.dispatchEvent(new Event('visibilitychange'))",
    );
    await b.poll(
      "document.querySelectorAll('.otk-message,.otk-code').length===0 && document.querySelector('textarea[name=prompt]')?.value==='Keep the disclosure draft'",
    );
    await b.evaluate(
      "globalThis.bodyHidden=false;document.dispatchEvent(new Event('visibilitychange'))",
    );
    await b.poll(
      "document.querySelector('.otk-tool-toggle')?.getAttribute('aria-expanded')==='false' && document.querySelector('textarea[name=prompt]')?.value==='Keep the disclosure draft'",
    );
    assertEquals(b.errors, []);
    await client.close();
  });
}
