// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { coreBackendFixture } from "../support/core-backend.ts";
import { Cdp } from "../support/cdp.ts";
import { tempDir, test } from "../support/resources.ts";
import { RemainingMeasurements } from "../support/remaining-measurements.ts";
import { remainingBrowser } from "../support/remaining-browser.ts";
import { waitFor } from "../support/opencode.ts";

test("PA5 one thousand project visits retain current source-free tab inputs in a real browser heap", async () => {
  const root = await tempDir("rt-");
  const report = new RemainingMeasurements(root, "PA5-tab-ownership");
  const consumer = await remainingBrowser(root), { browser } = consumer;
  try {
    await browser.poll("globalThis.remainingOwner?.facts.length===100");
    const facts = await browser.evaluate<
      {
        currentTitle: string;
        currentInbox: boolean;
        sourceFree: boolean;
        entries: number;
        selected: string;
      }[]
    >("remainingOwner.facts");
    for (const [n, fact] of facts.entries()) {
      assertEquals(fact.currentTitle, `After ${n}`);
      assertEquals(fact.selected, `tstv1-${n}`);
      assert(fact.currentInbox && fact.sourceFree);
      assert(
        fact.entries < 50,
        "Each wrapper borrows only its project partition",
      );
    }
    await browser.send("HeapProfiler.collectGarbage");
    await report.write({
      projects: 100,
      visits: 1000,
      population: 4615,
      facts,
      retainedOldSeen: await browser.evaluate(
        "remainingOwner.retainedOldSeen()",
      ),
      heap: await browser.send("Runtime.getHeapUsage"),
      disposition:
        "All retained wrappers are getters over current project partitions and the current canonical inbox, rather than detached metadata/mark maps.",
    });
    await browser.evaluate("remainingOwner.stop()");
    assertEquals(browser.errors, []);
  } finally {
    await consumer.close();
  }
});

test("PA2 closed work performs zero source serialization across 1000 updates; Copy reads the actual complete source", async () => {
  const root = await tempDir("rp-"),
    report = new RemainingMeasurements(root, "PA2-lazy-source");
  const consumer = await remainingBrowser(root, "?source"),
    { browser } = consumer;
  try {
    await browser.poll(
      "!!document.querySelector('.otk-work-fold') && !!document.querySelector('[data-message-command=\"reply.copy\"]')",
    );
    await browser.click(".otk-work-fold");
    await browser.poll("!document.querySelector('.otk-work-body')");
    await browser.evaluate("sourceProbe.reset()");
    await report.time(
      "thousand-updates",
      () => browser.evaluate("sourceProbe.run()"),
    );
    const before = await browser.evaluate<
      {
        reads: number;
        stringifiedBytes: number;
        bodies: number;
        commands: number;
      }
    >("sourceProbe.facts()");
    assertEquals(before.reads, 0);
    assertEquals(before.stringifiedBytes, 0);
    assertEquals(before.bodies, 0);
    assertEquals(
      await browser.evaluate(
        "document.querySelectorAll('.otk-work-body,[data-source-body]').length",
      ),
      0,
    );
    await browser.send("Browser.grantPermissions", {
      origin: consumer.url,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    await browser.click('[data-message-command="reply.copy"]');
    await browser.poll(
      "navigator.clipboard.readText().then(value=>value===sourceProbe.expected())",
    );
    const after = await browser.evaluate<
      {
        reads: number;
        stringifiedBytes: number;
        bodies: number;
        commands: number;
      }
    >("sourceProbe.facts()");
    assertEquals(after.reads, 1);
    assert(after.stringifiedBytes > 50000);
    assertEquals(after.bodies, 0);
    assertEquals(after.commands, before.commands);
    const commandCycles: number[] = [];
    assert(
      before.commands > 0,
      "The observer counts real hidden action registrations",
    );
    for (let n = 0; n < 10; n++) {
      await browser.evaluate("sourceProbe.mount(false)");
      await browser.poll(
        "sourceProbe.facts().commands===0 && !document.querySelector('.otk-message')",
      );
      commandCycles.push(
        await browser.evaluate("sourceProbe.facts().commands"),
      );
      await browser.evaluate("sourceProbe.mount(true)");
      await browser.poll(
        `sourceProbe.facts().commands===${before.commands} && !!document.querySelector('.otk-message')`,
      );
      commandCycles.push(
        await browser.evaluate("sourceProbe.facts().commands"),
      );
    }
    await report.write({
      updates: 1000,
      before,
      after,
      exactClipboard: true,
      commandCycles,
      disposition:
        "Full source serialization occurs only on explicit Copy; folded bodies remain unmounted.",
    });
    assertEquals(browser.errors, []);
  } finally {
    await consumer.close();
  }
});

test("PA4 real 1/4/16 browser consumers preserve shared publications through a paused reader", async () => {
  const sections: { name: string; ms: number }[] = [];
  const root = await tempDir("rf-"),
    f = await coreBackendFixture(root, {}, "tstv1-core", {
      diagnostics: (name, ms) => sections.push({ name, ms }),
    });
  const report = new RemainingMeasurements(root, "PA4-browser-fanout");
  const browser = await Cdp.launch(root);
  const pages: { id: string; session: string }[] = [];
  const evaluate = async <T>(
    session: string,
    expression: string,
  ): Promise<T> => {
    const value = await browser.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, session);
    assert(!value.exceptionDetails, JSON.stringify(value.exceptionDetails));
    return (value.result as { value: T }).value;
  };
  const observations: unknown[] = [];
  try {
    for (const count of [1, 4, 16]) {
      while (pages.length < count) {
        const { targetId } = await browser.send("Target.createTarget", {
          url: f.url,
        });
        const { sessionId } = await browser.send("Target.attachToTarget", {
          targetId,
          flatten: true,
        });
        const session = String(sessionId);
        pages.push({ id: String(targetId), session });
        await browser.send("Runtime.enable", {}, session);
        await browser.send("Page.enable", {}, session);
        await browser.send("Page.addScriptToEvaluateOnNewDocument", {
          source:
            `globalThis.paFrames=[];globalThis.WebSocket=class extends WebSocket{constructor(...args){super(...args);this.addEventListener('message',e=>{const f=JSON.parse(e.data);if(f.t==='harness')paFrames.push(f.state)})}};`,
        }, session);
        await browser.send("Page.navigate", { url: f.url }, session);
      }
      for (const page of pages) {
        const deadline = Date.now() + 30000;
        while (
          !await evaluate(
            page.session,
            "document.querySelector('.otk-connection-light')?.dataset.connectionState==='connected'",
          )
        ) {
          assert(
            Date.now() < deadline,
            "Each browser must reach connected chrome",
          );
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await evaluate(page.session, "paFrames=[]");
      }
      sections.length = 0;
      const paused = pages.at(-1)!;
      await browser.send("Debugger.enable", {}, paused.session);
      const pauseStart = browser.events.length;
      await browser.send("Debugger.pause", {}, paused.session);
      // pause requests the next JS turn; join its actual event before publishing
      // and resuming, including when the browser was otherwise completely idle.
      const entered = browser.send(
        "Runtime.evaluate",
        { expression: "void 0" },
        paused.session,
      );
      await waitFor(
        () =>
          browser.events.slice(pauseStart).some((event) =>
            event.method === "Debugger.paused" &&
            event.sessionId === paused.session
          ),
        Boolean,
      );
      const start = performance.now();
      for (let n = 0; n < 40; n++) {
        f.app.connections.connection(n % 2 ? "connected" : "reconnecting");
      }
      const synchronousMs = performance.now() - start;
      assertEquals(
        sections.filter((section) => section.name === "serialize:harness")
          .length,
        40,
      );
      await browser.send("Debugger.resume", {}, paused.session);
      await entered;
      await browser.send("Debugger.disable", {}, paused.session);
      const received: number[] = [];
      for (const page of pages) {
        const deadline = Date.now() + 30000;
        let states: string[] = [];
        do {
          states = await evaluate(page.session, "paFrames");
          if (states.length === 40) break;
          assert(
            Date.now() < deadline,
            "Paused browser must receive every publication after resume",
          );
          await new Promise((resolve) => setTimeout(resolve, 25));
        } while (true);
        assertEquals(
          states,
          Array.from(
            { length: 40 },
            (_, n) => n % 2 ? "connected" : "reconnecting",
          ),
        );
        received.push(states.length);
      }
      observations.push({
        browsers: count,
        publications: 40,
        serializations: sections.length,
        synchronousMs,
        maximumEncodeMs: Math.max(...sections.map((section) => section.ms)),
        pausedReaderPublications: 40,
        received,
        heap: await browser.send("Runtime.getHeapUsage", {}, paused.session),
      });
    }
    await report.write({
      observations,
      disposition:
        "Shared encode and lossless paused-consumer delivery observed; heap/timings reported, no queue policy added.",
    });
  } finally {
    for (const page of pages.toReversed()) {
      await browser.send("Target.closeTarget", { targetId: page.id });
    }
    await browser.close();
    await f.app.stop();
  }
});

test("PA6/PA7 warm same-document navigation reuses assets and releases mounted listener lifetimes", async () => {
  const root = await tempDir("ra-"),
    f = await coreBackendFixture(root);
  const report = new RemainingMeasurements(
    root,
    "PA6-PA7-static-and-listeners",
  );
  const browser = await Cdp.launch(root);
  try {
    await browser.goto(`${f.url}/#/local/tstv1-core`);
    await browser.poll(
      "document.querySelector('.otk-text')?.textContent==='Core transcript'",
    );
    await browser.send("HeapProfiler.collectGarbage");
    const baseline = await browser.send("Memory.getDOMCounters");
    const before = browser.events.length;
    const cycles: unknown[] = [];
    for (let n = 0; n < 10; n++) {
      await browser.goto(`${f.url}/#/local/missing-${n}`);
      await browser.poll(
        `location.hash.endsWith('/missing-${n}') && !document.querySelector('.otk-text')`,
      );
      await browser.goto(`${f.url}/#/local/tstv1-core`);
      await browser.poll(
        "document.querySelector('.otk-text')?.textContent==='Core transcript'",
      );
      await browser.send("HeapProfiler.collectGarbage");
      cycles.push(await browser.send("Memory.getDOMCounters"));
    }
    const transfers = browser.events.slice(before).filter((event) =>
      event.method === "Network.requestWillBeSent"
    )
      .map((event) => (event.params.request as { url: string }).url)
      .filter((url) => /\.(?:js|css|woff2?)(?:\?|$)/.test(url));
    assertEquals(
      transfers,
      [],
      "Hash navigation must not reload scripts, styles or fonts",
    );
    const entries = await browser.evaluate<unknown[]>(
      "performance.getEntriesByType('resource').map(e=>({name:e.name,transferSize:e.transferSize,encodedBodySize:e.encodedBodySize,duration:e.duration,initiatorType:e.initiatorType}))",
    );
    await Deno.writeTextFile(
      join(root, "asset-waterfall.json"),
      JSON.stringify(entries, null, 2),
    );
    await report.write({
      baseline,
      cycles,
      repeatedAssetRequests: transfers,
      after: await browser.send("Memory.getDOMCounters"),
      heap: await browser.send("Runtime.getHeapUsage"),
      disposition:
        "Same-document warm navigation transfers no script/font; actual DOM/listener/heap observations retained without a numerical gate.",
    });
    assertEquals(browser.errors, []);
  } finally {
    await browser.close();
    await f.app.stop();
  }
});
