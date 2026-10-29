// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { messageScaleBrowser } from "../support/message-scale-browser.ts";
import { resources, tempDir, test } from "../support/resources.ts";

interface RangeSample {
  at: number;
  first: string;
  last: string;
  before: number;
  after: number;
  count: number;
  older: boolean;
  visible: number;
}
interface Measurements {
  ranges: RangeSample[];
  misses: unknown[];
  frames: { at: number; ms: number; historicalReads: number }[];
  historicalReads: number;
  longTasks: { at: number; ms: number }[];
  streamStart: number;
  streamEnd: number;
}
const rank = (id: string) => Number(id.slice("msg_scale".length));

for (const theme of ["otk-dark", "otk-light"]) {
  test(`real scale wheel/PageUp/PageDown preserve ten-ahead reserve and reverse cache at 75ms collection latency (${theme})`, async () => {
    const root = await tempDir("rw-"),
      f = await messageScaleBrowser(root, { theme, latency: 75 });
    const { browser } = f;
    const steps: unknown[] = [];
    resources().evidence(
      "trusted scale scroll schedule",
      () =>
        Deno.writeTextFile(
          join(root, "scroll-schedule.json"),
          JSON.stringify(steps, null, 2),
        ),
    );
    await browser.click("#heap-arm-reserve");
    await browser.poll("scaleMeasurements.ranges.length>0");
    const current = () =>
      browser.evaluate<RangeSample>("scaleMeasurements.ranges.at(-1)");
    const gesture = async (direction: -1 | 1, keyboard: boolean) => {
      const before = await current();
      if (keyboard) {
        await browser.evaluate(
          `(()=>{const pane=document.querySelector('.heap-view .otk-messages'),v=pane.getBoundingClientRect();const target=[...pane.querySelectorAll('.otk-created-trigger')].find(e=>{const r=e.getBoundingClientRect();return r.top>=v.top && r.bottom<=v.bottom});target?.focus({preventScroll:true})})()`,
        );
        for (const type of ["keyDown", "keyUp"]) {
          await browser.send("Input.dispatchKeyEvent", {
            type,
            key: direction < 0 ? "PageUp" : "PageDown",
            code: direction < 0 ? "PageUp" : "PageDown",
            windowsVirtualKeyCode: direction < 0 ? 33 : 34,
            nativeVirtualKeyCode: direction < 0 ? 33 : 34,
          });
        }
      } else {
        const geometry = await browser.evaluate<
          { x: number; y: number; delta: number }
        >("(()=>{const e=document.querySelector('.heap-view .otk-messages'),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,delta:e.clientHeight*0.5}})()");
        await browser.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: geometry.x,
          y: geometry.y,
          deltaX: 0,
          deltaY: direction * geometry.delta,
        });
      }
      // Fixed observation cadence: never wait for a missing reserve to refill.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const after = await current();
      const geometry = await browser.evaluate<
        {
          offscreen: { key: string; focused: boolean; messages: string[] }[];
          text: string[];
          pins: string[];
        }
      >(`(()=>{const pane=document.querySelector('.heap-view .otk-messages'),v=pane.getBoundingClientRect();return {offscreen:[...pane.querySelectorAll('[aria-label="Transcript messages"] > .otk-virtual-item')].filter(e=>{const r=e.getBoundingClientRect();return r.bottom<=v.top || r.top>=v.bottom}).map(e=>({key:e.dataset.virtualKey,focused:e.contains(document.activeElement),messages:[...e.querySelectorAll('[data-message]')].map(m=>m.dataset.message)})),text:[...pane.querySelectorAll('.otk-text p')].filter(e=>{const r=e.getBoundingClientRect();return r.bottom>v.top && r.top<v.bottom}).map(e=>e.textContent),pins:[...scaleMeasurements.pins]}})()`);
      steps.push({ direction, keyboard, before, after, geometry });
      const advance = direction < 0
        ? rank(before.first) - rank(after.first)
        : rank(after.last) - rank(before.last);
      // These are in-flight samples at the fixed input cadence, not settled
      // geometry. Record displacement and pins; assert window structure below
      // after input has ended and the measured layout actually settles.
      if (advance < 0 || advance > 10) {
        console.info("Scale scroll displacement sample", {
          direction,
          advance,
        });
      }
      assert(geometry.text.length > 0);
      assert(
        geometry.text.every((text) => /^Scale fixture 0\/\d+\/\d+$/.test(text)),
      );
      return after;
    };
    let previous = await current(), stalled = 0;
    for (let n = 0; rank(previous.first) !== 0; n++) {
      assert(n < 1000, "scroll must traverse the complete native session");
      const next = await gesture(-1, n % 3 === 2);
      stalled = next.first === previous.first ? stalled + 1 : 0;
      assert(
        stalled < 15,
        "trusted history input cannot stall at a virtual boundary",
      );
      previous = next;
    }
    assertEquals(f.reads.length, 153);
    assertEquals(f.reads.filter((read) => !read.before).length, 1);
    const loaded = f.reads.length;
    stalled = 0;
    for (let n = 0; rank(previous.last) !== 1524; n++) {
      assert(n < 1000);
      const next = await gesture(1, n % 3 === 2);
      stalled = next.last === previous.last ? stalled + 1 : 0;
      assert(
        stalled < 15,
        "reverse input must reuse the acquired native range",
      );
      previous = next;
    }
    await browser.click("#heap-stop-probe");
    await browser.poll(
      `(()=>{const pane=document.querySelector('.heap-view .otk-messages'),v=pane.getBoundingClientRect();return [...pane.querySelectorAll('[aria-label="Transcript messages"] > .otk-virtual-item')].every(e=>{const r=e.getBoundingClientRect();return (r.bottom>v.top && r.top<v.bottom) || e.contains(document.activeElement)})})()`,
    );
    const result = await browser.evaluate<Measurements>("scaleMeasurements");
    console.info("Scale scroll reserve measurements", {
      samples: result.ranges.length,
      misses: result.misses,
    });
    assert(result.ranges.length > 100);
    assertEquals(f.reads.length, loaded);
    assertEquals(browser.errors, []);
    f.serving.stop();
    f.serving.assert();
  });

  test(`real scale thousand streamed part updates visit no historical records and retain visible nodes (${theme})`, async () => {
    const root = await tempDir("rs-"),
      f = await messageScaleBrowser(root, { theme });
    const { browser } = f;
    await browser.click("#heap-load-all");
    await browser.poll(
      "document.querySelector('#heap-state').dataset.aCount==='1525' && document.querySelector('#heap-state').dataset.loading==='false'",
      120000,
    );
    const point = await browser.evaluate<{ x: number; y: number }>(
      "(()=>{const r=document.querySelector('.heap-view .otk-messages').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
    );
    await browser.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...point,
      deltaX: 0,
      deltaY: -300,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await browser.evaluate(
      `(()=>{const pane=document.querySelector('.heap-view .otk-messages'),v=pane.getBoundingClientRect();globalThis.stableHistoryNodes=[...pane.querySelectorAll('.otk-text')].filter(e=>{const r=e.getBoundingClientRect();return r.bottom>v.top && r.top<v.bottom}).map(e=>({node:new WeakRef(e),top:e.getBoundingClientRect().top}));})()`,
    );
    assert(await browser.evaluate<number>("stableHistoryNodes.length") > 0);
    const task = await f.client.rpc<{ id: string }>("tasks.create", {
      directory: f.target.directory,
      name: "Scale live actions",
      sessions: [f.target.id],
    });
    await f.client.rpc("tasks.rename", {
      id: task.id,
      name: "Scale live actions saved",
    });
    const chunks = Array.from(
      { length: 1000 },
      (_, n) => `live-${String(n).padStart(4, "0")}${n === 999 ? "" : " "}`,
    );
    // Hold only the terminal empty control chunk, so the final real delta flushes
    // before completion. Each of all 1000 updates is admitted through stock SSE.
    const producer = f.fake.queueStepped({ chunks: [...chunks, ""], delay: 0 });
    await browser.click("#heap-arm-stream");
    await f.native.request(`/session/${f.target.nativeID}/prompt_async`, {
      method: "POST",
      body: {
        agent: "build",
        model: { providerID: "fake", modelID: "scripted" },
        parts: [{ type: "text", text: "Scale live transcript update" }],
      },
    });
    for (let n = 0; n < 1000; n++) {
      producer.next();
      await browser.poll(`scaleMeasurements.frames.length===${n + 1}`, 10000);
    }
    producer.next();
    await browser.poll(
      "scaleMeasurements.frames.length===1000 && scaleMeasurements.completedMessage && document.querySelector('#heap-state').dataset.aBusy==='false'",
    );
    await browser.evaluate(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
    const stable = await browser.evaluate<
      { connected: boolean; drift: number }[]
    >("stableHistoryNodes.map(value=>({connected:!!value.node.deref()?.isConnected,drift:Math.abs((value.node.deref()?.getBoundingClientRect().top??Infinity)-value.top)}))");
    assert(
      stable.every((node) => node.connected && node.drift <= 1),
      JSON.stringify(stable),
    );
    await browser.click("#heap-stop-probe");
    const result = await browser.evaluate<Measurements>("scaleMeasurements");
    assertEquals(result.frames.length, 1000);
    assertEquals(result.historicalReads, 0);
    assert(result.frames.every((frame) => frame.historicalReads === 0));
    console.info("Scale streaming measurements", {
      frames: result.frames.length,
      maximumFrameMs: result.frames.reduce(
        (maximum, frame) => Math.max(maximum, frame.ms),
        0,
      ),
      longTasks: result.longTasks,
    });
    const tasks = await f.client.rpc<{ id: string; name: string }[]>(
      "tasks.list",
      {},
    );
    assertEquals(
      tasks.find((row) => row.id === task.id)?.name,
      "Scale live actions saved",
    );
    const expected = chunks.join("");
    const native = await f.native.request<
      {
        info: { id: string; role: string };
        parts: { type: string; text?: string }[];
      }[]
    >(`/session/${f.target.nativeID}/message?limit=2`);
    const reply = native.find((message) => message.info.role === "assistant")!;
    assert(reply);
    assertEquals(
      reply.parts.filter((part) => part.type === "text").map((part) =>
        part.text
      ).join(""),
      expected,
    );
    await browser.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...point,
      deltaX: 0,
      deltaY: 1e7,
    });
    await browser.poll(
      "document.querySelector('.heap-view .otk-message-flow').textContent.includes('live-0999')",
      60000,
    );
    const replySelector = `[data-message="${reply.info.id}"]`;
    const hover = await browser.evaluate<{ x: number; y: number }>(
      `(()=>{const r=document.querySelector(${
        JSON.stringify(replySelector + " .otk-message-content")
      }).getBoundingClientRect();return {x:r.x+r.width/2,y:Math.min(r.bottom-10,innerHeight-180)}})()`,
    );
    await browser.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...hover,
    });
    await browser.send("Browser.grantPermissions", {
      origin: f.uiURL,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    await browser.click(`${replySelector} [data-message-command="reply.copy"]`);
    await browser.poll(
      `navigator.clipboard.readText().then(value=>value===${
        JSON.stringify(expected)
      })`,
    );
    assertEquals(browser.errors, []);
    f.serving.stop();
    f.serving.assert();
  });
}
