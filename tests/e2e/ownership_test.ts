// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  browserFixture,
  openSession,
  sentFrames,
} from "../support/browser-fixture.ts";
import { FreezeProxy } from "../support/freeze-proxy.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { freePort, OpencodeTest, waitFor } from "../support/opencode.ts";
import { SidecarTest } from "../support/sidecar.ts";

Deno.test("web late creation reply retains a draft typed while RPC was pending", async () => {
  const f = await browserFixture(), proxy = new FreezeProxy(f.oc.port);
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Keep this draft" },
    });
    const server = await f.sidecar({
      harness: { url: `http://127.0.0.1:${proxy.port}`, db: f.oc.db },
    });
    const browser = await f.browser(server.url);
    await openSession(browser, session.id);
    proxy.freeze();
    await browser.click(".otk-new-session");
    await waitFor(
      () => sentFrames(browser),
      (frames) => frames.some(({ frame }) => frame.method === "session.create"),
    );
    await browser.type("textarea[name=prompt]", "Work typed during creation");
    proxy.thaw();
    await browser.poll(
      `!location.hash.endsWith('/${session.id}') && document.querySelector('textarea[name=prompt]').value===''`,
    );
    await openSession(browser, session.id);
    await browser.poll(
      `location.hash.endsWith('/${session.id}') && document.querySelector('textarea[name=prompt]').value === 'Work typed during creation'`,
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('.otk-session-crumb[aria-current] .otk-crumb-title').textContent",
      ),
      "Keep this draft",
    );
  } finally {
    await proxy.stop();
    await f.stop();
  }
});

Deno.test("web removed sidecar cannot reconnect after an in-flight login returns", async () => {
  const f = await browserFixture(),
    fake2 = new FakeLlm(),
    oc2 = await OpencodeTest.start(fake2);
  let remote: SidecarTest | undefined, proxy: FreezeProxy | undefined;
  try {
    const local = await f.sidecar();
    remote = await SidecarTest.start(oc2, {
      server: { port: freePort(), origins: [local.url] },
      auth: {
        type: "password",
        username: "tester",
        password: "secret",
        secretkey: "01234567890123456789012345678901",
      },
    });
    proxy = new FreezeProxy(remote.port);
    const url = `http://127.0.0.1:${proxy.port}`;
    const browser = await f.browser(local.url);
    await browser.poll(
      "document.querySelector('.otk-server-status[data-connection=local]')?.title.includes(': connected;')",
    );
    await browser.click(".otk-settings-entry");
    await browser.poll("!!document.querySelector('input[name=url]')");
    await browser.type("input[name=url]", url);
    await browser.click(
      ".otk-settings-content > .otk-form button[type=submit]",
    );
    const card = "[data-settings-sidecar]:not([data-settings-sidecar=local])";
    await browser.poll(
      `!!document.querySelector('${card} input[name=username]')`,
    );
    await browser.type(`${card} input[name=username]`, "tester");
    await browser.type(`${card} input[name=password]`, "secret");
    proxy.freeze();
    await browser.click(`${card} button[type=submit]`);
    const request = await waitFor(
      () =>
        browser.events.findLast((e) =>
          e.method === "Network.requestWillBeSent" &&
          (e.params.request as { url: string }).url === url + "/api/login"
        ),
      (e) => !!e,
    );
    await browser.click(`${card} > header button`);
    await browser.poll(`!document.querySelector('${card}')`);
    const removed = browser.events.length;
    proxy.thaw();
    await waitFor(
      () => browser.events,
      (events) =>
        events.some((e) =>
          (e.method === "Network.loadingFinished" ||
            e.method === "Network.loadingFailed") &&
          e.params.requestId === request!.params.requestId
        ),
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const remoteSockets = browser.events.slice(removed).filter((e) =>
      e.method === "Network.webSocketCreated" &&
      String(e.params.url).startsWith(url.replace("http:", "ws:"))
    );
    assertEquals(
      remoteSockets,
      [],
      "Removed connection was resurrected by login completion",
    );
    assertEquals(
      await browser.evaluate(
        "JSON.parse(localStorage.getItem('otk.sidecars')).length",
      ),
      0,
    );
  } finally {
    await proxy?.stop();
    await remote?.stop();
    await oc2.stop();
    await fake2.stop();
    await f.stop();
  }
});

Deno.test("web newer selection supersedes a pending session creation without losing its draft", async () => {
  const f = await browserFixture(), proxy = new FreezeProxy(f.oc.port);
  try {
    const a = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Original A" },
    });
    const b = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Newer selection B" },
    });
    const server = await f.sidecar({
      harness: { url: `http://127.0.0.1:${proxy.port}`, db: f.oc.db },
    });
    const browser = await f.browser(server.url);
    await openSession(browser, a.id);
    proxy.freeze();
    await browser.click(".otk-new-session");
    await waitFor(
      () => sentFrames(browser),
      (frames) => frames.some(({ frame }) => frame.method === "session.create"),
    );
    await browser.click(`[data-session="${b.id}"]`);
    await browser.poll(
      `location.hash.endsWith('/${b.id}') && document.querySelector('[data-session="${b.id}"]').getAttribute('aria-current') === 'page'`,
    );
    await browser.type("textarea[name=prompt]", "Belongs to B");
    proxy.thaw();
    await browser.poll(
      "document.querySelectorAll('[data-session]').length === 3",
    );
    await browser.poll(
      `document.querySelector('.otk-session-crumb[aria-current] .otk-crumb-title').textContent === 'Newer selection B' && document.querySelector('textarea[name=prompt]').value === 'Belongs to B'`,
    );
    assertEquals(await browser.evaluate("location.hash"), `#/local/${b.id}`);
  } finally {
    await proxy.stop();
    await f.stop();
  }
});
