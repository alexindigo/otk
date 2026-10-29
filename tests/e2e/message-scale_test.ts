// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { start } from "../../main.ts";
import { cfg } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { freePort, waitFor } from "../support/opencode.ts";
import { resources, tempDir, test } from "../support/resources.ts";
import { SCALE, SessionScale } from "../support/session-scale.ts";
import { WsClient } from "../support/ws-client.ts";
import type { OpencodeV1Adapter } from "@otk/harness-opencode-v1";
import { servingProbe } from "../support/serving-probe.ts";
import {
  measureMessagePaint,
  type MessagePaintEvidence,
} from "../support/message-measurements.ts";

for (const theme of ["otk-dark", "otk-light"]) {
  test(`real scale newest10 reports five cold and preloaded paint measurements (${theme})`, async () => {
    const root = await tempDir("ms-"), fake = new FakeLlm();
    const native = await SessionScale.create(join(root, "fixture"), root, fake);
    const selected = native.manifest.sessions[0];
    const landing = native.manifest.sessions[251];
    const observations: unknown[] = [];
    const nativeReads: unknown[] = [];
    const proxy = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async (request) => {
        const uri = new URL(request.url);
        const row = {
          path: uri.pathname,
          query: uri.search,
          at: performance.now(),
          headers: undefined as number | undefined,
          end: undefined as number | undefined,
          status: undefined as number | undefined,
        };
        nativeReads.push(row);
        const response = await fetch(
          new Request(new URL(uri.pathname + uri.search, native.url), request),
        );
        row.headers = performance.now();
        row.status = response.status;
        if (uri.pathname.endsWith("/event")) return response;
        const headers = new Headers(response.headers);
        headers.delete("content-encoding");
        headers.delete("content-length");
        const body = await response.arrayBuffer();
        row.end = performance.now();
        return new Response(body, { status: response.status, headers });
      },
    );
    resources().defer("paint native proxy", () => proxy.shutdown());
    resources().evidence("message paint measurements", () =>
      Deno.writeTextFile(
        join(root, "message-paint.json"),
        JSON.stringify(
          {
            theme,
            version: native.manifest.version,
            counts: SCALE,
            observations,
            nativeReads,
          },
          null,
          2,
        ),
      ));
    for (let repetition = 0; repetition < 5; repetition++) {
      const probe = servingProbe(false);
      resources().defer(
        `paint serving probe ${repetition}`,
        () => probe.stop(),
      );
      const phases: unknown[] = [], sections: unknown[] = [];
      const timing: {
        sync?: { before: number; browser: number; after: number };
      } = {};
      resources().evidence(
        `paint phases ${repetition}`,
        () =>
          Deno.writeTextFile(
            join(root, `phases-${repetition}.json`),
            JSON.stringify(
              { phases, sections, sync: timing.sync, serving: probe.samples },
              null,
              2,
            ),
          ),
      );
      const config = cfg();
      config.server.port = freePort();
      config.auth.type = "none";
      config.state.path = join(root, `state-${repetition}`);
      config.harness.url = `http://127.0.0.1:${
        (proxy.addr as Deno.NetAddr).port
      }`;
      config.harness.db = native.db;
      const app = await start(config, {
        admission: probe.start,
        section: (name, ms) => {
          probe.section(name, ms);
          sections.push({ at: performance.now(), name, ms });
        },
      });
      const pages = app.backend.core.listMessages.bind(app.backend.core);
      app.backend.core.listMessages = (...args) => {
        const row = {
          kind: "page",
          sessionID: args[0],
          before: args[1].before,
          at: performance.now(),
          end: undefined as number | undefined,
          error: undefined as string | undefined,
        };
        phases.push(row);
        return pages(...args).then((value) => {
          row.end = performance.now();
          return value;
        }, (error) => {
          row.end = performance.now();
          row.error = String(error);
          throw error;
        });
      };
      const digest = (app.backend as OpencodeV1Adapter).digest!;
      const metadata = digest.transcriptMetadata.bind(digest);
      digest.transcriptMetadata = (...args) => {
        const row = {
          kind: "metadata",
          sessionID: args[0],
          at: performance.now(),
          end: undefined as number | undefined,
          error: undefined as string | undefined,
        };
        phases.push(row);
        return metadata(...args).then((value) => {
          row.end = performance.now();
          return value;
        }, (error) => {
          row.end = performance.now();
          row.error = String(error);
          throw error;
        });
      };
      const stop = resources().defer(
        `paint app ${repetition}`,
        () => app.stop(),
      );
      const url = `http://127.0.0.1:${config.server.port}`;
      const client = new WsClient(url);
      await client.connect();
      await waitFor(
        () => app.index.get(native.manifest.sessions.at(-1)!.id),
        Boolean,
        120000,
      );
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await client.rpc("prefs.set", { key: "animationsOff", value: true });
      await client.rpc("layout.patch", {
        leftCollapsed: true,
        rightCollapsed: true,
      });
      await client.rpc("tasks.create", {
        directory: landing.directory,
        name: "Paint measurement landing",
        sessions: [landing.id],
      });
      const browser = await Cdp.launch(root);
      let closed = false;
      const captureConsumer = async () => {
        if (closed) return;
        await Deno.writeTextFile(
          join(root, `consumer-${repetition}-transport.json`),
          JSON.stringify({
            errors: browser.errors,
            events: browser.events.filter((e) =>
              e.method.startsWith("Network.webSocket")
            ),
          }),
        );
        await Deno.writeTextFile(
          join(root, `consumer-${repetition}.json`),
          await browser.evaluate<string>("JSON.stringify(messageMeasurements)"),
        );
        await Deno.writeTextFile(
          join(root, `consumer-${repetition}.html`),
          await browser.evaluate<string>("document.documentElement.outerHTML"),
        );
      };
      resources().evidence(`paint consumer ${repetition}`, captureConsumer);
      await browser.send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const openMain =
        `[data-project-sessions~="${selected.id}"] .otk-project-open`;
      const openLanding =
        `[data-project-sessions~="${landing.id}"] .otk-project-open`;
      await measureMessagePaint(browser, selected.id, openMain);
      await browser.goto(`${url}/#/local/${landing.id}`);
      await browser.poll(
        `messageMeasurements.snapshots.some(s=>s.count===${SCALE.sessions}) && !!document.querySelector('textarea[name=prompt]')`,
      );
      assertEquals(
        await browser.evaluate("messageMeasurements.requests.length"),
        0,
        "the measured body cache starts cold",
      );
      const before = performance.now();
      const browserNow = await browser.evaluate<number>("performance.now()");
      timing.sync = { before, browser: browserNow, after: performance.now() };
      // A trusted input event starts the clock before OTK's guarded navigation
      // handler. Programmatic hash assignment queues a different browser task.
      await browser.click(openMain);
      // Retain evidence even if the intended consumer never reaches paint.
      let evidence: MessagePaintEvidence;
      try {
        await browser.poll("messageMeasurements.paints.length===1", 10000);
      } finally {
        probe.stop();
        evidence = await browser.evaluate<MessagePaintEvidence>(
          "messageMeasurements",
        );
        observations.push({
          repetition,
          mode: "cold",
          ...evidence,
          errors: browser.errors,
        });
        await Deno.writeTextFile(
          join(root, `cold-${repetition}.html`),
          await browser.evaluate<string>("document.documentElement.outerHTML"),
        );
      }
      const first = evidence.pages.find((page) => page.ok);
      assert(first?.ok && first.ids, JSON.stringify(evidence));
      assertEquals(
        first.ids,
        Array.from(
          { length: 10 },
          (_, i) => `msg_scale${String(1515 + i).padStart(9, "0")}`,
        ),
      );
      console.info(
        "Message scale paint",
        theme,
        repetition,
        "cold",
        evidence.paints[0],
      );
      assert(evidence.paints.length === 1, "The visible page must reach paint");
      assert(
        evidence.snapshots.some((s) => !s.ready),
        "concurrent initial backfill was observed",
      );
      // Warm navigation starts after the canonical resource has its ready reserve.
      // Bootstrap may have completed before this browser connected, so a later
      // resync event is not a readiness prerequisite.
      await browser.poll(
        "Number(document.querySelector('.otk-message-flow')?.dataset.messageCount)>=20",
      );
      await browser.click(openLanding);
      await browser.poll(
        `location.hash.endsWith('/${landing.id}') && !!document.querySelector('textarea[name=prompt]')`,
      );
      const initial = await browser.evaluate<number>(
        "messageMeasurements.requests.filter(r=>!r.before).length",
      );
      // The same source/header/footer/geometry probe observes warm navigation.
      await browser.click(openMain);
      await browser.poll("messageMeasurements.paints.length===1", 10000);
      evidence = await browser.evaluate<MessagePaintEvidence>(
        "messageMeasurements",
      );
      observations.push({
        repetition,
        mode: "preloaded",
        ...evidence,
        errors: browser.errors,
      });
      console.info(
        "Message scale paint",
        theme,
        repetition,
        "preloaded",
        evidence.paints[0],
      );
      assert(
        evidence.paints.length === 1,
        "The preloaded page must reach paint",
      );
      assertEquals(
        evidence.requests.filter((r) => !r.before).length,
        initial,
        "preloaded navigation has no duplicate initial read",
      );
      assertEquals(browser.errors, []);
      const shots = Deno.env.get("OTK_MESSAGES_SHOTS");
      if (shots && repetition === 0) {
        await Deno.mkdir(shots, { recursive: true });
        await browser.screenshot(join(shots, `${theme}-scale-newest10.png`));
      }
      await client.close();
      await captureConsumer();
      closed = true;
      await browser.close();
      await stop();
    }
  });
}
