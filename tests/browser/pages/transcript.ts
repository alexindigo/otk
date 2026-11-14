// SPDX-License-Identifier: LGPL-3.0-only
import { expect, type Page } from "@playwright/test";
import type { TestState } from "../fixtures/test-state.ts";
import type { Json } from "../../support/fixture-control.ts";

export const viewportSource = Array.from(
  { length: 2000 },
  (_, i) => i % 127 === 126 ? "" : `const viewport${i}: number = ${i};`,
).join("\n");

export async function nativeIdle(state: TestState, id: string) {
  await expect.poll(async () =>
    (await state.native<
      { info: { role: string; time: { completed?: number } } }[]
    >(`/session/${id}/message`)).some((message) =>
      message.info.role === "assistant" && !!message.info.time.completed
    )
  ).toBe(true);
}

/** Native idle can precede the final transcript footer layout. */
export async function hoverCompletedUsage(page: Page) {
  await expect(page.locator(".otk-turn-time").last()).toHaveText(
    /^\d+(?:\.\d+)?s$/,
  );
  await expect(page.locator(".otk-response-progress")).toHaveCount(0);
  await page.evaluate(() =>
    document.fonts.ready.then(() =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
    )
  );
  await page.locator(".otk-turn-usage > button").hover();
}

export async function prompt(page: Page, text: string) {
  const input = page.locator("textarea[name=prompt]");
  await input.fill(text);
  // Native idle precedes settlement of the composer submission owner. Match
  // the legacy submitPrompt admission, rather than dropping Enter while pending.
  await expect(page.locator(".otk-send-button")).toBeEnabled();
  await expect(input).toBeFocused();
  await input.press("Enter");
}

export async function toolScript(
  state: TestState,
  name: string,
  input: Record<string, Json>,
  reply = "Tool finished.",
) {
  await state.controller.call("queueScript", {
    lease: state.lease.lease,
    chunks: [],
    tool: { name, input },
  });
  await state.queue([reply]);
}

export async function expandTool(page: Page, selector: string) {
  const toggle = page.locator(selector + " .otk-tool-toggle");
  await expect(toggle).toBeAttached();
  if (await toggle.getAttribute("aria-expanded") !== "true") {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

export async function showFileChanges(state: TestState, page: Page) {
  await page.locator(".otk-display-menu > button").click();
  const input = page.locator("input[name=collapseFileChanges]");
  await expect(input).toBeChecked();
  await input.click();
  await expect(input).not.toBeChecked();
  await expect.poll(async () =>
    (await state.product("prefs.get", {})).collapseFileChanges
  ).toBe(false);
  await page.keyboard.press("Escape");
  await expect.poll(() =>
    page.locator("[data-tool=write] .otk-code code").evaluateAll((codes) =>
      codes.every((code) =>
        !code.closest("[hidden]") && code.getBoundingClientRect().height > 0
      )
    )
  ).toBe(true);
}

/** One native gesture; scrollend is armed before dispatch, never guessed by a delay. */
export async function wheelTranscript(page: Page, deltaY: number) {
  const pane = page.locator(".otk-messages");
  await pane.evaluate((element, delta) => {
    const globals = globalThis as typeof globalThis & {
      transcriptWheelDone: boolean;
    };
    const canMove = delta < 0
      ? element.scrollTop > 0
      : element.scrollTop < element.scrollHeight - element.clientHeight;
    globals.transcriptWheelDone = !canMove;
    if (canMove) {
      element.addEventListener(
        "scrollend",
        () => globals.transcriptWheelDone = true,
        { once: true },
      );
    }
  }, deltaY);
  await pane.hover();
  await page.mouse.wheel(0, deltaY);
  await expect.poll(() =>
    page.evaluate(() =>
      (globalThis as typeof globalThis & { transcriptWheelDone: boolean })
        .transcriptWheelDone
    )
  ).toBe(true);
}

export async function scrollTranscript(page: Page, bottom: boolean) {
  const gap = () =>
    page.locator(".otk-messages").evaluate(
      (pane, end) =>
        end
          ? pane.scrollHeight - pane.clientHeight - pane.scrollTop
          : pane.scrollTop,
      bottom,
    );
  // Installing measured source can grow the scroll range after a gesture.
  // Converge through native wheels against that live range, not a stale height.
  await expect.poll(async () => {
    const remaining = await gap();
    if (remaining >= 2) {
      await wheelTranscript(page, bottom ? remaining : -remaining);
    }
    return await gap();
  }).toBeLessThan(2);
}

/** Select through trusted native double-click, including an unstyled text node. */
export async function selectSourceWord(page: Page, word: string, last = false) {
  const code = page.locator(".otk-code code").nth(last ? -1 : 0);
  // Font installation can resize both source and the enclosing composer. Keep
  // the gesture attached to the code's current box through native actionability,
  // rather than dispatching a previously sampled viewport coordinate.
  await page.evaluate(() => document.fonts.ready.then(() => true));
  const position = await code
    .evaluate((code, needle) => {
      const walk = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walk.nextNode())) {
        const offset = node.textContent!.indexOf(needle);
        if (offset < 0) continue;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + needle.length);
        const box = range.getBoundingClientRect(),
          origin = code.getBoundingClientRect();
        return {
          x: box.x - origin.x + box.width / 2,
          y: box.y - origin.y + box.height / 2,
        };
      }
      throw new Error("Missing native source word: " + needle);
    }, word);
  await code.dblclick({ position });
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe(
    word,
  );
}

export async function copySelection(page: Page, word: string) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(word);
}

/** Observe the marker's actual stable rendered range and genuine worker colour. */
export async function highlightedRange(
  page: Page,
  selector: string,
  marker: string,
) {
  await expect.poll(() =>
    page.evaluate(async ({ selector, marker }) => {
      const code = Array.from(document.querySelectorAll(selector)).find(
        (element) => element.textContent!.includes(marker),
      );
      if (!code) return false;
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
      let node: Node | null, range: Range | undefined;
      while ((node = walker.nextNode())) {
        const offset = node.textContent!.indexOf(marker);
        if (offset < 0) continue;
        range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + marker.length);
        break;
      }
      if (!range || !node) return false;
      const viewport = code.closest(".otk-messages")?.getBoundingClientRect() ??
        { top: 0, bottom: innerHeight, left: 0, right: innerWidth };
      let rect = range.getBoundingClientRect();
      if (
        rect.top < viewport.top || rect.bottom > viewport.bottom ||
        rect.left < viewport.left || rect.right > viewport.right
      ) {
        const scroller = code.closest(".otk-messages");
        if (scroller) {
          scroller.scrollBy({
            top: rect.top - (viewport.top + viewport.bottom) / 2,
            left: 0,
            behavior: "instant",
          });
        } else {node.parentElement!.scrollIntoView({
            block: "center",
            behavior: "instant",
          });}
        return false;
      }
      for (let frame = 0; frame < 2; frame++) {
        await new Promise(requestAnimationFrame);
        const next = range.getBoundingClientRect();
        if (
          next.top !== rect.top || next.left !== rect.left ||
          next.width !== rect.width || !node.isConnected
        ) return false;
        rect = next;
      }
      const token = node.parentElement!.closest<HTMLElement>(".otk-token");
      return !!token && code.contains(token) && !!token.style.color &&
        getComputedStyle(token).color !== "rgba(0, 0, 0, 0)";
    }, { selector, marker }), { timeout: 30_000 }).toBe(true);
}

export interface NativeToolPart {
  id: string;
  messageID: string;
  type: string;
  state: {
    status: string;
    output?: string;
    metadata?: Record<string, unknown>;
  };
}

export async function runNativeTool(
  state: TestState,
  page: Page,
  sessionID: string,
  name: string,
  input: Record<string, Json>,
  model?: { providerID: string; modelID: string },
) {
  const before = await state.native<
    { info: { id: string }; parts: NativeToolPart[] }[]
  >(
    `/session/${sessionID}/message`,
  );
  const old = new Set(
    before.flatMap((message) => message.parts).map((part) => part.id),
  );
  const oldMessages = new Set(before.map((message) => message.info.id));
  await toolScript(state, name, input, `Finished ${name}.`);
  if (model) {
    await state.native(`/session/${sessionID}/prompt_async`, "POST", {
      model,
      parts: [{ type: "text", text: `Run ${name}` }],
    });
  } else await prompt(page, `Run ${name}`);
  let result: NativeToolPart | undefined;
  await expect.poll(async () => {
    const messages = await state.native<{
      info: {
        id: string;
        role: string;
        finish?: string;
        time: { completed?: number };
      };
      parts: (NativeToolPart & { text?: string })[];
    }[]>(
      `/session/${sessionID}/message`,
    );
    result = messages.flatMap((message) => message.parts).find((part) =>
      !old.has(part.id) && part.type === "tool" &&
      part.state?.status === "completed"
    );
    // Native status can briefly become idle between a tool and its continuation.
    // Join this turn's new terminal text/checkpoint before admitting another
    // trusted prompt, exactly as the real empty-read integration witness does.
    return !!result &&
      messages.some((message) =>
        !oldMessages.has(message.info.id) &&
        message.info.role === "assistant" && message.info.finish === "stop" &&
        !!message.info.time.completed && message.parts.some((part) =>
          part.type === "text" &&
          part.text === `Finished ${name}.`
        )
      );
  }, { timeout: 60_000 }).toBe(true);
  await expect(page.locator(`[data-session="${sessionID}"]`)).toHaveAttribute(
    "data-status",
    "idle",
    { timeout: 60_000 },
  );
  return result!;
}

/** Reveal an acquired row through the actual measured scroll surface. */
export async function revealAcquired(page: Page, selector: string) {
  await page.evaluate(() =>
    new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    )
  );
  const probe = () =>
    page.locator(".otk-messages").evaluate(async (pane, selector) => {
      // A scroll notification precedes nested virtual-window installation. Join
      // the measured range (including mounted identities), not only the wheel's
      // scrollend, before treating an absent selector as an exhausted range.
      await document.fonts.ready;
      let previous = "", stable = 0;
      while (stable < 5) {
        await new Promise(requestAnimationFrame);
        const next = JSON.stringify([
          pane.scrollTop,
          pane.clientHeight,
          pane.scrollHeight,
          pane.getAttribute("aria-busy"),
          Array.from(
            pane.querySelectorAll("[data-virtual-key]"),
            (e) => e.getAttribute("data-virtual-key"),
          ),
        ]);
        stable = pane.getAttribute("aria-busy") === "false" && next === previous
          ? stable + 1
          : 0;
        previous = next;
      }
      const element = pane.querySelector(selector),
        viewport = pane.getBoundingClientRect(),
        rect = element?.getBoundingClientRect();
      return {
        top: pane.scrollTop,
        height: pane.clientHeight,
        end: pane.scrollHeight - pane.clientHeight,
        delta: rect
          ? rect.top >= viewport.top && rect.bottom <= viewport.bottom
            ? 0
            : rect.top + Math.min(rect.height, pane.clientHeight) / 2 -
              viewport.top - pane.clientHeight / 2
          : undefined,
      };
    }, selector);
  let state = await probe();
  if (state.delta === undefined) {
    // Estimated extents can grow while nested sources materialize.
    await scrollTranscript(page, false);
    state = await probe();
  }
  while (state.delta === undefined) {
    if (state.top >= state.end) {
      throw new Error("Acquired target is unavailable: " + selector);
    }
    await wheelTranscript(page, state.height);
    state = await probe();
  }
  if (Math.abs(state.delta) >= 1) await wheelTranscript(page, state.delta);
}
