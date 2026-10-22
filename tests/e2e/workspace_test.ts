// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  browserFixture,
  openSession,
  sentFrames,
  streamScript,
} from "../support/browser-fixture.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeTest, waitFor } from "../support/opencode.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { FreezeProxy } from "../support/freeze-proxy.ts";
import type { Cdp } from "../support/cdp.ts";
import {
  assertContentLoaded,
  assertContentReleased,
  sessionHeap,
} from "../support/heap.ts";

async function capture(browser: Cdp, root: string, name: string) {
  const path = join(root, name + ".png");
  await browser.screenshot(path);
  console.info("Browser capture:", path);
}
Deno.test("E1 project inbox and Sessions tree scoped by directory, descendants nested, SPA assets and API boundary", async () => {
  const f = await browserFixture();
  try {
    const root = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Root session" },
    });
    const child = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Child session", parentID: root.id },
    });
    const second = join(f.oc.root, "second-project");
    await Deno.mkdir(second);
    const other = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      directory: second,
      body: { title: "Other project" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await browser.poll(
      "document.querySelectorAll('[data-project]').length === 2",
    );
    await openSession(browser, root.id);
    await browser.poll(
      "document.querySelectorAll('[data-session]').length === 2",
    );
    assertEquals(
      await browser.evaluate(
        `document.querySelector('[data-session="${child.id}"]')?.closest('li')?.dataset.parent`,
      ),
      root.id,
    );
    assertEquals(
      await browser.evaluate(
        `!!document.querySelector('[data-session="${other.id}"]')`,
      ),
      false,
    );
    await openSession(browser, other.id);
    assertEquals(
      await browser.evaluate(
        `document.querySelector('[data-session="${other.id}"]')?.closest('[data-session-project]')?.dataset.sessionProject`,
      ),
      second,
    );
    const html = await fetch(server.url).then((r) => r.text());
    for (const path of ["/login", "/setup", "/nested/route", "/assets/"]) {
      const response = await fetch(server.url + path);
      assertEquals(response.status, 200);
      assertEquals(
        (await response.text()).replace(/<base href="[^"]*">/, ""),
        html.replace(/<base href="[^"]*">/, ""),
      );
    }
    const assetPath = /src="([^"]+\.js)"/.exec(html)![1],
      asset = await fetch(new URL(assetPath, server.url + "/"));
    assertEquals(asset.status, 200);
    assertEquals(
      asset.headers.get("content-type"),
      "text/javascript; charset=utf-8",
    );
    await asset.text();
    const missingApi = await fetch(server.url + "/api/missing");
    assertEquals(missingApi.status, 404);
    await missingApi.text();
    const geometry = await browser.evaluate<
      {
        sidebarRight: number;
        mainLeft: number;
        viewport: number;
        mainBottom: number;
      }
    >("(()=>{const s=document.querySelector('.otk-project-inbox').getBoundingClientRect(),m=document.querySelector('.otk-main').getBoundingClientRect();return {sidebarRight:s.right,mainLeft:m.left,viewport:innerHeight,mainBottom:m.bottom}})()");
    assert(Math.abs(geometry.sidebarRight - geometry.mainLeft) < .5);
    assert(Math.abs(geometry.viewport - geometry.mainBottom) < .5);
    await browser.goto(server.url + "/nested/route");
    await browser.poll(
      "document.querySelectorAll('[data-project]').length === 2 && document.querySelector('.otk-server-status[data-connection=local]').title.includes(': connected;')",
    );
    await openSession(browser, root.id);
    assertEquals(
      await browser.evaluate(
        "document.querySelectorAll('[data-session]').length",
      ),
      2,
    );
    await browser.goto(server.url);
    await browser.poll(
      "document.querySelectorAll('[data-project]').length === 2",
    );
    await openSession(browser, other.id);
    assertEquals(
      await browser.evaluate(
        "document.querySelectorAll('[data-session]').length",
      ),
      1,
    );
    await capture(browser, f.oc.root, "e1-workspace-empty");
  } finally {
    await f.stop();
  }
});
Deno.test("E2 new session, trusted prompt, incremental structured markdown and idle outcome", async () => {
  const f = await browserFixture();
  try {
    const seed = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Existing project" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await browser.poll("!!document.querySelector('.otk-project-open')");
    await browser.click(".otk-project-open");
    await browser.poll(
      "!!document.querySelector('.otk-project-tabs .otk-new-session:not(:disabled)')",
    );
    await browser.poll(
      "!!document.querySelector('.otk-new-session:not(:disabled)')",
    );
    await browser.click(".otk-new-session");
    await browser.poll(
      `!!document.querySelector('.otk-prompt') && location.hash.startsWith('#/local/') && !location.hash.endsWith('/${seed.id}')`,
    );
    const id = await browser.evaluate<string>(
      "location.hash.split('/').at(-1)",
    );
    f.fake.queue(streamScript());
    await browser.type("textarea[name=prompt]", "Show the scripted markdown");
    await browser.key("Enter");
    await browser.poll(
      `document.querySelector('[data-session="${id}"]').dataset.status === 'busy'`,
    );
    const lengths = new Set<number>();
    await waitFor(
      async () => {
        const result = await browser.evaluate<{ text: string; status: string }>(
          `({text:document.querySelector('[data-role=assistant] .otk-text')?.textContent||'',status:document.querySelector('[data-session="${id}"]').dataset.status})`,
        );
        if (result.text.length > 0 && result.status === "busy") {
          lengths.add(result.text.length);
        }
        return result;
      },
      (value) =>
        value.status === "idle" && value.text.includes("const otk = 1;"),
      60_000,
    );
    assert(
      lengths.size >= 3,
      `Only ${lengths.size} intermediate rendered lengths`,
    );
    assertEquals(
      await browser.evaluate(
        "!!document.querySelector('.otk-text h1') && !!document.querySelector('.otk-text ul') && document.querySelector('.otk-text pre')?.textContent.includes('const otk = 1;')",
      ),
      true,
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('[data-role=assistant] .otk-text').textContent.includes('# Streaming') || document.querySelector('[data-role=assistant] .otk-text').textContent.includes('```')",
      ),
      false,
    );
    await browser.poll(
      `document.querySelector('.otk-session-crumb[aria-current] .otk-crumb-title').textContent === document.querySelector('[data-session="${id}"] .otk-row-title').textContent`,
    );
    await capture(browser, f.oc.root, "e2-streamed-markdown");
    console.info("Rendered intermediate lengths:", [...lengths]);
  } finally {
    await f.stop();
  }
});
Deno.test("E5 Esc confirmation then abort yields interrupted footer and idle session", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Interrupt" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    f.fake.queueHeld({ chunks: ["continuing "] });
    await browser.type("textarea[name=prompt]", "Continue slowly");
    await browser.key("Enter");
    await browser.poll(
      `!!document.querySelector('[data-role=assistant] .otk-text') && document.querySelector('[data-session="${session.id}"]')?.dataset.status==='busy'`,
    );
    await browser.key("Escape");
    await browser.poll(
      "document.querySelector('.otk-prompt button[type=submit]').title==='Esc again to interrupt'",
    );
    await browser.key("Escape");
    await browser.poll(
      `document.querySelector('.otk-message-footer')?.textContent.includes('interrupted') && document.querySelector('[data-session="${session.id}"]').dataset.status === 'idle'`,
    );
    assert(
      sentFrames(browser).some(({ frame }) =>
        frame.t === "rpc" && frame.method === "session.abort"
      ),
    );
    const marker =
      `[data-session="${session.id}"] .otk-status-light[data-state=blocked]`;
    await browser.poll(`!!document.querySelector('${marker}')`);
    const dot = await browser.evaluate<
      { width: number; height: number; radius: string }
    >(`(()=>{const el=document.querySelector('${marker}'),r=el.getBoundingClientRect();return {width:r.width,height:r.height,radius:getComputedStyle(el.querySelector('.otk-lamp-body')).borderRadius}})()`);
    assert(
      dot.width === 8 && Math.abs(dot.width - dot.height) < .5 &&
        dot.radius === "50%",
      "Error status must use the shared circular marker",
    );
    await capture(browser, f.oc.root, "e5-interrupted");
  } finally {
    await f.stop();
  }
});
Deno.test("E6 frozen harness stream resyncs complete reply and idle without reload", async () => {
  const f = await browserFixture(), proxy = new FreezeProxy(f.oc.port);
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Recovery" },
    });
    const server = await f.sidecar({
      harness: {
        url: `http://127.0.0.1:${proxy.port}`,
        db: f.oc.db,
        heartbeattimeout: 2,
      },
    });
    const browser = await f.browser(server.url);
    await openSession(browser, session.id);
    f.fake.queue(streamScript());
    await browser.type("textarea[name=prompt]", "Stream then recover");
    await browser.key("Enter");
    await browser.poll(
      "(document.querySelector('[data-role=assistant] .otk-text')?.textContent.length || 0) > 1",
    );
    const navigations = browser.events.filter((event) =>
      event.method === "Page.frameNavigated"
    ).length;
    proxy.freeze();
    await browser.poll(
      "document.querySelector('.otk-server-status[data-connection=local]').title.includes('agent service reconnecting')",
    );
    proxy.thaw();
    await browser.poll(
      `document.querySelector('.otk-text pre')?.textContent.includes('const otk = 1;') && document.querySelector('[data-session="${session.id}"]').dataset.status === 'idle'`,
      60_000,
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('[data-role=assistant] .otk-text h1')?.textContent === 'Streaming' && document.querySelector('[data-role=assistant] .otk-text p')?.textContent === 'An incremental reply.' && [...document.querySelectorAll('[data-role=assistant] .otk-text li')].map(el=>el.textContent.trim()).join(',') === 'first,second'",
      ),
      true,
    );
    assertEquals(
      browser.events.filter((event) => event.method === "Page.frameNavigated")
        .length,
      navigations,
    );
    await capture(browser, f.oc.root, "e6-recovered");
  } finally {
    await proxy.stop();
    await f.stop();
  }
});
Deno.test("E7 add authenticated second sidecar, merged groups, prompt and persistence", async () => {
  const f = await browserFixture(),
    fake2 = new FakeLlm(),
    oc2 = await OpencodeTest.start(fake2);
  let second: SidecarTest | undefined;
  try {
    await f.oc.request("/session", {
      method: "POST",
      body: { title: "First host" },
    });
    const remote = await oc2.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Second host" },
    });
    const server = await f.sidecar({ server: { port: 1502 } });
    second = await SidecarTest.start(oc2, {
      server: { port: 31502, origins: [server.url] },
      auth: {
        type: "password",
        username: "tester",
        password: "secret",
        secretkey: "01234567890123456789012345678901",
      },
    });
    const browser = await f.browser(server.url);
    await browser.poll(
      "document.querySelector('.otk-server-status[data-connection=local]')?.title.includes(': connected;')",
    );
    await browser.click(".otk-settings-entry");
    await browser.poll("!!document.querySelector('input[name=url]')");
    await browser.type("input[name=url]", second.url);
    await browser.type("input[name=label]", "Remote agent");
    await browser.click(
      ".otk-settings .otk-settings-content > .otk-form button[type=submit]",
    );
    await browser.poll(
      "!!document.querySelector('[data-settings-sidecar]:not([data-settings-sidecar=local]) input[name=username]')",
    );
    await browser.type(
      "[data-settings-sidecar]:not([data-settings-sidecar=local]) input[name=username]",
      "tester",
    );
    await browser.type(
      "[data-settings-sidecar]:not([data-settings-sidecar=local]) input[name=password]",
      "secret",
    );
    await browser.click(
      "[data-settings-sidecar]:not([data-settings-sidecar=local]) button[type=submit]",
    );
    await browser.poll(
      "document.querySelectorAll('.otk-sidecar-card [data-connection]').length === 2 && [...document.querySelectorAll('.otk-sidecar-card [data-connection]')].every(el=>el.textContent==='connected')",
    );
    await browser.click(".otk-view-header button");
    await openSession(browser, remote.id);
    fake2.queue({ chunks: ["Reply from the second sidecar"] });
    await browser.type("textarea[name=prompt]", "Remote prompt");
    await browser.key("Enter");
    await browser.poll(
      "document.querySelector('[data-role=assistant] .otk-text')?.textContent.includes('Reply from the second sidecar')",
    );
    const stored = await browser.evaluate<{ baseUrl: string; label: string }[]>(
      "JSON.parse(localStorage.getItem('otk.sidecars'))",
    );
    assertEquals(stored.length, 1);
    assertEquals(stored[0].baseUrl, second.url);
    assertEquals(stored[0].label, "Remote agent");
    await capture(browser, f.oc.root, "e7-two-sidecars");
    await browser.reload();
    await browser.poll(
      "document.querySelectorAll('.otk-project-inbox [data-project]').length === 2 && document.querySelectorAll('[data-session]').length === 1",
    );
  } finally {
    await second?.stop();
    await oc2.stop();
    await fake2.stop();
    await f.stop();
  }
});
Deno.test("E8 switch releases >=2 MB session objects, unsubscribes and removes its DOM", async () => {
  const f = await browserFixture();
  try {
    const a = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Large session A" },
    });
    const b = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Small session B" },
    });
    await f.oc.request(`/session/${b.id}/message`, {
      method: "POST",
      body: {
        noReply: true,
        parts: [{ type: "text", text: "Small session text" }],
      },
    });
    const large = "OTK_LARGE_SESSION_A_" + "x".repeat(2 * 1024 * 1024);
    f.fake.queue({ chunks: [large], delay: 10 });
    await f.oc.request(`/session/${a.id}/prompt_async`, {
      method: "POST",
      body: { parts: [{ type: "text", text: "Large reply" }] },
    });
    await waitFor(
      () =>
        f.oc.request<
          { info: { role: string; time: { completed?: number } } }[]
        >(`/session/${a.id}/message`),
      (messages) =>
        messages.some((m) =>
          m.info.role === "assistant" && !!m.info.time.completed
        ),
      60_000,
    );
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, b.id);
    await browser.poll("document.fonts.status === 'loaded'");
    // Three equivalent navigation cycles: every loaded snapshot is a positive
    // control, followed by one fixed post-disposal snapshot, never heap polling.
    for (let cycle = 0; cycle < 3; cycle++) {
      await openSession(browser, a.id);
      await browser.poll(
        "(document.querySelector('[data-role=assistant] .otk-text')?.textContent.length || 0) >= 2097152",
      );
      const loaded = await sessionHeap(browser, a.id, "OTK_LARGE_SESSION_A_");
      assertContentLoaded(loaded);
      await openSession(browser, b.id);
      await browser.poll(
        "document.querySelector('.otk-messages').textContent.includes('Small session text')",
      );
      await browser.evaluate(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
      const released = await sessionHeap(browser, a.id, "OTK_LARGE_SESSION_A_");
      console.info("E8 session content identities", {
        cycle,
        loaded,
        released,
      });
      assertContentReleased(released);
    }
    assert(
      sentFrames(browser).some(({ frame }) =>
        frame.t === "unsubscribe" && frame.sessionID === a.id
      ),
    );
    assertEquals(
      await browser.evaluate(
        "document.body.textContent.includes('OTK_LARGE_SESSION_A_')",
      ),
      false,
    );
  } finally {
    await f.stop();
  }
});
Deno.test("E9 serving-sidecar wrong password error then correct login", async () => {
  const f = await browserFixture();
  try {
    await f.oc.request("/session", {
      method: "POST",
      body: { title: "Password session" },
    });
    const server = await f.sidecar({
      auth: {
        type: "password",
        username: "tester",
        password: "secret",
        secretkey: "01234567890123456789012345678901",
      },
    });
    const browser = await f.browser(server.url);
    await browser.poll(
      "!!document.querySelector('.otk-auth-view input[name=username]')",
    );
    await capture(browser, f.oc.root, "e9-login");
    await browser.type("input[name=username]", "tester");
    await browser.type("input[name=password]", "wrong");
    await browser.click(".otk-auth-view button[type=submit]");
    await browser.poll(
      "document.querySelector('.otk-auth-view [role=alert]')?.textContent.includes('Incorrect login credentials')",
    );
    await capture(browser, f.oc.root, "e9-login-error");
    await browser.fill("input[name=password]", "secret");
    await browser.click(".otk-auth-view button[type=submit]");
    await browser.poll(
      "document.querySelector('.otk-server-status[data-connection=local]').title.includes(': connected;') && document.querySelectorAll('[data-project]').length === 1 && !document.querySelector('.otk-auth-view')",
    );
    await browser.click(".otk-project-open");
    await browser.poll(
      "document.querySelectorAll('[data-session]').length === 1",
    );
  } finally {
    await f.stop();
  }
});
Deno.test("E10 75-second idle browser stays connected and sends JSON pongs at 20-second intervals", async () => {
  const f = await browserFixture();
  try {
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await browser.poll(
      "document.querySelector('.otk-server-status[data-connection=local]')?.title.includes(': connected;')",
    );
    const start = browser.events.length;
    await new Promise((resolve) => setTimeout(resolve, 75_000));
    assertEquals(
      await browser.evaluate(
        "document.querySelector('.otk-server-status[data-connection=local]').title.split(': ')[1].split(';')[0]",
      ),
      "connected",
    );
    const pongs = sentFrames(browser).filter(({ frame }) => frame.t === "pong");
    assert(pongs.length >= 3, JSON.stringify(pongs));
    for (let i = 1; i < pongs.length; i++) {
      assert(
        pongs[i].time - pongs[i - 1].time > 19 &&
          pongs[i].time - pongs[i - 1].time < 21,
      );
    }
    assertEquals(
      browser.events.slice(start).filter((event) =>
        ["Network.webSocketCreated", "Network.webSocketClosed"].includes(
          event.method,
        )
      ),
      [],
    );
    console.info(
      "JSON pongs observed at CDP timestamps:",
      pongs.map((pong) => pong.time),
    );
  } finally {
    await f.stop();
  }
});
Deno.test("web setup persists auth choice and routes back/forward select the correct session", async () => {
  const f = await browserFixture();
  try {
    const a = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "History A" },
    });
    const b = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "History B" },
    });
    const server = await f.sidecar({ auth: { type: "" } }),
      browser = await f.browser(server.url);
    await browser.poll(
      "!!document.querySelector('.otk-auth-view select[name=type]')",
    );
    await capture(browser, f.oc.root, "setup");
    await browser.type("input[name=username]", "tester");
    await browser.type("input[name=password]", "secret");
    await browser.click(".otk-auth-view button[type=submit]");
    await browser.poll(
      "!!document.querySelector('.otk-auth-view input[name=username]') && !document.querySelector('select[name=type]')",
    );
    await browser.type("input[name=username]", "tester");
    await browser.type("input[name=password]", "secret");
    await browser.click(".otk-auth-view button[type=submit]");
    await openSession(browser, a.id);
    await openSession(browser, b.id);
    await browser.evaluate("history.back()");
    await browser.poll(
      `location.hash.endsWith('/${a.id}') && document.querySelector('.otk-session-crumb[aria-current] .otk-crumb-title')?.textContent === 'History A'`,
    );
    await browser.evaluate("history.forward()");
    await browser.poll(
      `location.hash.endsWith('/${b.id}') && document.querySelector('.otk-session-crumb[aria-current] .otk-crumb-title')?.textContent === 'History B'`,
    );
    const auth = await browser.evaluate(
      "fetch('api/session').then(r=>r.json())",
    );
    assertEquals(auth, {
      authenticated: true,
      setupRequired: false,
      authType: "password",
    });
  } finally {
    await f.stop();
  }
});

Deno.test("web history paging preserves viewport and autoscroll follows only the bottom", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Long history" },
    });
    for (let i = 0; i < 103; i++) {
      await f.oc.request(`/session/${session.id}/message`, {
        method: "POST",
        body: {
          noReply: true,
          parts: [{ type: "text", text: `History row ${i}` }],
        },
      });
    }
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    await browser.poll(
      "document.querySelectorAll('[data-message]').length === 100 && document.querySelector('.otk-messages').scrollTop > 100",
    );
    const point = await browser.evaluate<{ x: number; y: number }>(
      "(()=>{const r=document.querySelector('.otk-messages').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
    );
    await browser.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...point,
      deltaX: 0,
      deltaY: -100000,
    });
    await browser.poll(
      "document.querySelectorAll('[data-message]').length === 103 && document.querySelector('.otk-messages').textContent.includes('History row 0')",
    );
    const before = await browser.evaluate<number>(
      "document.querySelector('.otk-messages').scrollTop",
    );
    const olderReply = f.fake.queueHeld({
      chunks: Array(30).fill("While you read older messages. "),
      delay: 50,
    });
    await browser.type("textarea[name=prompt]", "Stay above the new response");
    await browser.key("Enter");
    await browser.poll(
      `document.querySelector('[data-session="${session.id}"]').dataset.status === 'busy'`,
    );
    olderReply.release();
    await browser.poll(
      `document.querySelector('[data-session="${session.id}"]').dataset.status === 'idle' && !!document.querySelector('[data-role=assistant]')`,
    );
    const after = await browser.evaluate<{ top: number; gap: number }>(
      "(()=>{const el=document.querySelector('.otk-messages');return {top:el.scrollTop,gap:el.scrollHeight-el.clientHeight-el.scrollTop}})()",
    );
    assert(
      Math.abs(before - after.top) < 2,
      `User scroll moved: ${before} -> ${after.top}`,
    );
    assert(after.gap > 100);
    await browser.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...point,
      deltaX: 0,
      deltaY: 100000,
    });
    await browser.poll(
      "(()=>{const el=document.querySelector('.otk-messages');return el.scrollHeight-el.clientHeight-el.scrollTop < 2})()",
    );
    const followingReply = f.fake.queueHeld(streamScript());
    await browser.type("textarea[name=prompt]", "Follow the bottom");
    await browser.key("Enter");
    await browser.poll(
      `document.querySelector('[data-session="${session.id}"]').dataset.status === 'busy'`,
    );
    followingReply.release();
    await browser.poll(
      `document.querySelector('[data-session="${session.id}"]').dataset.status === 'idle' && !!document.querySelector('.otk-text pre')`,
    );
    await browser.poll(
      "(()=>{const el=document.querySelector('.otk-messages');return el.scrollHeight-el.clientHeight-el.scrollTop < 2})()",
    );
  } finally {
    await f.stop();
  }
});

Deno.test("web history navigation retains each session's draft and keeps URL and content together", async () => {
  const f = await browserFixture();
  try {
    const a = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Draft A" },
    });
    const b = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Draft B" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, a.id);
    await openSession(browser, b.id);
    await browser.type("textarea[name=prompt]", "Unsent work");
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value === 'Unsent work' && !document.querySelector('.otk-prompt button[type=submit]').disabled",
    );
    await browser.evaluate("history.back()");
    await browser.poll(
      `location.hash.endsWith('/${a.id}') && document.querySelector('.otk-session-crumb[aria-current] .otk-crumb-title').textContent === 'Draft A' && document.querySelector('textarea[name=prompt]').value === ''`,
    );
    await browser.evaluate("history.forward()");
    await browser.poll(
      `location.hash.endsWith('/${b.id}') && document.querySelector('.otk-session-crumb[aria-current] .otk-crumb-title').textContent === 'Draft B' && document.querySelector('textarea[name=prompt]').value === 'Unsent work'`,
    );
  } finally {
    await f.stop();
  }
});

Deno.test("web sidecar restart resubscribes open session and refetches final content without reload", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Socket recovery" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    f.fake.queue(streamScript());
    await browser.type(
      "textarea[name=prompt]",
      "Keep the session across reconnection",
    );
    await browser.key("Enter");
    await browser.poll(
      "(document.querySelector('[data-role=assistant] .otk-text')?.textContent.length || 0) > 1",
    );
    const nav = browser.events.filter((event) =>
      event.method === "Page.frameNavigated"
    ).length;
    await server.stop();
    await f.sidecar({ server: { port: server.port } });
    await browser.poll(
      `document.querySelector('.otk-server-status[data-connection=local]').title.includes(': connected;') && document.querySelector('.otk-text pre')?.textContent.includes('const otk = 1;') && document.querySelector('[data-session="${session.id}"]').dataset.status === 'idle'`,
      60_000,
    );
    assert(
      sentFrames(browser).filter(({ frame }) =>
        frame.t === "subscribe" && frame.sessionID === session.id
      ).length >= 2,
    );
    assertEquals(
      browser.events.filter((event) => event.method === "Page.frameNavigated")
        .length,
      nav,
    );
  } finally {
    await f.stop();
  }
});

Deno.test("web renders all remaining markdown block and inline kinds from the real adapter", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Typed markdown" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    const rich =
      "## Structured content\n\n**strong** *emphasis* ~~deleted~~ `inline` [reference](https://example.test/docs)\n\nline one  \nline two\n\n> quoted content\n\n3. numbered\n4. next item\n\n- [x] checked task\n\n| Name | Value |\n| :--- | ---: |\n| alpha | 42 |\n\n---\n\n![fixture](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2WQAAAAASUVORK5CYII=)\n";
    f.fake.queue({ chunks: [rich] });
    await browser.type(
      "textarea[name=prompt]",
      "Render the structured fixture",
    );
    await browser.key("Enter");
    await browser.poll(
      `document.querySelector('[data-session="${session.id}"]').dataset.status === 'idle' && !!document.querySelector('.otk-text table')`,
    );
    const rendered = await browser.evaluate(
      "(()=>{const el=document.querySelector('[data-role=assistant] .otk-text');return {heading:el.querySelector('h2')?.textContent,strong:el.querySelector('strong')?.textContent,em:el.querySelector('em')?.textContent,del:el.querySelector('del')?.textContent,code:el.querySelector('code')?.textContent,link:el.querySelector('a')?.getAttribute('rel'),target:el.querySelector('a')?.target,br:!!el.querySelector('br'),quote:el.querySelector('blockquote')?.textContent.trim(),start:el.querySelector('ol')?.start,task:el.querySelector('input[type=checkbox]')?.checked,rule:!!el.querySelector('hr'),cells:[...el.querySelectorAll('td')].map(td=>td.textContent),image:el.querySelector('img')?.alt}})()",
    );
    assertEquals(rendered, {
      heading: "Structured content",
      strong: "strong",
      em: "emphasis",
      del: "deleted",
      code: "inline",
      link: "noopener noreferrer",
      target: "_blank",
      br: true,
      quote: "quoted content",
      start: 3,
      task: true,
      rule: true,
      cells: ["alpha", "42"],
      image: "fixture",
    });
    await browser.poll(
      "document.querySelector('.otk-text img')?.naturalWidth === 1",
    );
    await capture(browser, f.oc.root, "typed-markdown");
  } finally {
    await f.stop();
  }
});
