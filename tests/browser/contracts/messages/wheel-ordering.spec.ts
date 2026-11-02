// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { wheelTranscript } from "../../pages/transcript.ts";
import type { CDPSession, Page } from "@playwright/test";

const source = Array.from(
  { length: 2000 },
  (_, i) => i % 127 === 126 ? "" : `const viewport${i}: number = ${i};`,
).join("\n");

async function gap(page: Page) {
  return await page.locator(".otk-messages").evaluate((pane) =>
    pane.scrollHeight - pane.clientHeight - pane.scrollTop
  );
}

async function nativeWheel(page: Page, deltaY: number) {
  await wheelTranscript(page, deltaY);
}

/** Pause the real scroll dispatch before any product listener observes it.
 * The native wheel has already changed scrollTop; growth is introduced while
 * that notification is held, then the original dispatch is resumed unchanged.
 */
async function growBeforeScroll(page: Page, cdp: CDPSession) {
  const context = await page.context().newCDPSession(page);
  // Input dispatch stays on a second protocol connection so the debugger owner
  // can inspect and resume even when Input waits for main-thread completion.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wheel: Promise<unknown> | undefined;
  try {
    await context.send("Debugger.enable");
    const paused = new Promise<{ callFrames: { callFrameId: string }[] }>(
      (resolve, reject) => {
        timer = setTimeout(() =>
          reject(
            new Error(
              "Real wheel did not reach the controlled scroll boundary",
            ),
          ), 10_000);
        context.once("Debugger.paused", resolve);
      },
    );
    // A global event-listener breakpoint can miss the compositor's scroll
    // dispatch. A test-owned capture hook pauses that exact notification before
    // the viewport's target listener, and only after this trusted wheel. Await
    // the installation acknowledgement before dispatch; no page calls follow it.
    const armed = await context.send("Runtime.evaluate", {
      expression:
        `(()=>{const pane=document.querySelector('.otk-messages');let trusted=false;pane.addEventListener('wheel',event=>{trusted=event.isTrusted;pane.setAttribute('data-ordering-wheel',trusted?'trusted':'synthetic')},{once:true,passive:true});const hold=event=>{if(event.target!==pane||!trusted)return;document.removeEventListener('scroll',hold,true);debugger;};document.addEventListener('scroll',hold,true);const box=pane.getBoundingClientRect();return {x:box.x+8,y:box.y+box.height/2,gap:pane.scrollHeight-pane.clientHeight-pane.scrollTop};})()`,
      returnByValue: true,
    });
    expect(armed.exceptionDetails).toBeUndefined();
    const point = armed.result.value as { x: number; y: number; gap: number };
    expect(Math.abs(point.gap - 8)).toBeLessThanOrEqual(.5);
    wheel = cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: point.x,
      y: point.y,
      deltaX: 0,
      deltaY: 100000,
    });
    const event = await paused;
    const result = await context.send("Debugger.evaluateOnCallFrame", {
      callFrameId: event.callFrames[0].callFrameId,
      expression:
        `(()=>{const pane=document.querySelector('.otk-messages');const before={top:pane.scrollTop,height:pane.scrollHeight,gap:pane.scrollHeight-pane.clientHeight-pane.scrollTop};const growth=document.createElement('div');growth.style.height='80px';growth.textContent='Late transcript layout';pane.querySelector('.otk-message-flow').append(growth);return {before,after:pane.scrollHeight,trusted:pane.getAttribute('data-ordering-wheel')};})()`,
      returnByValue: true,
    });
    expect(result.exceptionDetails).toBeUndefined();
    const ordering = result.result.value as {
      before: { gap: number; height: number };
      after: number;
      trusted: string;
    };
    expect(ordering.trusted).toBe("trusted");
    expect(ordering.before.gap, JSON.stringify(ordering)).toBeLessThan(2);
    expect(ordering.after - ordering.before.height).toBeGreaterThanOrEqual(80);
    await context.send("Debugger.resume");
    await wheel;
    return ordering;
  } finally {
    clearTimeout(timer);
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
    for (const numbered of [false, true]) {
      const session = await state.native<{ id: string }>("/session", "POST", {
        title: "Wheel/layout ordering " + numbered,
      });
      if (numbered) {
        await state.controller.call("queueScript", {
          lease: state.lease.lease,
          chunks: [],
          tool: {
            name: "write",
            input: { filePath: state.directory + "/wheel.ts", content: source },
          },
        });
        await state.queue(["Written."]);
      } else await state.queue(["```ts\n" + source + "\n```\n"]);
      await state.native(`/session/${session.id}/prompt_async`, "POST", {
        parts: [{ type: "text", text: "Prepare wheel source" }],
      });
      await expect.poll(async () =>
        (await state.native<{ info: { time: { completed?: number } } }[]>(
          `/session/${session.id}/message`,
        )).some((message) => !!message.info.time.completed)
      ).toBe(true);
      await openSession(state, page, session.id);
      if (numbered) {
        await page.locator(".otk-display-menu > button").click();
        const collapse = page.locator("input[name=collapseFileChanges]");
        await expect(collapse).toBeChecked();
        // Shared controls paint the authoritative async preference result;
        // Playwright's immediate post-click uncheck assertion is too early.
        await collapse.click();
        await expect(collapse).not.toBeChecked();
        await expect.poll(() =>
          frames.received.some((frame) =>
            frame.t === "prefs" &&
            (frame.prefs as { collapseFileChanges: boolean })
                .collapseFileChanges === false
          )
        ).toBe(true);
        await page.keyboard.press("Escape");
      }
      await expect(page.locator(".otk-code code")).toHaveJSProperty(
        "textContent",
        source,
      );
      await expect(
        page.locator(`.otk-project-sessions [data-session="${session.id}"]`),
      ).toHaveAttribute("data-status", "idle");
      await expect.poll(() =>
        frames.sent.some(({ frame }) =>
          frame.method === "layout.location" &&
          frame.params?.sessionID === session.id &&
          frames.received.some((result) =>
            result.t === "request.result" &&
            result.ref?.key === frame.ref?.key &&
            (result.outcome as { ok: boolean }).ok
          )
        )
      ).toBe(true);
      await expect(page.locator(".otk-composer-notice")).toHaveCount(0);
      await expect(
        page.locator(".otk-message-details").filter({ hasText: "streaming" }),
      ).toHaveCount(0);
      if (numbered) {
        await expect(
          page.locator(".otk-text p").filter({ hasText: /^Written\.$/ }),
        ).toHaveCount(1);
      }
      await expect.poll(() => gap(page)).toBeLessThan(2);
      await nativeWheel(page, -8);
      await expect.poll(async () => Math.abs((await gap(page)) - 8))
        .toBeLessThanOrEqual(.5);
      const ordering = await growBeforeScroll(page, cdp);
      await info.attach(`ordering-${numbered}`, {
        body: JSON.stringify(ordering),
        contentType: "application/json",
      });
      await expect.poll(() => gap(page), { timeout: 3000 }).toBeLessThan(2);
      await expect(page.locator(".otk-code code")).toHaveJSProperty(
        "textContent",
        source,
      );
      await page.locator(".otk-messages").evaluate((pane) => {
        pane.tabIndex = 0;
        pane.focus();
        const globals = globalThis as typeof globalThis & {
          keyScrollEnded: boolean;
        };
        globals.keyScrollEnded = false;
        pane.addEventListener("keydown", () => {
          const end = () => {
            if (pane.scrollHeight - pane.clientHeight - pane.scrollTop <= 100) {
              return;
            }
            globals.keyScrollEnded = true;
            pane.removeEventListener("scrollend", end);
          };
          pane.addEventListener("scrollend", end);
        }, { once: true });
      });
      await page.keyboard.press("Shift+Space");
      await expect.poll(
        () =>
          page.evaluate(() =>
            (globalThis as typeof globalThis & { keyScrollEnded: boolean })
              .keyScrollEnded
          ),
        { timeout: 3000 },
      ).toBe(true);
      await expect.poll(() => gap(page), { timeout: 3000 }).toBeGreaterThan(
        100,
      );
      const reader = await page.locator(".otk-messages").evaluate(
        async (pane) => {
          const before = pane.scrollTop;
          const flow = pane.querySelector(".otk-message-flow")!;
          const growth = document.createElement("div");
          growth.style.height = "80px";
          await new Promise<void>((resolve) => {
            const observer = new ResizeObserver(() => {
              observer.disconnect();
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve())
              );
            });
            observer.observe(flow);
            flow.append(growth);
          });
          return { before, after: pane.scrollTop };
        },
      );
      expect(Math.abs(reader.before - reader.after), JSON.stringify(reader))
        .toBeLessThan(2);
    }
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp.detach();
  });
}
