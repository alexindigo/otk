// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  browserFixture,
  openSession,
  waitForReply,
} from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";

test("U3 response progress follows streaming content, motion preferences, completion and interruption", async () => {
  const f = await browserFixture({ bash: "allow" });
  const shots = Deno.env.get("OTK_STREAM_SHOTS");
  const holds: { release(): void }[] = [];
  let client: WsClient | undefined;
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Response progress" },
    });
    const server = await f.sidecar(), b = await f.browser(server.url);
    client = new WsClient(server.url);
    await client.connect();
    await client.rpc("prefs.set", { key: "animationsOff", value: false });
    await b.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
    });
    await openSession(b, session.id);
    assertEquals(
      await b.evaluate("document.querySelector('.otk-response-progress')"),
      null,
    );

    f.fake.queue({ chunks: ["An earlier reply is finished."] });
    await b.type("textarea[name=prompt]", "Give me a short reply");
    await b.key("Enter");
    await waitForReply(b, session.id, "An earlier reply is finished.");
    const held = f.fake.queueHeld({
      chunks: [
        "The response is still arriving.",
        "\n\nMore content follows here.",
      ],
      delay: 100,
    });
    holds.push(held);
    await b.type("textarea[name=prompt]", "Continue with a longer response");
    await b.key("Enter");
    await b.poll(
      "document.querySelectorAll('[data-role=assistant]').length===2 && document.querySelector('[data-role=assistant]:last-of-type .otk-text')?.textContent.includes('More content follows here.')",
    );

    const capture = async (name: string) => {
      if (shots) await b.screenshot(join(shots, `${name}.png`));
    };
    for (
      const [name, theme] of [["dark", "otk-dark"], ["light", "otk-light"]]
    ) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await capture(`${name}-streaming`);
    }
    await b.poll(
      "document.querySelectorAll('.otk-response-progress').length===1",
    );
    const geometry = await b.evaluate<{
      bottom: boolean;
      flow: string;
      width: number;
      contentWidth: number;
      height: number;
      visible: boolean;
      role: string;
      name: string;
      previous: number;
    }>(
      `(()=>{const articles=[...document.querySelectorAll('[data-role=assistant]')],a=articles.at(-1),c=a.querySelector('.otk-message-content'),p=c.querySelector('.otk-response-progress'),g=p.querySelector('.otk-response-glimmer'),r=p.getBoundingClientRect(),last=p.previousElementSibling.getBoundingClientRect(),f=a.querySelector('footer').getBoundingClientRect();return {bottom:c.lastElementChild===p&&r.top>=last.bottom&&r.bottom<=f.top,flow:getComputedStyle(p).position,width:g.getBoundingClientRect().width,contentWidth:c.getBoundingClientRect().width,height:g.getBoundingClientRect().height,visible:r.top>=0&&r.bottom<=innerHeight,role:p.getAttribute('role'),name:p.getAttribute('aria-label'),previous:articles[0].querySelectorAll('.otk-response-progress').length}})()`,
    );
    assert(geometry.bottom && geometry.visible, JSON.stringify(geometry));
    assertEquals(geometry.flow, "static");
    assertEquals(geometry.width, geometry.contentWidth);
    assertEquals(geometry.height, 2);
    assertEquals([geometry.role, geometry.name, geometry.previous], [
      "status",
      "Response in progress",
      0,
    ]);
    const position = await b.evaluate<string>(
      "getComputedStyle(document.querySelector('.otk-response-glimmer')).backgroundPosition",
    );
    await b.poll(
      `getComputedStyle(document.querySelector('.otk-response-glimmer')).backgroundPosition!==${
        JSON.stringify(position)
      }`,
    );

    const staticVisible =
      "(()=>{const p=document.querySelector('.otk-response-progress'),g=p?.querySelector('.otk-response-glimmer'),t=p?.querySelector('.otk-response-progress-text');return p&&getComputedStyle(g).display==='none'&&getComputedStyle(g).animationName==='none'&&getComputedStyle(t).display==='flex'&&t.getBoundingClientRect().height===20&&t.textContent.trim()==='response in progress'})()";
    await b.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await b.poll(staticVisible);
    for (
      const [name, theme] of [["dark", "otk-dark"], ["light", "otk-light"]]
    ) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await capture(`${name}-reduced-motion`);
    }
    await b.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
    });
    await client.rpc("prefs.set", { key: "animationsOff", value: true });
    await b.poll(staticVisible);
    await b.reload();
    await b.poll(staticVisible);
    await capture("light-animations-off-reload");
    await client.rpc("prefs.set", { key: "animationsOff", value: false });
    await b.poll(
      "getComputedStyle(document.querySelector('.otk-response-glimmer')).display!=='none' && getComputedStyle(document.querySelector('.otk-response-progress-text')).display==='none'",
    );
    held.release();
    await waitForReply(
      b,
      session.id,
      "The response is still arriving.More content follows here.",
    );
    await b.poll("!document.querySelector('.otk-response-progress')");
    for (
      const [name, theme] of [["dark", "otk-dark"], ["light", "otk-light"]]
    ) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await capture(`${name}-complete`);
    }

    f.fake.queue({
      tool: {
        name: "bash",
        input: { command: "pwd", description: "Read project directory" },
      },
    });
    const continued = f.fake.queueHeld({
      chunks: ["The next step is still streaming."],
    });
    holds.push(continued);
    await b.type("textarea[name=prompt]", "Read the directory, then explain");
    await b.key("Enter");
    await b.poll(
      "document.querySelector('[data-role=assistant]:last-of-type .otk-text')?.textContent==='The next step is still streaming.' && document.querySelectorAll('.otk-response-progress').length===1",
    );
    assert(
      await b.evaluate(
        "(()=>{const a=document.querySelector('[data-role=assistant]:last-of-type');return !!a.querySelector('[data-tool=bash]')&&a.querySelector('.otk-message-content').lastElementChild.matches('.otk-response-progress')})()",
      ),
      "Continued backend steps share one progress line after all content",
    );
    await b.key("Escape");
    await b.key("Escape");
    await b.poll(
      `!document.querySelector('.otk-response-progress') && document.querySelector('[data-session="${session.id}"]')?.dataset.status==='idle' && document.querySelector('[data-role=assistant]:last-of-type footer')?.textContent.includes('interrupted')`,
    );
    continued.release();
  } finally {
    for (const hold of holds) hold.release();
    await client?.close();
    await f.stop();
  }
});
