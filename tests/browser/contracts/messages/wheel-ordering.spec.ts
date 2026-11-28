// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { viewing } from "../../pages/composer.ts";
import {
  revealTool,
  scrollTranscript,
  scrollViewport,
  sessionStatus,
  settledNativeReply,
  wheelViewport,
  workPanel,
} from "../../pages/transcript.ts";
import type { CDPSession, Locator, Page } from "@playwright/test";

const source = Array.from(
  { length: 2000 },
  (_, i) => i % 127 === 126 ? "" : `const viewport${i}: number = ${i};`,
).join("\n");

async function gap(pane: Locator) {
  return await pane.evaluate((pane) =>
    pane.scrollHeight - pane.clientHeight - pane.scrollTop
  );
}

async function moveReaderAway(page: Page, pane: Locator) {
  await pane.evaluate((pane) => {
    pane.tabIndex = 0;
    pane.focus();
    pane.removeAttribute("data-reader-scroll-end");
    pane.addEventListener("keydown", () => {
      const end = () => {
        if (pane.scrollHeight - pane.clientHeight - pane.scrollTop <= 100) {
          return;
        }
        pane.setAttribute("data-reader-scroll-end", "true");
        pane.removeEventListener("scrollend", end);
      };
      pane.addEventListener("scrollend", end);
    }, { once: true });
  });
  await page.keyboard.press("Shift+Space");
  await expect(pane).toHaveAttribute("data-reader-scroll-end", "true", {
    timeout: 3000,
  });
  await expect.poll(() => gap(pane), { timeout: 3000 }).toBeGreaterThan(100);
}

/** Simulate late content below the reading anchor, not setup scroll range. */
async function keepReadingAnchor(pane: Locator, flowSelector?: string) {
  const reader = await pane.evaluate(async (pane, flowSelector) => {
    const before = pane.scrollTop, height = pane.scrollHeight;
    const flow = flowSelector ? pane.querySelector(flowSelector)! : pane;
    const growth = document.createElement("div");
    growth.style.height = "80px";
    growth.style.flexShrink = "0";
    growth.textContent = "Additional test results arrived while reading.";
    await new Promise<void>((resolve) => {
      const observer = new ResizeObserver(() => {
        observer.disconnect();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      observer.observe(growth);
      flow.append(growth);
    });
    return {
      before,
      after: pane.scrollTop,
      growth: pane.scrollHeight - height,
    };
  }, flowSelector);
  expect(reader.growth).toBeGreaterThanOrEqual(80);
  expect(Math.abs(reader.before - reader.after), JSON.stringify(reader))
    .toBeLessThan(2);
}

/** Own both native wheel/scroll boundaries, including the setup gesture.
 * A blocking capture listener orders wheel intent before compositor scrolling;
 * the scroll capture pauses before product listeners or layout callbacks run.
 * Growth is introduced only at the toward gesture's held scroll notification.
 */
async function orderedWheel(page: Page, cdp: CDPSession, grow: boolean) {
  const context = await page.context().newCDPSession(page);
  // Input dispatch stays on a second protocol connection so the debugger owner
  // can inspect and resume even when Input waits for main-thread completion.
  let wheel: Promise<unknown> | undefined;
  try {
    await context.send("Debugger.enable");
    const paused = new Promise<{ callFrames: { callFrameId: string }[] }>(
      (resolve) => {
        context.once("Debugger.paused", resolve);
      },
    );
    // A global event-listener breakpoint can miss the compositor's scroll
    // dispatch. A test-owned capture hook pauses that exact notification before
    // the viewport's target listener, and only after this trusted wheel. The
    // non-passive wheel capture makes the browser join intent dispatch before
    // applying its default scroll, even with a compositor-scrolled transcript.
    // A queued notification can precede that default movement. Admit only the
    // gesture's physical endpoint, not the first scroll after its wheel event.
    // Use the transcript gutter so nested code scrollers cannot take the wheel.
    // Await installation before dispatch; no page calls follow it.
    const armed = await context.send("Runtime.evaluate", {
      expression:
        `(()=>{const pane=document.querySelector('.otk-messages');let trusted=false;pane.addEventListener('wheel',event=>{trusted=event.isTrusted;pane.setAttribute('data-ordering-wheel',trusted?'trusted':'synthetic');pane.setAttribute('data-ordering-wheel-gap',String(pane.scrollHeight-pane.clientHeight-pane.scrollTop))},{once:true,capture:true,passive:false});const hold=event=>{if(event.target!==pane||!trusted||Math.abs(pane.scrollHeight-pane.clientHeight-pane.scrollTop-${
          grow ? 0 : 8
        })>.5)return;document.removeEventListener('scroll',hold,true);debugger;};document.addEventListener('scroll',hold,true);const box=pane.getBoundingClientRect();return {x:box.x+8,y:box.y+box.height/2,gap:pane.scrollHeight-pane.clientHeight-pane.scrollTop};})()`,
      returnByValue: true,
    });
    expect(armed.exceptionDetails).toBeUndefined();
    const point = armed.result.value as { x: number; y: number; gap: number };
    expect(Math.abs(point.gap - (grow ? 8 : 0))).toBeLessThanOrEqual(.5);
    wheel = cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: point.x,
      y: point.y,
      deltaX: 0,
      deltaY: grow ? 100000 : -8,
    });
    const event = await paused;
    const result = await context.send("Debugger.evaluateOnCallFrame", {
      callFrameId: event.callFrames[0].callFrameId,
      expression:
        `(()=>{const pane=document.querySelector('.otk-messages');const before={top:pane.scrollTop,height:pane.scrollHeight,gap:pane.scrollHeight-pane.clientHeight-pane.scrollTop};if(${grow}){const growth=document.createElement('div');growth.style.height='80px';growth.textContent='Late transcript layout';pane.querySelector('.otk-message-flow').append(growth);}return {before,after:pane.scrollHeight,trusted:pane.getAttribute('data-ordering-wheel'),wheelGap:Number(pane.getAttribute('data-ordering-wheel-gap'))};})()`,
      returnByValue: true,
    });
    expect(result.exceptionDetails).toBeUndefined();
    const ordering = result.result.value as {
      before: { gap: number; height: number };
      after: number;
      trusted: string;
      wheelGap: number;
    };
    expect(ordering.trusted).toBe("trusted");
    expect(
      Math.abs(ordering.wheelGap - (grow ? 8 : 0)),
      JSON.stringify(ordering),
    ).toBeLessThanOrEqual(.5);
    expect(
      Math.abs(ordering.before.gap - (grow ? 0 : 8)),
      JSON.stringify(ordering),
    ).toBeLessThanOrEqual(.5);
    if (grow) {
      expect(ordering.after - ordering.before.height).toBeGreaterThanOrEqual(
        80,
      );
    } else expect(ordering.after).toBe(ordering.before.height);
    await context.send("Debugger.resume");
    await wheel;
    return ordering;
  } finally {
    try {
      await context.send("Debugger.disable");
      await wheel;
    } finally {
      await context.detach();
    }
  }
}

for (const cpuRate of [1, 8]) {
  test(`messages.wheel-growth-before-scroll-cpu-${cpuRate}`, {
    tag: ["@messages", "@contracts"],
  }, async ({ state, page, context }, info) => {
    test.setTimeout(180_000);
    const frames = await wire(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
    // D74 / wl-5: tail-follow and ordering belong to the transcript. Its
    // own prose and code reply provide the scroll range, not tool output.
    try {
      const session = await state.native<{ id: string }>("/session", "POST", {
        title: "Transcript wheel/layout ordering",
      });
      await state.queue([
        "The following source lists the generated viewport cases. Each binding matches its case number.\n\n```ts\n" +
        source + "\n```\n",
      ]);
      await state.native(`/session/${session.id}/prompt_async`, "POST", {
        parts: [{ type: "text", text: "Prepare wheel source" }],
      });
      await expect.poll(async () =>
        (await state.native<{ info: { time: { completed?: number } } }[]>(
          `/session/${session.id}/message`,
        )).some((message) => !!message.info.time.completed)
      ).toBe(true);
      await openSession(state, page, session.id);
      const transcript = page.locator(".otk-messages");
      const code = transcript.locator(".otk-code code");
      await expect(code).toHaveJSProperty(
        "textContent",
        source,
      );
      await sessionStatus(page, session.id, "idle");
      // Viewing also settles sessions.seen. Its pending notice changes the
      // viewport allocation independently of the transcript's native idle state.
      await viewing(page, frames, session.id);
      await expect(
        page.locator(".otk-message-details").filter({ hasText: "streaming" }),
      ).toHaveCount(0);
      expect(await transcript.evaluate((p) => p.scrollHeight - p.clientHeight))
        .toBeGreaterThan(100);
      await expect.poll(() => gap(transcript)).toBeLessThan(2);
      const away = await orderedWheel(page, cdp, false);
      await expect.poll(async () => Math.abs((await gap(transcript)) - 8))
        .toBeLessThanOrEqual(.5);
      const ordering = await orderedWheel(page, cdp, true);
      await info.attach("transcript-ordering", {
        body: JSON.stringify({ away, toward: ordering }),
        contentType: "application/json",
      });
      await expect.poll(() => gap(transcript), { timeout: 3000 }).toBeLessThan(
        2,
      );
      await expect(code).toHaveJSProperty("textContent", source);
      await moveReaderAway(page, transcript);
      await keepReadingAnchor(transcript, ".otk-message-flow");
    } finally {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      await cdp.detach();
    }
  });

  test(`messages.numbered-work-reading-anchor-cpu-${cpuRate}`, {
    tag: ["@messages", "@contracts"],
  }, async ({ state, page, context }) => {
    test.setTimeout(180_000);
    const frames = await wire(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
    try {
      const session = await state.native<{ id: string }>("/session", "POST", {
        title: "Read numbered Work source",
      });
      await state.controller.call("queueScript", {
        lease: state.lease.lease,
        chunks: [],
        tool: {
          name: "write",
          input: { filePath: state.directory + "/wheel.ts", content: source },
        },
      });
      await state.queue(["Written."]);
      await state.native(`/session/${session.id}/prompt_async`, "POST", {
        parts: [{ type: "text", text: "Write the viewport cases" }],
      });
      await settledNativeReply(state, session.id, "Written.");
      await openSession(state, page, session.id);
      await sessionStatus(page, session.id, "idle");
      await viewing(page, frames, session.id);
      await revealTool(page, "[data-tool=write][data-tool-status=completed]");
      await page.locator(".otk-display-menu > button").click();
      const collapse = page.locator("input[name=collapseFileChanges]");
      await expect(collapse).not.toBeChecked();
      await collapse.click();
      await expect(collapse).toBeChecked();
      await expect.poll(() =>
        frames.received.some((frame) =>
          frame.t === "prefs" &&
          (frame.prefs as { collapseFileChanges: boolean })
              .collapseFileChanges === false
        )
      ).toBe(true);
      await page.keyboard.press("Escape");
      const work = workPanel(page).locator(".otk-work-list");
      const code = work.locator('.otk-code[data-numbered="true"] code');
      await expect(code).toHaveJSProperty("textContent", source);
      // D74 / wl-5: finished Work uses its own measured reading anchor. It
      // must not start following the tail when late detail grows below it.
      await scrollViewport(work, true);
      await expect.poll(() => gap(work)).toBeLessThan(2);
      await wheelViewport(work, -8);
      await expect.poll(async () => Math.abs((await gap(work)) - 8))
        .toBeLessThanOrEqual(.5);
      await moveReaderAway(page, work);
      // Grow the measured tool body, not an unmeasured viewport child.
      await keepReadingAnchor(work, "[data-tool=write] .otk-tool-body");
      await expect(code).toHaveJSProperty("textContent", source);
      await scrollTranscript(page, false);
      const prose = page.locator(".otk-messages .otk-text p").filter({
        hasText: /^Written\.$/,
      });
      await expect(prose).toHaveCount(1);
      await expect(prose).toBeInViewport();
    } finally {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      await cdp.detach();
    }
  });
}
