// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { waitFor } from "../support/opencode.ts";
const colourPrefix =
  `Array.from(document.querySelectorAll('.otk-code code .otk-token')).slice(0,8).map(el=>({text:el.textContent,color:getComputedStyle(el).color}))`;
Deno.test("R6 shiki worker colours streaming TS before fence closure and unknown languages remain plain", async () => {
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
    assertEquals(commentColor, "rgb(82, 88, 96)");
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
Deno.test("highlighted history releases its worker and browser heap when switching sessions", async () => {
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
    await browser.send("HeapProfiler.collectGarbage");
    const baseline = (await browser.send("Runtime.getHeapUsage"))
      .usedSize as number;
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
    await openSession(browser, b.id);
    await browser.poll("document.querySelectorAll('.otk-code').length===0");
    await waitFor(
      () => browser.send("Target.getTargets"),
      (targets) =>
        !(targets.targetInfos as { type: string }[]).some((target) =>
          target.type === "worker"
        ),
    );
    await browser.send("HeapProfiler.collectGarbage");
    const after = (await browser.send("Runtime.getHeapUsage"))
      .usedSize as number;
    console.info("Code history footprint", {
      baseline,
      after,
      delta: after - baseline,
    });
    assert(
      after <= baseline + 1024 * 1024,
      "Code history retained more than the existing 1 MiB allowance",
    );
  } finally {
    await f.stop();
  }
});
const externalObservers = `(() => {
  globalThis.highlightEvidence = { blocks: [], longtasks: [] };
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) highlightEvidence.longtasks.push({start:entry.startTime,duration:entry.duration,attribution:entry.attribution.map(a=>({name:a.name,containerType:a.containerType,containerSrc:a.containerSrc}))});
  }).observe({type:'longtask',buffered:true});
  const seen = new Map();
  new MutationObserver(() => {
    for(const code of document.querySelectorAll('.otk-code code')) {
      if(!code.textContent) continue;
      let record = seen.get(code);
      if(!record) { record={start:performance.now(),textLength:code.textContent.length,lang:code.closest('.otk-code').dataset.language}; seen.set(code,record); }
      if(!record.done && code.querySelector('.otk-token')) { record.done=true; highlightEvidence.blocks.push({...record,latency:performance.now()-record.start}); }
    }
  }).observe(document,{subtree:true,childList:true,characterData:true});
})()\n//# sourceURL=otk-highlight-observer.js`;
Deno.test("R-perf external DOM latency and tracing for 2000 TS lines plus 20 streamed chunks", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Highlight budget" },
    });
    const server = await f.sidecar(), browser = await f.browser("about:blank");
    await browser.send("Page.addScriptToEvaluateOnNewDocument", {
      source: externalObservers,
    });
    await browser.send("Tracing.start", {
      categories: "devtools.timeline,v8,disabled-by-default-devtools.timeline",
      transferMode: "ReportEvents",
    });
    await browser.goto(server.url);
    await openSession(browser, session.id);
    const profiling = Deno.env.get("OTK_PROFILE_HIGHLIGHT") === "1";
    if (profiling) {
      await browser.send("Profiler.enable");
      await browser.send("Profiler.start");
    }
    const big = Array.from(
      { length: 2000 },
      (_, i) => `const value${i}: number = ${i};`,
    ).join("\n");
    f.fake.queue({
      chunks: [
        "```ts\n" + big + "\n```\n\n",
        "```ts\nconst streaming: number = 0;\n",
        ...Array.from(
          { length: 20 },
          (_, i) => `const streamed${i}: number = ${i};\n`,
        ),
        "```\n",
      ],
      delay: 100,
    });
    await browser.type(
      "textarea[name=prompt]",
      "Highlight the large block then twenty chunks",
    );
    await browser.key("Enter");
    await browser.poll(
      "document.querySelectorAll('.otk-code').length===2 && [...document.querySelectorAll('.otk-token')].some(el=>el.textContent==='streamed19')",
      60000,
    );
    await browser.poll(
      `document.querySelector('[data-session="${session.id}"]').dataset.status === 'idle'`,
    );
    await browser.poll(
      "[...document.querySelectorAll('.otk-token')].some(el=>el.textContent==='value1999')",
      60000,
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('.otk-code code').textContent",
      ),
      big,
      "Highlighting changed code bytes",
    );
    const evidence = await browser.evaluate<
      {
        blocks: { start: number; latency: number; textLength: number }[];
        longtasks: { start: number; duration: number }[];
      }
    >("highlightEvidence");
    assert(
      evidence.blocks.length >= 2,
      "Missing externally measured code blocks",
    );
    const latencies = evidence.blocks.map((block) => block.latency).sort((
      a,
      b,
    ) => a - b);
    const percentile = (p: number) =>
      latencies[Math.ceil(latencies.length * p) - 1];
    const p50 = percentile(.5), p95 = percentile(.95);
    const targets = await browser.send("Target.getTargets");
    console.info("Highlight preliminary evidence", {
      p50,
      p95,
      evidence,
      targets,
    });
    await Deno.writeTextFile(
      join(f.oc.root, "highlight-preliminary.json"),
      JSON.stringify({ p50, p95, evidence, targets }, null, 2),
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
    // Conservative attribution: any long task while the code is entering the
    // document is a failure, rather than excusing an app render as unrelated.
    const start = Math.min(...evidence.blocks.map((block) => block.start));
    const attributed = evidence.longtasks.filter((task) =>
      task.start + task.duration >= start
    );
    console.info("Highlight budget", {
      p50,
      p95,
      blocks: evidence.blocks,
      mainLongTasks: mainLongTasks.length,
      attributed,
    });
    await Deno.writeTextFile(
      join(f.oc.root, "highlight-performance.json"),
      JSON.stringify({ p50, p95, evidence, mainLongTasks, threads }, null, 2),
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
    assert(p95 <= 200, `STOP: shiki p95 ${p95} ms exceeds 200 ms`);
    assertEquals(
      attributed,
      [],
      "STOP: highlighting-attributed main-thread long tasks >50 ms",
    );
  } finally {
    await f.stop();
  }
});
