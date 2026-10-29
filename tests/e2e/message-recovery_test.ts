// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { test } from "../support/resources.ts";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { waitFor } from "../support/opencode.ts";

for (const theme of ["otk-dark", "otk-light"]) {
  for (const failFirst of [false, true]) {
    test(`real native reconnect and lost seeds stay refreshing until a terminal source checkpoint (${theme}, retry=${failFirst})`, async () => {
      const f = await browserFixture();
      let client: WsClient | undefined, proxy: Deno.HttpServer | undefined;
      const streams = new Set<TransformStreamDefaultController<string>>();
      let streamCount = 0, lost = 0, deltas = 0;
      const points: string[] = [];
      const snapshots: string[] = [];
      const assistants = new Set<string>();
      let fail = failFirst;
      try {
        const session = await f.oc.session<{ id: string }>("/session", {
          method: "POST",
          body: { title: "Recovering response review" },
        });
        proxy = Deno.serve(
          { hostname: "127.0.0.1", port: 0, onListen() {} },
          async (req) => {
            const url = new URL(req.url),
              target = new URL(url.pathname + url.search, f.oc.url);
            if (
              url.pathname.startsWith(
                `/session/${session.nativeID}/message/`,
              ) &&
              req.method === "GET"
            ) {
              points.push(url.pathname);
              if (fail) {
                fail = false;
                return Response.json({ message: "Checkpoint unavailable" }, {
                  status: 503,
                });
              }
            }
            const response = await fetch(new Request(target, req));
            if (
              url.pathname.startsWith(
                `/session/${session.nativeID}/message/`,
              ) && req.method === "GET"
            ) {
              const snapshot = await response.clone().json();
              snapshots.push(
                snapshot.parts.filter((p: { type: string }) =>
                  p.type === "text"
                ).map((p: { text: string }) => p.text).join("").trim(),
              );
            }
            if (
              url.pathname !== "/global/event" || !response.body
            ) return response;
            streamCount++;
            let pending = "";
            const filter = new TransformStream<string, string>({
              start(controller) {
                streams.add(controller);
              },
              transform(chunk, controller) {
                pending += chunk;
                let end: number;
                while ((end = pending.indexOf("\n\n")) >= 0) {
                  const frame = pending.slice(0, end);
                  pending = pending.slice(end + 2);
                  const data = frame.split("\n").filter((line) =>
                    line.startsWith("data:")
                  ).map((line) => line.slice(5).trim()).join("\n");
                  let drop = false;
                  if (data) {
                    const envelope = JSON.parse(data),
                      event = envelope.payload ?? envelope;
                    const part = event.properties?.part;
                    const info = event.properties?.info;
                    if (
                      event.type === "message.updated" &&
                      info?.role === "assistant"
                    ) assistants.add(info.id);
                    if (
                      event.type === "message.part.updated" &&
                      part?.sessionID === session.nativeID &&
                      assistants.has(part.messageID) &&
                      (part.type === "text" || part.type === "reasoning")
                    ) {
                      lost++;
                      drop = true;
                    }
                    if (
                      event.type === "message.part.delta" &&
                      event.properties?.sessionID === session.nativeID
                    ) deltas++;
                  }
                  if (!drop) controller.enqueue(frame + "\n\n");
                }
              },
              flush(controller) {
                streams.delete(controller);
              },
            });
            return new Response(
              response.body.pipeThrough(new TextDecoderStream()).pipeThrough(
                filter,
              ).pipeThrough(new TextEncoderStream()),
              { status: response.status, headers: response.headers },
            );
          },
        );
        const server = await f.sidecar({
          harness: {
            url: `http://127.0.0.1:${(proxy.addr as Deno.NetAddr).port}`,
          },
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
        await openSession(b, session.id);
        // Close only our test proxy's event responses; the real stock server reconnects.
        const before = streamCount;
        for (const stream of streams) stream.terminate();
        streams.clear();
        await waitFor(() => Promise.resolve(streamCount), (n) => n > before);
        await b.poll(
          "document.querySelector('.otk-prompt') && !document.querySelector('.otk-connection-light.is-reconnecting')",
        );
        const chunks = [
          "Checkpoint source begins. ",
          "Later native source continues. ",
          "Final provider source is complete.",
        ];
        const reply = f.fake.queueStepped({ chunks });
        await b.type(
          "textarea[name=prompt]",
          "Recover the exact native response",
        );
        await b.key("Enter");
        reply.next();
        const shots = Deno.env.get("OTK_MESSAGES_SHOTS");
        if (failFirst) {
          await b.poll(
            "document.querySelector('.otk-response-recovery')?.textContent.includes('Response refresh unavailable.') && !!document.querySelector('.otk-response-recovery button')",
          );
          if (shots) {
            await Deno.mkdir(shots, { recursive: true });
            await b.screenshot(
              join(shots, `${theme}-unavailable-response.png`),
            );
          }
          await b.click(".otk-response-recovery button");
        }
        await b.poll(
          "document.querySelector('.otk-response-recovery')?.textContent==='Refreshing response…'",
        );
        await waitFor(() => Promise.resolve(snapshots.length), (n) => n === 1);
        await b.poll(
          `(document.querySelector('[data-role=assistant] .otk-text')?.textContent.trim() ?? '')===${
            JSON.stringify(snapshots[0])
          }`,
        );
        const firstReads = points.length;
        assertEquals(
          firstReads,
          failFirst ? 2 : 1,
          "one read per initial or explicit retry generation",
        );
        assert(lost > 0);
        if (shots && !failFirst) {
          await Deno.mkdir(shots, { recursive: true });
          await b.screenshot(join(shots, `${theme}-refreshing-response.png`));
        }
        if (!failFirst) {
          await b.send("Emulation.setDeviceMetricsOverride", {
            width: 800,
            height: 700,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await b.click('[aria-label="Collapse projects"]');
          await b.click('[aria-label="Collapse right panel"]');
          await b.poll(
            "document.querySelector('.otk-project-inbox')?.dataset.collapsed==='true' && document.querySelector('.otk-right-panel')?.hidden===true",
          );
          const geometry = await b.evaluate<{ left: number; right: number }>(
            "(()=>{const a=document.querySelector('.otk-message-flow').getBoundingClientRect(), b=document.querySelector('.otk-composer-input').getBoundingClientRect();return {left:Math.abs(a.left-b.left),right:Math.abs(a.right-b.right)}})()",
          );
          assert(
            geometry.left <= 1 && geometry.right <= 1,
            JSON.stringify(geometry),
          );
          if (shots) {
            await b.screenshot(
              join(shots, `${theme}-refreshing-response-narrow.png`),
            );
          }
        }
        reply.next();
        await waitFor(() => Promise.resolve(deltas), (n) => n >= 2);
        await new Promise((resolve) => setTimeout(resolve, 180));
        assertEquals(
          points.length,
          firstReads,
          "more native deltas do not poll HTTP",
        );
        await b.poll(
          "document.querySelector('.otk-response-recovery')?.textContent==='Refreshing response…'",
        );
        assertEquals(
          await b.evaluate(
            "document.querySelector('[data-role=assistant] .otk-text')?.textContent.trim() ?? ''",
          ),
          snapshots[0],
          "unaligned deltas cannot append to the HTTP body",
        );
        reply.next();
        const expected = chunks.join("").trim();
        await b.poll(
          `document.querySelector('[data-role=assistant] .otk-text')?.textContent.trim()===${
            JSON.stringify(expected)
          } && !document.querySelector('.otk-response-recovery')`,
          15000,
        );
        const native = await f.oc.request<
          {
            info: { id: string; role: string };
            parts: { type: string; text?: string }[];
          }[]
        >(`/session/${session.id}/message?limit=10`);
        const final = native.findLast((m) => m.info.role === "assistant")!;
        assertEquals(
          final.parts.filter((p) => p.type === "text").map((p) => p.text).join(
            "",
          )
            .trim(),
          expected,
        );
        assertEquals(
          points.length,
          firstReads + 1,
          "at most one initial and one terminal checkpoint",
        );
        await b.reload();
        await b.poll(
          `document.querySelector('[data-role=assistant] .otk-text')?.textContent.trim()===${
            JSON.stringify(expected)
          } && !document.querySelector('.otk-response-recovery')`,
        );
        await b.poll(
          "!!document.querySelector('.otk-turn-time') && document.querySelector('.otk-turn-time').textContent !== 'streaming'",
        );
        if (shots && !failFirst) {
          await b.screenshot(join(shots, `${theme}-recovered-response.png`));
        }
        console.info(
          "Recovery native evidence",
          JSON.stringify({
            theme,
            failFirst,
            streamCount,
            lost,
            deltas,
            points,
            snapshots,
            expected,
            nativeMessage: final.info.id,
          }),
        );
        assertEquals(b.errors, []);
      } finally {
        await client?.close();
        await f.stop();
        await proxy?.shutdown();
      }
    });
  }
}
