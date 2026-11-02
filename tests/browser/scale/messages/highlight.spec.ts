// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import {
  highlightedRange,
  prompt,
  wheelTranscript,
} from "../../pages/transcript.ts";
import {
  assertHighlightBudget,
  highlightDistribution,
  type HighlightEvidence,
  highlightObservers,
} from "../../../support/highlight-latency.ts";
import { writeFile } from "node:fs/promises";

test("messages.highlight-2000-lines-passive-latency", {
  tag: ["@messages", "@scale"],
}, async ({ isolatedState: state, page, context }, info) => {
  test.setTimeout(180_000);
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Highlight budget",
  });
  await openSession(state, page, session.id);
  const startup = performance.now();
  await state.queue(["```ts\nconst warmup: number = 0;\n```\n"]);
  await prompt(page, "Prepare the TS grammar");
  await highlightedRange(page, ".otk-code code", "warmup");
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  const coldStartupMs = performance.now() - startup;
  await page.evaluate(highlightObservers);
  const cdp = await context.newCDPSession(page);
  const trace: Record<string, unknown>[] = [];
  cdp.on("Tracing.dataCollected", (event) => trace.push(...event.value));
  await cdp.send("Tracing.start", {
    categories: "devtools.timeline,v8,disabled-by-default-devtools.timeline",
    transferMode: "ReportEvents",
  });
  const profiling = process.env.OTK_PROFILE_HIGHLIGHT === "1";
  if (profiling) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.start");
  }
  const big = Array.from(
    { length: 2000 },
    (_, i) => `const value${i}: number = ${i};`,
  ).join("\n");
  const stream = await state.controller.call<{ gate: string }>("queueScript", {
    lease: state.lease.lease,
    gate: "stepped",
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
  await prompt(page, "Highlight the large block then twenty chunks");
  const measured =
    '[aria-label="Transcript messages"] > :nth-last-child(1 of .otk-virtual-item) [data-role=assistant] .otk-text';
  await page.evaluate(
    `highlightMeasure(${
      JSON.stringify(measured + " .otk-code code")
    },'value1999')`,
  );
  await state.release(stream.gate);
  await highlightedRange(page, measured + " .otk-code code", "value1999");
  await expect.poll(() => page.evaluate("highlightEvidence.blocks.length"))
    .toBe(1);
  await state.release(stream.gate);
  await highlightedRange(
    page,
    measured + " .otk-code:last-child code",
    "streaming",
  );
  for (let index = 0; index < 20; index++) {
    const marker = `streamed${index}`;
    await page.evaluate(
      `highlightMeasure(${
        JSON.stringify(measured + " .otk-code:last-child code")
      },${JSON.stringify(marker)})`,
    );
    await state.release(stream.gate);
    await highlightedRange(
      page,
      measured + " .otk-code:last-child code",
      marker,
    );
    await expect.poll(() => page.evaluate("highlightEvidence.blocks.length"))
      .toBe(index + 2);
  }
  await state.release(stream.gate);
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  const height = await page.locator(".otk-messages").evaluate((element) =>
    element.clientHeight
  );
  await wheelTranscript(page, -height);
  await highlightedRange(page, measured + " .otk-code code", "value1999");
  await expect(page.locator(measured + " .otk-code code").first())
    .toHaveJSProperty("textContent", big);
  await wheelTranscript(page, 100000);
  const freeUpdates = 240;
  await page.evaluate(
    `highlightStream(${
      JSON.stringify(measured + " .otk-code code")
    },'passive')`,
  );
  await state.controller.call("queueScript", {
    lease: state.lease.lease,
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
  await prompt(page, "Stream without waiting for paint");
  // Before the new reply mounts, the last virtual row is still the previous
  // two-code-block turn. Join this stream's source identity, not that old row.
  await expect(
    page.locator(measured + " .otk-code code").filter({
      hasText: "const freeRunning: number = 0;",
    }),
  ).toContainText(
    "passive239",
    { timeout: 60_000 },
  );
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
    { timeout: 60_000 },
  );
  await expect.poll(
    () =>
      page.evaluate(
        "highlightEvidence.revisions.at(-1)?.marker==='passive239' && highlightEvidence.revisions.every(sample=>sample.end!==undefined)",
      ),
    { timeout: 30_000 },
  ).toBe(true);
  await page.evaluate("highlightCancel()");
  const evidence = await page.evaluate<HighlightEvidence>("highlightEvidence");
  expect(evidence.blocks).toHaveLength(21);
  const acknowledged = highlightDistribution(evidence.blocks.slice(1), 20),
    freeRunning = highlightDistribution(evidence.revisions, 200);
  expect(evidence.revisions.flatMap((sample) => sample.markers)).toEqual(
    Array.from({ length: freeUpdates }, (_, i) => `passive${i}`),
  );
  const targets = await cdp.send("Target.getTargets");
  const complete = new Promise<void>((resolve) =>
    cdp.once("Tracing.tracingComplete", () => resolve())
  );
  await cdp.send("Tracing.end");
  await complete;
  const threads = trace.filter((event) => event.name === "thread_name");
  const main = new Set(
    threads.filter((event) =>
      (event.args as { name?: string }).name === "CrRendererMain"
    ).map((event) => `${event.pid}:${event.tid}`),
  );
  const mainLongTasks = trace.filter((event) =>
    main.has(`${event.pid}:${event.tid}`) &&
    ["RunTask", "ThreadControllerImpl::RunTask"].includes(String(event.name)) &&
    Number(event.dur) > 50000
  );
  const intervals = [evidence.blocks, evidence.revisions].map((samples) => ({
    start: Math.min(...samples.map((sample) => sample.start!)),
    end: Math.max(...samples.map((sample) => sample.end!)),
  }));
  const attributed = evidence.longtasks.filter((task) =>
    intervals.some(({ start, end }) =>
      task.start + task.duration >= start && task.start <= end
    )
  );
  const measurement = {
    coldStartupMs,
    acknowledged,
    freeRunning,
    evidence,
    intervals,
    mainLongTasks,
    threads,
    attributed,
    targets,
  };
  await info.attach("highlight-performance", {
    body: JSON.stringify(measurement),
    contentType: "application/json",
  });
  await writeFile(
    info.outputPath("highlight-trace.json"),
    JSON.stringify(trace),
  );
  if (profiling) {
    await writeFile(
      info.outputPath("highlight-cpu.json"),
      JSON.stringify(await cdp.send("Profiler.stop")),
    );
    const html = await fetch(state.url).then((response) => response.text());
    const asset = /src="([^"]+\.js)"/.exec(html)![1];
    await writeFile(
      info.outputPath("highlight-app.js"),
      await fetch(new URL(asset, state.url + "/")).then((response) =>
        response.text()
      ),
    );
  }
  const owner = targets.targetInfos.find((target) =>
    target.type === "page" && target.url.startsWith(state.url)
  );
  expect(owner).toBeTruthy();
  expect(
    targets.targetInfos.some((target) =>
      target.type === "worker" &&
      (target as typeof target & { parentId?: string }).parentId ===
        owner!.targetId
    ),
  ).toBe(true);
  assertHighlightBudget(evidence.blocks.slice(1), 20);
  assertHighlightBudget(evidence.revisions, 200);
  console.info(
    "Highlight measurements",
    JSON.stringify({
      coldStartupMs,
      acknowledged,
      freeRunning,
      largeRangeMs: evidence.blocks[0].latency,
      observerMs: evidence.observerMs,
      reads: evidence.reads,
      attributed,
    }),
  );
  await page.evaluate("highlightStop()");
  await cdp.detach();
});
