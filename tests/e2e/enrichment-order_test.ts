// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  browserFixture,
  openSession,
  waitForReply,
} from "../support/browser-fixture.ts";
import { waitFor } from "../support/opencode.ts";
import { resources, test } from "../support/resources.ts";
import { WsClient } from "../support/ws-client.ts";
import { DatabaseSync } from "node:sqlite";

test("real native B status, text and permission paint during A's held optional clock", async () => {
  const f = await browserFixture({ bash: "ask" });
  const gate = Promise.withResolvers<void>();
  let proxy: Deno.HttpServer | undefined, client: WsClient | undefined;
  let held = false, released = false, clockReads = 0;
  let clockAborts = 0;
  let permissionAcceptedAt: number | undefined;
  let stripped = 0;
  try {
    const a = await f.oc.session<{ id: string; nativeID: string }>("/session", {
      method: "POST",
      body: { title: "A optional clock" },
    });
    const b = await f.oc.session<{ id: string; nativeID: string }>("/session", {
      method: "POST",
      body: { title: "B independent authority" },
    });
    proxy = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async (req) => {
        const url = new URL(req.url);
        const response = await fetch(
          new Request(new URL(url.pathname + url.search, f.oc.url), req),
        );
        if (
          req.method === "GET" &&
          url.pathname.startsWith(`/session/${a.nativeID}/message/`)
        ) {
          clockReads++;
          held = true;
          req.signal.addEventListener("abort", () => {
            if (!released) clockAborts++;
          }, { once: true });
          await gate.promise;
        }
        if (url.pathname !== "/global/event" || !response.body) return response;
        let pending = "";
        return new Response(
          response.body.pipeThrough(new TextDecoderStream()).pipeThrough(
            new TransformStream<string, string>({
              transform(chunk, controller) {
                pending += chunk;
                let end: number;
                while ((end = pending.indexOf("\n\n")) >= 0) {
                  const frame = pending.slice(0, end);
                  pending = pending.slice(end + 2);
                  const data = frame.split("\n").filter((line) =>
                    line.startsWith("data:")
                  ).map((line) => line.slice(5).trim()).join("\n");
                  if (!data) {
                    controller.enqueue(frame + "\n\n");
                    continue;
                  }
                  const envelope = JSON.parse(data),
                    event = envelope.payload ?? envelope;
                  const part = event.properties?.part;
                  if (
                    event.type === "permission.asked" &&
                    event.properties?.sessionID === b.nativeID
                  ) permissionAcceptedAt = performance.now();
                  // The native completion header is authoritative; only optional part
                  // end clocks are withheld, ensuring the actual fallback read is held.
                  if (
                    event.type === "message.part.updated" &&
                    part?.sessionID === a.nativeID &&
                    (part.type === "text" || part.type === "reasoning") &&
                    part.time?.end !== undefined
                  ) {
                    delete part.time.end;
                    stripped++;
                    controller.enqueue(`data: ${JSON.stringify(envelope)}\n\n`);
                  } else controller.enqueue(frame + "\n\n");
                }
              },
            }),
          ).pipeThrough(new TextEncoderStream()),
          { status: response.status, headers: response.headers },
        );
      },
    );
    const server = await f.sidecar({
      harness: {
        url: `http://127.0.0.1:${(proxy.addr as Deno.NetAddr).port}`,
        db: join(f.oc.root, "missing-clock-source.db"),
        requestms: 90000,
      },
    });
    client = new WsClient(server.url);
    await client.connect();
    await client.rpc("prefs.set", { key: "animationsOff", value: true });
    const first = await f.browser(server.url),
      second = await f.browser(server.url);
    await first.send("Browser.grantPermissions", {
      origin: server.url,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    await openSession(first, a.id);
    await openSession(second, b.id);
    // Open-session DOM readiness does not imply every submission catalog has
    // completed. Establish the warm directory before holding native I/O.
    await client.rpc("commands.list", { sessionID: b.id });
    await client.rpc("agents.list", { sessionID: b.id });
    await client.rpc("models.list", { sessionID: b.id });
    f.fake.queue({ chunks: ["A terminal source stays complete."] });
    await first.fill(
      "textarea[name=prompt]",
      "Complete A before its optional clock",
    );
    await first.key("Enter");
    await waitFor(() => Promise.resolve(held), Boolean);
    const heldAt = performance.now();
    f.fake.queue({
      chunks: ["B source is visible while A waits."],
      tool: {
        name: "bash",
        input: { command: "echo independent-b", description: "B permission" },
      },
    }, { chunks: ["B finished."] });
    const sentAt = performance.now();
    await second.fill(
      "textarea[name=prompt]",
      "Show B and ask for its permission",
    );
    await second.poll(
      "document.querySelector('textarea[name=prompt]')?.value==='Show B and ask for its permission' && !!document.querySelector('button[aria-label=Send]')",
    );
    await second.click('button[aria-label="Send"]');
    try {
      await second.poll(
        `document.querySelector('[data-session="${b.id}"]')?.dataset.status==='busy' && document.querySelector('.otk-messages')?.textContent.includes('B source is visible while A waits.') && document.querySelector('.otk-permission-command')?.textContent==='echo independent-b'`,
        35000,
      );
    } catch (error) {
      const db = new DatabaseSync(
        join(f.oc.root, `otk-${server.port}`, "otk.db"),
        { readOnly: true },
      );
      try {
        const diagnostic = {
          a,
          b,
          held,
          released,
          console: second.events.filter((event) =>
            event.method === "Runtime.consoleAPICalled"
          ),
          dom: await second.evaluate(
            "({hash:location.hash, input:document.querySelector('textarea[name=prompt]')?.value, feedback:[...document.querySelectorAll('[role=status],[role=alert]')].filter(el=>el.getAttribute('aria-hidden')!=='true').map(el=>el.textContent), buttons:[...document.querySelectorAll('.otk-prompt button')].map(el=>({label:el.getAttribute('aria-label'),text:el.textContent,hidden:!el.getBoundingClientRect().height}))})",
          ),
          receipts: db.prepare(
            "SELECT client_id,method,state,seq,scope_session,scope_directory,progress_code,error_code FROM request_receipts ORDER BY accepted_at",
          ).all(),
          frames: second.events.filter((event) =>
            event.method === "Network.webSocketFrameSent" ||
            event.method === "Network.webSocketFrameReceived"
          ),
        };
        await Deno.writeTextFile(
          join(f.oc.root, "c6-diagnostic.json"),
          JSON.stringify(diagnostic, null, 2),
        );
        console.info(
          "ENRICHMENT failure",
          JSON.stringify({
            dom: diagnostic.dom,
            receipts: diagnostic.receipts.filter((row) =>
              !["succeeded", "released"].includes(String(row.state))
            ),
          }),
        );
      } finally {
        db.close();
      }
      throw error;
    }
    await waitForReply(first, a.id, "A terminal source stays complete.");
    assert(
      first.events.some((event) => {
        if (event.method !== "Network.webSocketFrameReceived") return false;
        const frame = JSON.parse(
          (event.params.response as { payloadData: string }).payloadData,
        );
        return frame.t === "content" && frame.sessionID === a.id &&
          frame.event.op === "message.upsert" &&
          frame.event.message.time.completed !== undefined;
      }),
      "A terminal event itself must arrive before the held read, not only an HTTP page",
    );
    const paintedMs = performance.now() - sentAt;
    assert(
      permissionAcceptedAt !== undefined,
      "observe the native permission event before its visible consumer",
    );
    const eventToPaintMs = performance.now() - permissionAcceptedAt;
    assertEquals(released, false);
    assert(stripped > 0);
    const destination = Deno.env.get("OTK_ENRICHMENT_SHOTS");
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await second.poll(
        `document.documentElement.dataset.otkTheme==='${theme}'`,
      );
      if (destination) {
        await Deno.mkdir(destination, { recursive: true });
        await second.screenshot(
          join(destination, `${theme}-enrichment-held.png`),
        );
      }
    }
    // Keep the same optional read outstanding for the plan's real 40s case.
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, 40000 - (performance.now() - heldAt)))
    );
    assertEquals(held, true);
    assertEquals(released, false);
    assert(
      clockAborts > 0,
      "urgent validation preempts optional native acquisition",
    );
    assertEquals(
      clockReads - clockAborts,
      1,
      "one latest optional attempt remains held after urgent work",
    );
    await second.poll(
      "document.querySelector('.otk-permission-command')?.textContent==='echo independent-b'",
    );
    released = true;
    gate.resolve();
    await first.click('[data-message-command="reply.copy"]');
    await first.poll(
      "navigator.clipboard.readText().then(text=>text==='A terminal source stays complete.')",
    );
    const approvals = await f.oc.request<{ id: string; sessionID: string }[]>(
      "/permission",
    );
    const approval = approvals.find((request) =>
      request.sessionID === b.nativeID
    )!;
    assert(approval);
    await f.oc.request(`/permission/${approval.id}/reply`, {
      method: "POST",
      body: { reply: "once" },
    });
    await waitForReply(second, b.id, "B finished.");
    await first.reload();
    await waitForReply(first, a.id, "A terminal source stays complete.");
    assertEquals(first.errors, []);
    assertEquals(second.errors, []);
    console.info("ENRICHMENT measurement", {
      heldMs: performance.now() - heldAt,
      paintedMs,
      eventToPaintMs,
      clockReads,
      clockAborts,
      stripped,
    });
    resources().evidence(
      "enrichment timing",
      () =>
        Deno.writeTextFile(
          join(f.oc.root, "enrichment-measurement.json"),
          JSON.stringify({
            paintedMs,
            eventToPaintMs,
            clockReads,
            clockAborts,
            stripped,
          }),
        ),
    );
  } finally {
    released = true;
    gate.resolve();
    await client?.close();
    await f.stop();
    await proxy?.shutdown();
  }
});
