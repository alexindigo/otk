// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { waitFor } from "../support/opencode.ts";
import {
  assertContentLoaded,
  assertContentReleased,
  sessionHeap,
} from "../support/heap.ts";
import { highlightedRange } from "../support/highlight.ts";
import {
  assertHighlightBudget,
  highlightDistribution,
  type HighlightEvidence,
  highlightObservers,
} from "../support/highlight-latency.ts";
const colourPrefix =
  `Array.from(document.querySelectorAll('.otk-code code .otk-token')).slice(0,8).map(el=>({text:el.textContent,color:getComputedStyle(el).color}))`;
test("R6 shiki worker colours streaming TS before fence closure and unknown languages remain plain", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Highlighting" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    f.fake.queue({
      chunks: [
        "```ts\nconst finished: number = 1;\n",
        ...Array.from(
          { length: 20 },
          (_, i) => `const row${i}: number = ${i};\n`,
        ),
        "```\n",
      ],
      delay: 100,
    });
    await browser.type("textarea[name=prompt]", "Stream TypeScript");
    await browser.key("Enter");
    await browser.poll(
      `document.querySelectorAll('.otk-token').length >= 8 && document.querySelector('[data-session="${session.id}"]').dataset.status === 'busy'`,
    );
    const prefix = await browser.evaluate<{ text: string; color: string }[]>(
      colourPrefix,
    );
    assert(
      new Set(prefix.map((token) => token.color)).size > 1,
      "TS tokens must have distinct colours",
    );
    await browser.screenshot(join(f.oc.root, "r6-streaming-colours.png"));
    await browser.poll(
      `document.querySelector('[data-session="${session.id}"]').dataset.status === 'idle' && document.querySelector('.otk-code code')?.textContent.includes('const row19')`,
    );
    await browser.poll(
      "[...document.querySelectorAll('.otk-token')].some(el=>el.textContent==='row19')",
    );
    assertEquals(
      await browser.evaluate(colourPrefix),
      prefix,
      "Finished line colours changed",
    );
    f.fake.queue({
      chunks: [
        "```ts\nconst seed: number = 0;\n/* opened\n",
        "comment continues\n",
        "*/\nconst afterSeed: number = 1;\n",
        "```\n",
      ],
      delay: 180,
    });
    await browser.type(
      "textarea[name=prompt]",
      "Preserve seeded multiline grammar state",
    );
    await browser.key("Enter");
    await browser.poll(
      "[...document.querySelectorAll('.otk-token')].some(el=>el.textContent.includes('comment continues'))",
    );
    const commentColor = await browser.evaluate(
      "getComputedStyle([...document.querySelectorAll('.otk-token')].find(el=>el.textContent.includes('comment continues'))).color",
    );
    assertEquals(
      commentColor,
      await browser.evaluate(
        "(()=>{const sample=document.createElement('span');sample.style.color='var(--otk-code-comment)';document.body.append(sample);const color=getComputedStyle(sample).color;sample.remove();return color})()",
      ),
    );
    assert(
      await browser.evaluate(
        "[...document.querySelectorAll('.otk-token')].find(el=>el.textContent.includes('comment continues')).getAttribute('style').includes('--otk-syntax-token-comment')",
      ),
    );
    await browser.poll(
      `document.querySelector('[data-session="${session.id}"]').dataset.status === 'idle' && [...document.querySelectorAll('.otk-token')].some(el=>el.textContent==='afterSeed')`,
    );
    assertEquals(
      await browser.evaluate(
        "getComputedStyle([...document.querySelectorAll('.otk-token')].find(el=>el.textContent.includes('comment continues'))).color",
      ),
      commentColor,
    );
    f.fake.queue({
      chunks: ["```otk-unknown-language\nplain unknown syntax\n```\n"],
    });
    await browser.type("textarea[name=prompt]", "Unknown language");
    await browser.key("Enter");
    await browser.poll(
      "document.querySelector('[data-language=otk-unknown-language] code')?.textContent.includes('plain unknown syntax')",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelectorAll('[data-language=otk-unknown-language] .otk-token').length",
      ),
      0,
    );
  } finally {
    await f.stop();
  }
});
test("highlighted history releases its worker and session objects when switching sessions", async () => {
  const f = await browserFixture();
  try {
    const a = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Large code" },
    });
    const b = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Plain history" },
    });
    f.fake.queue({
      chunks: [
        "```ts\n" + Array.from({ length: 2000 }, (_, i) =>
          `const heap${i}: number = ${i};`).join("\n") +
        "\n```\n",
      ],
    });
    await f.oc.request(`/session/${a.id}/prompt_async`, {
      method: "POST",
      body: { parts: [{ type: "text", text: "Large code history" }] },
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
    );
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, b.id);
    await browser.poll("document.fonts.status==='loaded'");
    for (let cycle = 0; cycle < 3; cycle++) {
      await openSession(browser, a.id);
      await browser.poll(
        "[...document.querySelectorAll('.otk-token')].some(el=>el.textContent==='heap1999')",
        60000,
      );
      const before = await browser.send("Target.getTargets");
      assert(
        (before.targetInfos as { type: string }[]).some((target) =>
          target.type === "worker"
        ),
      );
      const loaded = await sessionHeap(browser, a.id, "const heap0:");
      assertContentLoaded(loaded);
      await openSession(browser, b.id);
      await browser.poll("document.querySelectorAll('.otk-code').length===0");
      await waitFor(
        () => browser.send("Target.getTargets"),
        (targets) =>
          !(targets.targetInfos as { type: string }[]).some((target) =>
            target.type === "worker"
          ),
      );
      await browser.evaluate(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
      const released = await sessionHeap(browser, a.id, "const heap0:");
      console.info("Code history session identities", {
        cycle,
        loaded,
        released,
      });
      assertContentReleased(released);
    }
  } finally {
    await f.stop();
  }
});
test("R-perf visible-source to styled-range latency for 2000 TS lines, acknowledged updates and free-running revisions", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Highlight budget" },
    });
    const server = await f.sidecar(), browser = await f.browser("about:blank");
    await browser.goto(server.url);
    await openSession(browser, session.id);
    const startup = performance.now();
    f.fake.queue({ chunks: ["```ts\nconst warmup: number = 0;\n```\n"] });
    await browser.type("textarea[name=prompt]", "Prepare the TS grammar");
    await browser.key("Enter");
    await highlightedRange(browser, ".otk-code code", "warmup");
    await browser.poll(
      `document.querySelector('[data-session="${session.id}"]').dataset.status==='idle'`,
    );
    const coldStartupMs = performance.now() - startup;
    console.info(
      "Highlight cold startup (includes native provider/transport)",
      coldStartupMs,
    );
    await browser.evaluate(highlightObservers);
    await browser.send("Tracing.start", {
      categories: "devtools.timeline,v8,disabled-by-default-devtools.timeline",
      transferMode: "ReportEvents",
    });
    const profiling = Deno.env.get("OTK_PROFILE_HIGHLIGHT") === "1";
    if (profiling) {
      await browser.send("Profiler.enable");
      await browser.send("Profiler.start");
    }
    const big = Array.from(
      { length: 2000 },
      (_, i) => `const value${i}: number = ${i};`,
    ).join("\n");
    const stream = f.fake.queueStepped({
      chunks: [
        "```ts\n" + big + "\n```\n\n",
        "```ts\nconst streaming: number = 0;\n",
        ...Array.from(
          { length: 20 },
          (_, i) => `const streamed${i}: number = ${i};\n`,
        ),
        "```\n",
      ],
      delay: 0,
    });
    await browser.type(
      "textarea[name=prompt]",
      "Highlight the large block then twenty chunks",
    );
    await browser.key("Enter");
    // The warmup lives in an earlier reply. Scope every sample to the measured
    // reply, and release the next revision only after its predecessor is styled.
    const measured = "[data-role=assistant]:last-of-type .otk-text";
    await browser.evaluate(
      `highlightMeasure(${
        JSON.stringify(measured + " .otk-code code")
      },'value1999')`,
    );
    stream.next();
    await highlightedRange(browser, measured + " .otk-code code", "value1999");
    await browser.poll("highlightEvidence.blocks.length===1");
    stream.next();
    await highlightedRange(
      browser,
      measured + " .otk-code:last-child code",
      "streaming",
    );
    for (let index = 0; index < 20; index++) {
      const marker = `streamed${index}`;
      await browser.evaluate(
        `highlightMeasure(${
          JSON.stringify(measured + " .otk-code:last-child code")
        },${JSON.stringify(marker)})`,
      );
      stream.next();
      await highlightedRange(
        browser,
        measured + " .otk-code:last-child code",
        marker,
      );
      await browser.poll(`highlightEvidence.blocks.length===${index + 2}`);
    }
    stream.next();
    await browser.poll(
      `document.querySelector('[data-session="${session.id}"]').dataset.status === 'idle'`,
    );
    // The second streamed block can fill the transcript's visible height. Bring
    // the first block's final lines into view before demanding their lazy tokens.
    await browser.evaluate(
      `document.querySelector('${measured} .otk-code').scrollIntoView({block:'end'})`,
    );
    await browser.poll(
      "[...document.querySelectorAll('.otk-token')].some(el=>el.textContent==='value1999')",
      60000,
    );
    assertEquals(
      await browser.evaluate(
        `document.querySelector('${measured} .otk-code code').textContent`,
      ),
      big,
      "Highlighting changed code bytes",
    );
    // No consumer acknowledgements or range-demand helper during this phase.
    // 240 releases at the original 100 ms cadence leave >=200 actual visible
    // source revisions (at least ten observations in the p95 tail).
    const freeUpdates = 240;
    await browser.evaluate(
      `highlightStream(${
        JSON.stringify(measured + " .otk-code code")
      },'passive')`,
    );
    f.fake.queue({
      chunks: [
        "```ts\nconst freeRunning: number = 0;\n",
        ...Array.from(
          { length: freeUpdates },
          (_, i) => `const passive${i}: number = ${i};\n`,
        ),
        "```\n",
      ],
      delay: 100,
    });
    await browser.type(
      "textarea[name=prompt]",
      "Stream without waiting for paint",
    );
    await browser.key("Enter");
    await browser.poll(
      `document.querySelector('[data-session="${session.id}"]').dataset.status==='idle' && document.querySelector('${measured} .otk-code code')?.textContent.includes('passive239')`,
      60000,
    );
    // Observe the final outcome only: polling cannot slow the producer.
    await browser.poll(
      "highlightEvidence.revisions.at(-1)?.marker==='passive239' && highlightEvidence.revisions.every(sample=>sample.end!==undefined)",
    );
    await browser.evaluate("highlightCancel()");
    const evidence = await browser.evaluate<HighlightEvidence>(
      "highlightEvidence",
    );
    assert(
      evidence.blocks.length === 21,
      "Need one demanded 2000-line range and every one of 20 streamed revisions",
    );
    const acknowledged = highlightDistribution(evidence.blocks.slice(1), 20);
    const freeRunning = highlightDistribution(evidence.revisions, 200);
    assertEquals(
      evidence.revisions.flatMap((sample) => sample.markers),
      Array.from({ length: freeUpdates }, (_, i) => `passive${i}`),
      "Every free-running marker must enter the observed source revisions",
    );
    const { p50, p95 } = acknowledged;
    const targets = await browser.send("Target.getTargets");
    console.info("Highlight preliminary evidence", {
      p50,
      p95,
      coldStartupMs,
      acknowledged,
      freeRunning,
      targets,
    });
    await Deno.writeTextFile(
      join(f.oc.root, "highlight-preliminary.json"),
      JSON.stringify(
        { coldStartupMs, acknowledged, freeRunning, evidence, targets },
        null,
        2,
      ),
    );
    await browser.send("Tracing.end");
    await waitFor(
      () => browser.events,
      (events) =>
        events.some((event) => event.method === "Tracing.tracingComplete"),
    );
    const trace = browser.events.filter((event) =>
      event.method === "Tracing.dataCollected"
    ).flatMap((event) => event.params.value as Record<string, unknown>[]);
    const threads = trace.filter((event) => event.name === "thread_name");
    const main = new Set(
      threads.filter((event) =>
        (event.args as { name?: string }).name === "CrRendererMain"
      ).map((event) => `${event.pid}:${event.tid}`),
    );
    const mainLongTasks = trace.filter((event) =>
      main.has(`${event.pid}:${event.tid}`) &&
      ["RunTask", "ThreadControllerImpl::RunTask"].includes(
        String(event.name),
      ) && Number(event.dur) > 50000
    );
    // Bound the existing strict workload budget to demanded source through the
    // last styled update. This is workload observation, not causal attribution
    // of every renderer task to Shiki; startup/navigation are separate.
    const intervals = [evidence.blocks, evidence.revisions].map((samples) => ({
      start: Math.min(...samples.map((sample) => sample.start!)),
      end: Math.max(...samples.map((sample) => sample.end!)),
    }));
    const attributed = evidence.longtasks.filter((task) =>
      intervals.some(({ start, end }) =>
        task.start + task.duration >= start && task.start <= end
      )
    );
    console.info("Highlight budget", {
      p50,
      p95,
      acknowledged,
      freeRunning,
      largeRangeMs: evidence.blocks[0].latency,
      mainLongTasks: mainLongTasks.length,
      attributed,
    });
    await Deno.writeTextFile(
      join(f.oc.root, "highlight-performance.json"),
      JSON.stringify(
        {
          coldStartupMs,
          acknowledged,
          freeRunning,
          evidence,
          intervals,
          mainLongTasks,
          threads,
        },
        null,
        2,
      ),
    );
    await Deno.writeTextFile(
      join(f.oc.root, "highlight-trace.json"),
      JSON.stringify(trace),
    );
    if (profiling) {
      const cpu = await browser.send("Profiler.stop");
      await Deno.writeTextFile(
        join(f.oc.root, "highlight-cpu.json"),
        JSON.stringify(cpu),
      );
      const html = await fetch(server.url).then((response) => response.text());
      const asset = /src="([^"]+\.js)"/.exec(html)![1];
      await Deno.writeTextFile(
        join(f.oc.root, "highlight-app.js"),
        await fetch(new URL(asset, server.url + "/")).then((response) =>
          response.text()
        ),
      );
    }
    await browser.screenshot(join(f.oc.root, "r-perf-highlight.png"));
    const infos = targets.targetInfos as {
      type: string;
      targetId: string;
      parentId?: string;
      url: string;
    }[];
    const page = infos.find((target) =>
      target.type === "page" && target.url.startsWith(server.url)
    );
    assert(
      page &&
        infos.some((target) =>
          target.type === "worker" && target.parentId === page.targetId
        ),
      "No highlighting worker owned by the production page",
    );
    assertHighlightBudget(evidence.blocks.slice(1), 20);
    assertHighlightBudget(evidence.revisions, 200);
    assert(
      evidence.blocks[0].latency! <= 200,
      "Demanded large-code range exceeds the same 200 ms budget",
    );
    console.info("Highlight measurement overhead", {
      milliseconds: evidence.observerMs,
      reads: evidence.reads,
    });
    await browser.evaluate("highlightStop()");
    assertEquals(
      attributed,
      [],
      "STOP: visible code workload main-thread long tasks >50 ms",
    );
  } finally {
    await f.stop();
  }
});
