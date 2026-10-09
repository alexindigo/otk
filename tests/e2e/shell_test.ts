// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
Deno.test("a pasted literal bang remains prompt text when subsequent ordinary characters are typed", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Literal bang" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    await browser.click("textarea[name=prompt]");
    await browser.evaluate(
      "(()=>{const data=new DataTransfer();data.setData('text/plain','!literal');document.querySelector('textarea[name=prompt]').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}))})()",
    );
    await browser.poll(
      "(()=>{const input=document.querySelector('textarea[name=prompt]');return input.value==='!literal'&&input.selectionStart===8&&input.selectionEnd===8})()",
    );
    await browser.send("Input.insertText", { text: "x" });
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value.endsWith('x')",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('.otk-prompt > label').textContent",
      ),
      "Prompt",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('textarea[name=prompt]').value",
      ),
      "!literalx",
    );
  } finally {
    await f.stop();
  }
});
Deno.test("P2 shell mode emits bash output without permission, exits locally, and survives long commands", async () => {
  const f = await browserFixture({ bash: "deny" });
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Shell" },
      }),
      server = await f.sidecar(),
      browser = await f.browser(server.url);
    await openSession(browser, session.id);
    await browser.click("textarea[name=prompt]");
    await browser.key("!");
    await browser.type("textarea[name=prompt]", "echo otk");
    await browser.poll(
      "document.querySelector('.otk-prompt > label').textContent==='Shell' && document.querySelector('textarea[name=prompt]').value==='echo otk'",
    );
    await browser.key("Escape");
    await browser.poll(
      "document.querySelector('.otk-prompt > label').textContent==='Prompt' && document.querySelector('textarea[name=prompt]').value==='echo otk'",
    );
    await browser.evaluate(
      "(()=>{const input=document.querySelector('textarea[name=prompt]');input.focus();input.setSelectionRange(0,0)})()",
    );
    await browser.key("!");
    await browser.key("Enter");
    await browser.poll(
      "document.querySelector('[data-tool=bash]').textContent.includes('otk') && document.querySelector('[data-tool=bash]').dataset.toolStatus==='completed' && document.querySelector('textarea[name=prompt]').value===''",
    );
    assertEquals(
      await browser.evaluate(
        "!!document.querySelector('.otk-permission-dock')",
      ),
      false,
    );
    await browser.screenshot(join(f.oc.root, "p2-shell.png"));
    await browser.click("textarea[name=prompt]");
    await browser.key("!");
    await browser.type(
      "textarea[name=prompt]",
      "sleep 31; echo long-shell-finished",
    );
    await browser.key("Enter");
    await browser.poll(
      "!!document.querySelector('[data-tool=bash][data-tool-status=running]') && document.querySelector('textarea[name=prompt]').value===''",
    );
    await browser.type("textarea[name=prompt]", "next draft during command");
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value==='next draft during command' && !document.querySelector('.otk-prompt button[type=submit]').disabled",
    );
    await browser.poll(
      "[...document.querySelectorAll('[data-tool=bash]')].some(el=>el.dataset.toolStatus==='completed'&&el.textContent.includes('long-shell-finished')) && document.querySelector('textarea[name=prompt]').value==='next draft during command'",
      60_000,
    );
    assertEquals(
      await browser.evaluate(
        "!!document.querySelector('.otk-prompt [role=alert]')",
      ),
      false,
    );
  } finally {
    await f.stop();
  }
});

Deno.test("deferred shell failure reaches the session consumer and reload without changing its new draft", async () => {
  const f = await browserFixture();
  let client: WsClient | undefined;
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Deferred shell failure" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    await browser.type("textarea[name=prompt]", "keep this draft");
    client = new WsClient(server.url);
    await client.connect();
    await client.rpc("session.shell", {
      sessionID: session.id,
      command: "echo should-not-run",
      agent: "missing-otk-agent",
    });
    await browser.poll(
      "!!document.querySelector('.otk-messages [role=alert]')?.textContent.trim()",
    );
    const error = await browser.evaluate<string>(
      "document.querySelector('.otk-messages [role=alert]').textContent",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('textarea[name=prompt]').value",
      ),
      "keep this draft",
    );
    assertEquals(
      (await client.rpc<{ error?: string }>("session.get", {
        sessionID: session.id,
      })).error,
      error,
    );
    const url = await browser.evaluate<string>("location.href");
    await browser.goto(url);
    await browser.poll(
      `document.querySelector('.otk-messages [role=alert]')?.textContent===${
        JSON.stringify(error)
      }`,
    );
    assertEquals(f.fake.requests.length, 0);
  } finally {
    await client?.close();
    await f.stop();
  }
});
