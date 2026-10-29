// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { test } from "../support/resources.ts";
import { browserFixture } from "../support/browser-fixture.ts";
import { helperParent } from "../support/helper-parent.ts";
import { WsClient } from "../support/ws-client.ts";
for (const theme of ["otk-dark", "otk-light"]) {
  test(`helper-heavy parent paints while child reads are held, then progress/removal survives reload (${theme})`, async () => {
    const f = await browserFixture({ bash: "allow" });
    const held = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const reads: string[] = [];
    let holding = true,
      client: WsClient | undefined,
      proxy: Deno.HttpServer | undefined;
    try {
      const { parent, child, work, tool } = await helperParent(f.oc);
      proxy = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        async (req) => {
          const url = new URL(req.url);
          reads.push(url.pathname);
          if (
            holding && url.pathname === `/session/${child.nativeID}/message`
          ) {
            entered.resolve();
            await held.promise;
          }
          const target = new URL(url.pathname + url.search, f.oc.url);
          return await fetch(new Request(target, req));
        },
      );
      const server = await f.sidecar({
        harness: {
          url: `http://127.0.0.1:${(proxy.addr as Deno.NetAddr).port}`,
          db: join(f.oc.root, "absent-native.db"),
        },
        digest: { cpu: 1, retryms: 10, memoryreserve: 1 },
      });
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
      await b.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
      window.helperPaint = undefined; let start;
      const Native = WebSocket;
      window.WebSocket = class extends Native { constructor(...args) { super(...args); this.addEventListener('message', e => { const f=JSON.parse(e.data); if(f.t==='index.snapshot' && start===undefined) start=performance.now(); }); } };
      const inspect=()=>{const cards=[...document.querySelectorAll('.otk-task-card')]; if(start!==undefined && cards.some(el=>el.textContent.includes('Preparing progress…') && el.getBoundingClientRect().bottom>0 && el.getBoundingClientRect().top<innerHeight)) { requestAnimationFrame(()=>{ window.helperPaint={ms:performance.now()-start,cards:cards.length}; }); return; } requestAnimationFrame(inspect); }; requestAnimationFrame(inspect);
    `,
      });
      await b.goto(`${server.url}/helper-review/#/local/${parent.id}`);
      await b.poll("!!window.helperPaint", 10000);
      const paint = await b.evaluate<{ ms: number; cards: number }>(
        "window.helperPaint",
      );
      assert(paint.ms <= 500, JSON.stringify(paint));
      assert(
        paint.cards > 1,
        "helper-heavy newest page rendered actual headers",
      );
      await entered.promise;
      const shots = Deno.env.get("OTK_MESSAGES_SHOTS");
      if (shots) {
        await Deno.mkdir(shots, { recursive: true });
        await b.screenshot(join(shots, `${theme}-helper-preparing.png`));
      }
      const before = reads.length;
      holding = false;
      held.resolve();
      await b.poll(
        "[...document.querySelectorAll('.otk-task-card')].some(el=>el.textContent.includes('1 tool call'))",
        60000,
      );
      if (shots) await b.screenshot(join(shots, `${theme}-helper-ready.png`));
      await f.oc.request(
        `/session/${child.id}/message/${work.info.id}/part/${tool.id}`,
        { method: "DELETE" },
      );
      await b.poll(
        "[...document.querySelectorAll('.otk-task-card')].some(el=>el.textContent.includes('0 tool calls'))",
        60000,
      );
      assertEquals(
        reads.slice(before).filter((path) =>
          path.startsWith(`/session/${parent.nativeID}/message/`)
        ),
        [],
        "Helper progress must never point-read a parent message",
      );
      await b.reload();
      await b.poll(
        "[...document.querySelectorAll('.otk-task-card')].some(el=>el.textContent.includes('0 tool calls'))",
        60000,
      );
      if (shots) {
        await b.screenshot(join(shots, `${theme}-helper-removal-reload.png`));
      }
      console.info(
        "Helper paint and native read evidence",
        JSON.stringify({ theme, paint, reads }),
      );
      assertEquals(b.errors, []);
    } finally {
      holding = false;
      held.resolve();
      await client?.close();
      await f.stop();
      await proxy?.shutdown();
    }
  });
}
