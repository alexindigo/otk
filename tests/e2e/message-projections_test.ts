// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { test } from "../support/resources.ts";
import {
  browserFixture,
  openSession,
  sentFrames,
  waitForReply,
} from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { menuReady } from "../support/menu.ts";
import { waitFor } from "../support/opencode.ts";
import {
  type AssistantMessage,
  type TurnUsageDetail,
  usageHeader,
  UsageLedger,
} from "@otk/protocol";
import { fixture } from "../support/config.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { publishUsage, turnDetail } from "../support/usage-summary.ts";

for (const theme of ["otk-dark", "otk-light"]) {
  test(`native 102-step reply opens only its complete turn ledger and copies off-page source (${theme})`, async () => {
    const f = await browserFixture({ bash: "allow" });
    let client: WsClient | undefined;
    try {
      const session = await f.oc.session<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Complete reply review" },
      });
      const markers = Array.from(
        { length: 102 },
        (_, i) => `Projection step ${String(i).padStart(3, "0")}.`,
      );
      for (let i = 0; i < 101; i++) {
        f.fake.queue({
          chunks: [markers[i]],
          tool: {
            name: "bash",
            input: { command: "true", description: `Inspect step ${i}` },
          },
        });
      }
      f.fake.queue({ chunks: [markers[101]] });
      await f.oc.request(`/session/${session.id}/prompt_async`, {
        method: "POST",
        body: {
          agent: "build",
          model: { providerID: "fake", modelID: "scripted" },
          parts: [{
            type: "text",
            text: "Read every step before copying the complete reply",
          }],
        },
      });
      // Admission is a bounded request; completing 102 native calls is a job.
      // Require both the complete scripted turn and terminal native status.
      await waitFor(
        () => f.fake.requests.length,
        (count) => count === markers.length,
      );
      await waitFor(
        () => f.oc.request<Record<string, unknown>>("/session/status"),
        (state) => !state[session.nativeID],
      );
      const server = await f.sidecar();
      client = new WsClient(server.url);
      await client.connect();
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await client.rpc("prefs.set", { key: "animationsOff", value: true });
      const b = await f.browser(server.url);
      await b.send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await b.send("Browser.grantPermissions", {
        origin: server.url,
        permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
      });
      await openSession(b, session.id);
      await b.poll(
        `(()=>{const pane=document.querySelector('.otk-messages'),v=pane.getBoundingClientRect(),source=[...pane.querySelectorAll('.otk-text')].find(e=>e.textContent===${
          JSON.stringify(markers[101])
        }),footer=pane.querySelector('.otk-message-footer');if(!source||!footer)return false;const a=source.getBoundingClientRect(),z=footer.getBoundingClientRect();return a.bottom>v.top && a.top<v.bottom && z.top>=v.top && z.bottom<=v.bottom+1 && pane.scrollHeight-pane.clientHeight-pane.scrollTop<=1})()`,
      );
      await waitForReply(b, session.id, markers[101]);
      await b.poll(
        "document.querySelector('.otk-turn-usage > button')?.textContent.includes('102 model calls')",
      );
      assertEquals(
        sentFrames(b).filter(({ frame }) => frame.method === "usage.get")
          .length,
        0,
        "closed breakdown does no detail work",
      );
      // Reserve-page measurement may replace the footer while fonts/layout
      // settle. A detached trigger has a stable zero rect, not a hover point.
      const point = await b.poll(`(async()=>{
        await document.fonts.ready;
        const selector='.otk-turn-usage > button',e=document.querySelector(selector);
        if(!e)return false;
        let r=e.getBoundingClientRect();
        for(let frame=0;frame<2;frame++){
          await new Promise(requestAnimationFrame);
          const next=e.getBoundingClientRect();
          if(!e.isConnected||e!==document.querySelector(selector)||!next.width||!next.height||r.x!==next.x||r.y!==next.y||r.width!==next.width||r.height!==next.height)return false;
          r=next;
        }
        const point={x:r.x+r.width/2,y:r.y+r.height/2};
        return e.contains(document.elementFromPoint(point.x,point.y))?point:false;
      })()`) as { x: number; y: number };
      await b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...point,
      });
      await b.poll(
        "document.querySelectorAll('.otk-usage-breakdown tbody tr').length===102",
      );
      const requests = sentFrames(b).filter(({ frame }) =>
        frame.method === "usage.get"
      );
      assertEquals(requests.length, 1);
      assert(
        typeof (requests[0].frame.params as { turnID?: string }).turnID ===
          "string",
        "detail acquisition carries the exact turn identity",
      );
      const shots = Deno.env.get("OTK_MESSAGES_SHOTS");
      if (shots) {
        await Deno.mkdir(shots, { recursive: true });
        await b.screenshot(join(shots, `${theme}-102-ledger.png`));
      }
      await b.key("Escape");
      await b.poll("!document.querySelector('.otk-turn-usage :popover-open')");
      await b.click('[data-message-command="reply.copy"]');
      await b.poll(
        `navigator.clipboard.readText().then(text=>text===${
          JSON.stringify(markers.join("\n\n"))
        })`,
        15000,
      );
      assertEquals(
        await b.evaluate(
          "document.querySelectorAll('.otk-message-footer').length",
        ),
        1,
      );
      // 102 prose segments and 101 work groups remain logical rows; only the
      // visible groups mount, independently of how many source pages copy acquired.
      assertEquals(
        await b.evaluate(
          "Number(document.querySelector('[aria-label=\"Reply segments\"]').dataset.acquiredCount)",
        ),
        203,
      );
      assert(
        (await b.evaluate<number>(
          "document.querySelectorAll('.otk-work-log').length",
        )) < 101,
      );
      assert(
        sentFrames(b).filter(({ frame }) => frame.method === "session.messages")
          .length >= 11,
      );
      // Prefix acquisition changes the native first step, never the reply's action-owner lifetime.
      const contextPoint = await b.evaluate<{ x: number; y: number }>(
        `(async()=>{
        const e=[...document.querySelectorAll('.otk-message-content p')].at(-1);
        e.scrollIntoView({block:'center',behavior:'instant'});
        await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
        const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};
      })()`,
      );
      for (const type of ["mousePressed", "mouseReleased"]) {
        await b.send("Input.dispatchMouseEvent", {
          type,
          ...contextPoint,
          button: "right",
          buttons: type === "mousePressed" ? 2 : 0,
          clickCount: 1,
        });
      }
      const menu = ':popover-open [role="menu"][aria-label="Context menu"]';
      await menuReady(b, menu);
      await b.poll(
        `[...document.querySelectorAll('${menu} button')].some(e=>e.textContent==='Show usage breakdown')`,
        3000,
      );
      const usagePoint = await b.evaluate<{ x: number; y: number }>(
        `(()=>{const e=[...document.querySelectorAll('${menu} button')].find(e=>e.textContent==='Show usage breakdown');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      );
      for (const type of ["mousePressed", "mouseReleased"]) {
        await b.send("Input.dispatchMouseEvent", {
          type,
          ...usagePoint,
          button: "left",
          buttons: type === "mousePressed" ? 1 : 0,
          clickCount: 1,
        });
      }
      await b.poll(
        "document.querySelectorAll('.otk-usage-breakdown tbody tr').length===102",
      );
      await b.key("Escape");
      await b.poll("!document.querySelector('.otk-turn-usage :popover-open')");
      if (shots) {
        await b.screenshot(join(shots, `${theme}-102-complete-copy.png`));
      }
      await b.send("Emulation.setDeviceMetricsOverride", {
        width: 800,
        height: 700,
        deviceScaleFactor: 1,
        mobile: false,
      });
      for (const label of ["Collapse projects", "Collapse right panel"]) {
        if (
          await b.evaluate(
            `!!document.querySelector('[aria-label="${label}"]')`,
          )
        ) await b.click(`[aria-label="${label}"]`);
      }
      await b.poll(
        "(()=>{const a=document.querySelector('.otk-message-flow').getBoundingClientRect(),b=document.querySelector('.otk-composer-input').getBoundingClientRect();return Math.abs(a.left-b.left)<=1 && Math.abs(a.right-b.right)<=1})()",
      );
      assertEquals(
        await b.evaluate("navigator.clipboard.readText()"),
        markers.join("\n\n"),
      );
      if (shots) {
        await b.screenshot(join(shots, `${theme}-102-copy-narrow.png`));
      }
      assertEquals(b.errors, []);
    } finally {
      await client?.close();
      await f.stop();
    }
  });
}

for (const theme of ["otk-dark", "otk-light"]) {
  test(`turn detail renders unreported live categories honestly and distinguishes reported zero (${theme})`, async () => {
    const root = await fixture();
    const message = (input: number | null): AssistantMessage => ({
      id: "call",
      role: "assistant",
      replyTo: "prompt",
      sessionID: "tstv1-core",
      agent: "build",
      model: { provider: "test", model: "test" },
      time: { created: 1, completed: 2 },
      tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: input,
      interrupted: false,
      parts: [{
        id: "text",
        kind: "text",
        synthetic: false,
        blocks: [{
          b: "paragraph",
          inline: [{
            i: "text",
            text: "Usage reported independently of loaded pages.",
          }],
        }],
      }],
    });
    const ledger = new UsageLedger("tstv1-core", [usageHeader(message(null))]);
    const f = await coreBackendFixture(root, {
      usage: {
        getUsage: (_id, turnID): Promise<TurnUsageDetail> =>
          Promise.resolve(
            turnDetail(ledger.snapshot(), turnID, f.clock()),
          ),
      },
    });
    f.app.backend.core.listMessages = () =>
      Promise.resolve(f.page([message(null)]));
    publishUsage(f.app.index, ledger.snapshot());
    const client = new WsClient(f.url);
    await client.connect();
    const { Cdp } = await import("../support/cdp.ts");
    const b = await Cdp.launch(root);
    try {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.goto(`${f.url}/#/local/tstv1-core`);
      await b.poll(
        "document.querySelector('.otk-turn-usage > button')?.textContent.includes('Cost unavailable')",
      );
      const point = await b.evaluate<{ x: number; y: number }>(
        "(()=>{const e=document.querySelector('.otk-turn-usage > button');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
      );
      await b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...point,
      });
      await b.poll(
        "document.querySelector('.otk-usage-breakdown tbody tr')?.children[3].textContent==='Not reported'",
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('.otk-usage-breakdown tbody tr').children[8].textContent",
        ),
        "Not reported",
      );
      const shots = Deno.env.get("OTK_MESSAGES_SHOTS");
      if (shots) {
        await Deno.mkdir(shots, { recursive: true });
        await b.screenshot(join(shots, `${theme}-unreported-usage.png`));
      }
      const next = message(0);
      ledger.upsert(usageHeader(next));
      f.app.connections.content("tstv1-core", {
        op: "message.upsert",
        message: next,
      });
      publishUsage(f.app.index, ledger.snapshot());
      await b.poll(
        "document.querySelector('.otk-usage-breakdown tbody tr')?.children[3].textContent==='0' && document.querySelector('.otk-usage-breakdown tbody tr')?.children[8].textContent==='$0.00'",
      );
      assertEquals(b.errors, []);
    } finally {
      await b.close();
      await client.close();
      await f.app.stop();
    }
  });
}
