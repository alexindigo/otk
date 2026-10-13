// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { waitFor } from "../support/opencode.ts";
import {
  assertErrorConsumer,
  reloadErrorConsumer,
} from "../support/error-consumer.ts";

Deno.test("HTTP-only failure is visible with real transport provenance, current draft and reload without requiring an event", async () => {
  const f = await browserFixture();
  let client: WsClient | undefined;
  let refused = 0;
  const proxy = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, (request) => {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.endsWith("/shell")) {
      refused++;
      return Response.json({
        name: "ProxyFailure",
        data: {
          message: "The shell endpoint is unavailable at this proxy.",
          ref: "proxy-http-only",
        },
      }, { status: 503 });
    }
    return fetch(
      new Request(new URL(url.pathname + url.search, f.oc.url), request),
    );
  });
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "HTTP-only failure" },
    });
    const server = await f.sidecar({
      harness: { url: `http://127.0.0.1:${proxy.addr.port}`, db: f.oc.db },
    });
    const browser = await f.browser(server.url);
    await openSession(browser, session.id);
    await browser.type(
      "textarea[name=prompt]",
      "HTTP failure keeps this draft",
    );
    client = new WsClient(server.url);
    await client.connect();
    client.send({ t: "subscribe", sessionID: session.id });
    await client.rpc("session.shell", {
      sessionID: session.id,
      command: "echo never-forwarded",
    });
    await browser.poll(
      "document.querySelector('.otk-error-observation[data-source=http] .otk-error-observation-message')?.textContent==='The shell endpoint is unavailable at this proxy.'",
    );
    const snapshot = await assertErrorConsumer(browser, client, session.id);
    assertEquals(snapshot.errorState?.observations.length, 1);
    assertEquals(snapshot.errorState?.observations[0].source, "http");
    assertEquals(snapshot.errorState?.observations[0].status, 503);
    assertEquals(snapshot.errorState?.observations[0].ref, "proxy-http-only");
    assertEquals(refused, 1);
    assertEquals(
      await browser.evaluate(
        "document.querySelector('textarea[name=prompt]').value",
      ),
      "HTTP failure keeps this draft",
    );
    assertEquals(f.fake.requests.length, 0);
    await reloadErrorConsumer(browser, client, session.id, snapshot);
  } finally {
    await client?.close();
    await f.stop();
    await proxy.shutdown();
  }
});

Deno.test("native-only failure from an independently invoked stock operation reaches all same-state consumers without a fake HTTP request identity", async () => {
  const f = await browserFixture();
  let client: WsClient | undefined;
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Native-only failure" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    await browser.type(
      "textarea[name=prompt]",
      "Native failure keeps this draft",
    );
    client = new WsClient(server.url);
    await client.connect();
    client.send({ t: "subscribe", sessionID: session.id });
    await assertRejects(
      () =>
        f.oc.request(`/session/${session.id}/shell`, {
          method: "POST",
          body: {
            command: "echo should-not-run",
            agent: "missing-event-only-agent",
          },
        }),
      Error,
      "500",
    );
    await browser.poll(
      "document.querySelector('.otk-error-observation[data-source=event] .otk-error-observation-message')?.textContent.startsWith('Agent not found:')",
    );
    const snapshot = await assertErrorConsumer(browser, client, session.id);
    assertEquals(snapshot.errorState?.observations.length, 1);
    const observation = snapshot.errorState!.observations[0];
    assertEquals(observation.source, "event");
    assertEquals(observation.requestID, undefined);
    assert(observation.eventID);
    assert(snapshot.error?.includes("missing-event-only-agent"));
    assertEquals(
      await browser.evaluate(
        "document.querySelector('textarea[name=prompt]').value",
      ),
      "Native failure keeps this draft",
    );
    await reloadErrorConsumer(browser, client, session.id, snapshot);
    assertEquals(f.fake.requests.length, 0);
  } finally {
    await client?.close();
    await f.stop();
  }
});

Deno.test("native detail remains current when its independently delivered stock HTTP diagnostic arrives later, with both sources and draft preserved", async () => {
  const f = await browserFixture();
  let client: WsClient | undefined, release: (() => void) | undefined;
  const proxy = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, async (request) => {
    const url = new URL(request.url);
    const response = await fetch(
      new Request(new URL(url.pathname + url.search, f.oc.url), request),
    );
    if (request.method !== "POST" || !url.pathname.endsWith("/shell")) {
      return response;
    }
    const bytes = await response.arrayBuffer();
    return new Promise<Response>((resolve) => {
      release = () =>
        resolve(
          new Response(bytes, {
            status: response.status,
            headers: response.headers,
          }),
        );
    });
  });
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Native detail before HTTP" },
    });
    const server = await f.sidecar({
      harness: { url: `http://127.0.0.1:${proxy.addr.port}`, db: f.oc.db },
    });
    const browser = await f.browser(server.url);
    await openSession(browser, session.id);
    await browser.type("textarea[name=prompt]", "Late HTTP keeps this draft");
    client = new WsClient(server.url);
    await client.connect();
    client.send({ t: "subscribe", sessionID: session.id });
    await client.rpc("session.shell", {
      sessionID: session.id,
      command: "echo should-not-run",
      agent: "missing-late-http-agent",
    });
    await browser.poll(
      "document.querySelector('.otk-error-observation[data-source=event] .otk-error-observation-message')?.textContent.includes('missing-late-http-agent')",
    );
    const native = await assertErrorConsumer(browser, client, session.id);
    assertEquals(native.errorState?.observations.length, 1);
    const deliver = await waitFor(
      () => release,
      (value) => typeof value === "function",
    );
    assert(deliver);
    deliver();
    await browser.poll(
      "document.querySelectorAll('.otk-error-observation').length===2",
    );
    const enriched = await assertErrorConsumer(browser, client, session.id);
    assertEquals(
      enriched.error,
      native.error,
      "A coarse HTTP diagnostic replaced useful native detail",
    );
    assert(enriched.errorState!.revision > native.errorState!.revision);
    const http = enriched.errorState!.observations.find((item) =>
      item.source === "http"
    );
    assert(http?.ref);
    assertEquals(http.status, 500);
    assertEquals(
      http.message,
      "Unexpected server error. Check server logs for details.",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('textarea[name=prompt]').value",
      ),
      "Late HTTP keeps this draft",
    );
    await reloadErrorConsumer(browser, client, session.id, enriched);
    assertEquals(f.fake.requests.length, 0);
  } finally {
    release?.();
    await client?.close();
    await f.stop();
    await proxy.shutdown();
  }
});
