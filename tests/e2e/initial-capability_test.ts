// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { fixture } from "../support/config.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { browserFixture } from "../support/browser-fixture.ts";
import { Cdp } from "../support/cdp.ts";
import { waitFor } from "../support/opencode.ts";

// Hold the real handshake until the direct-route consumer has mounted. Replay
// every received frame in order, without changing capabilities or RPC content.
async function holdHandshake(browser: Cdp) {
  await browser.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.heldHandshake = [];
      window.holdHandshake = true;
      window.WebSocket = class extends WebSocket {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', event => {
            if (window.holdHandshake) {
              event.stopImmediatePropagation();
              window.heldHandshake.push(() => this.dispatchEvent(new MessageEvent('message', {data:event.data})));
            }
          });
        }
      };
      window.releaseHandshake = () => {
        window.holdHandshake = false;
        for (const deliver of window.heldHandshake.splice(0)) deliver();
      };
    `,
  });
}
async function releaseHandshake(browser: Cdp) {
  await browser.poll(
    "!!document.querySelector('.otk-prompt') && window.heldHandshake.length > 0",
  );
  assertEquals(
    await browser.evaluate("!!document.querySelector('.otk-permission-dock')"),
    false,
  );
  await browser.evaluate("window.releaseHandshake()");
}
const visiblePermission = `(() => {
  const owner = document.querySelector('.otk-permission-dock');
  return owner && owner.getBoundingClientRect().height > 0 &&
    !!owner.querySelector('button:not(:disabled)');
})()`;

Deno.test("initial direct route and reload render an already pending native permission without switching sessions", async () => {
  const f = await browserFixture({ bash: "ask" });
  let browser: Cdp | undefined;
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Direct pending permission" },
    });
    f.fake.queue({
      tool: {
        name: "bash",
        input: { command: "git status --short", description: "Inspect tree" },
      },
    });
    await f.oc.request(`/session/${session.id}/prompt_async`, {
      method: "POST",
      body: { parts: [{ type: "text", text: "Inspect working tree" }] },
    });
    const native = await waitFor(
      () => f.oc.request<{ id: string; sessionID: string }[]>("/permission"),
      (rows) => rows.some((row) => row.sessionID === session.id),
      60_000,
    );
    const pending = native.find((row) => row.sessionID === session.id)!;
    const server = await f.sidecar();
    browser = await Cdp.launch(f.oc.root);
    await holdHandshake(browser);
    await browser.goto(`${server.url}/#/local/${session.id}`);
    for (const phase of ["direct", "reload"]) {
      if (phase === "reload") await browser.reload();
      await releaseHandshake(browser);
      await browser.poll(
        "document.querySelector('.otk-messages')?.textContent.includes('git status --short')",
      );
      await browser.poll(visiblePermission);
      assertEquals(
        await browser.evaluate("location.hash"),
        `#/local/${session.id}`,
      );
      assert(
        await browser.evaluate<boolean>(
          `document.querySelector('.otk-permission-dock')?.textContent.includes('git status --short')`,
        ),
      );
      assert(
        (await f.oc.request<{ id: string }[]>("/permission")).some((row) =>
          row.id === pending.id
        ),
      );
      console.info("Initial native capability outcome:", phase, pending.id);
    }
    assertEquals(browser.errors, []);
  } finally {
    await browser?.close();
    await f.stop();
  }
});

Deno.test("initial advertised session capabilities activate question and prompt consumers after welcome and reload", async () => {
  const root = await fixture();
  const { app, url } = await coreBackendFixture(root, {
    questions: {
      listQuestions: () =>
        Promise.resolve([{
          id: "initial-question",
          sessionID: "core",
          questions: [{
            text: "Initial question",
            options: [],
            multiple: false,
            custom: true,
          }],
        }]),
      answerQuestion: () => Promise.resolve(),
    },
    prompt: {
      prompt: () => Promise.resolve(),
      abort: () => Promise.resolve(),
    },
  });
  const browser = await Cdp.launch(root);
  try {
    await holdHandshake(browser);
    await browser.goto(`${url}/#/local/core`);
    for (const phase of ["direct", "reload"]) {
      if (phase === "reload") await browser.reload();
      await browser.poll("!!document.querySelector('textarea[name=prompt]')");
      await browser.type("textarea[name=prompt]", "Keep initial draft");
      assertEquals(
        await browser.evaluate(
          "document.querySelector('.otk-prompt button[type=submit]').disabled",
        ),
        true,
      );
      await releaseHandshake(browser);
      await browser.poll(
        "document.querySelector('.otk-messages')?.textContent.includes('Core transcript')",
      );
      await browser.poll(
        "document.querySelector('.otk-question-dock')?.getBoundingClientRect().height > 0 && !document.querySelector('.otk-prompt button[type=submit]').disabled",
      );
      assertEquals(
        await browser.evaluate(
          "document.querySelector('textarea[name=prompt]').value",
        ),
        "Keep initial draft",
      );
      assertEquals(await browser.evaluate("location.hash"), "#/local/core");
      console.info("Initial question/prompt capability outcome:", phase);
    }
    assertEquals(browser.errors, []);
  } finally {
    await browser.close();
    await app.stop();
  }
});
