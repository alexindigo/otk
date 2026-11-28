// SPDX-License-Identifier: LGPL-3.0-only
import { expect, type Locator, type Page } from "@playwright/test";
import type { TestState } from "../fixtures/test-state.ts";
import type { Json } from "../../support/fixture-control.ts";
import { prompt as input, sendPrompt } from "./composer.ts";

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

/** Join the exact terminal reply, not a transient idle state between calls. */
export async function settledNativeReply(
  state: TestState,
  id: string,
  answer: string,
) {
  let messageID: string | undefined;
  await expect.poll(async () => {
    const history = await state.native<{
      info: {
        id: string;
        role: string;
        finish?: string;
        time: { completed?: number };
      };
      parts: { type: string; text?: string }[];
    }[]>(`/session/${id}/message`);
    messageID = history.find(({ info, parts }) =>
      info.role === "assistant" && info.finish === "stop" &&
      !!info.time.completed &&
      parts.some((part) => part.type === "text" && part.text === answer)
    )?.info.id;
    return messageID;
  }, { timeout: 60_000, message: `native terminal reply: ${answer}` })
    .toBeTruthy();
  return messageID!;
}

/** Native idle can precede the final transcript footer layout. */
export async function hoverCompletedUsage(page: Page) {
  await expect(page.locator(".otk-turn-time").last()).toHaveText(
    /^Worked for \d+(?:\.\d+)?s$/,
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
  await input(page).fill(text);
  await sendPrompt(page);
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

export const workPanel = (page: Page) =>
  page.locator('#otk-panel-content[aria-label="Work log"]');

/** Open the Work log for this reply, not the latest reply in another view (D74). */
export async function openWork(reply: Locator): Promise<Locator> {
  const page = reply.page();
  const strip = reply.locator(".otk-work-strip");
  await expect(strip).toBeAttached();
  if (await strip.getAttribute("aria-current") !== "true") {
    const back = page.getByRole("button", {
      name: "Back to conversation",
      exact: true,
    });
    if (await back.isVisible()) await back.click();
    // click the label, not a segment (which selects a specific run).
    await strip.getByText("Work log", { exact: true }).click();
  }
  const panel = workPanel(page);
  await expect(panel).toBeVisible();
  await expect(strip).toHaveAttribute("aria-current", "true");
  return panel;
}

export async function openLatestWork(page: Page): Promise<Locator> {
  return await openWork(
    page.locator('.otk-messages [data-role="assistant"]').filter({
      has: page.locator(".otk-work-strip"),
    }).last(),
  );
}

export async function showSessions(page: Page) {
  const tab = page.getByRole("tab", { name: "Sessions", exact: true });
  await expect(tab).toBeVisible();
  if (await tab.getAttribute("aria-selected") !== "true") await tab.click();
}

/** The Sessions view owns its status rows. Inspect that view, then restore Work. */
export async function sessionStatus(
  page: Page,
  sessionID: string,
  status: string,
) {
  const work = await workPanel(page).isVisible();
  if (work) await showSessions(page);
  await expect(page.locator(`[data-session=${JSON.stringify(sessionID)}]`))
    .toHaveAttribute("data-status", status);
  if (work) {
    await page.getByRole("tab", { name: "Work log", exact: true }).click();
  }
}

/** Open mounted background activity groups; they remain transcript disclosures. */
export async function openActivityGroups(
  page: Page,
  scope: Page | Locator = page,
) {
  await expect(
    scope.locator(".otk-record-group-toggle").first(),
  ).toBeAttached();
  // Opening a group can retire other virtual rows. Reacquire the next closed
  // group instead of retaining population indexes across geometry changes.
  const closed = scope.locator(
    '.otk-record-group-toggle[aria-expanded="false"]',
  );
  while (true) {
    // Work segments are repartitioned as native work settles. Reveal the next
    // closed control in its stable message, not a retiring virtual segment key.
    const selector = await closed.evaluateAll((buttons) => {
      const button = buttons[0];
      if (!button) return;
      const message = button.closest("[data-message]");
      return (message
        ? `[data-message=${
          JSON.stringify(message.getAttribute("data-message"))
        }] `
        : "") +
        '.otk-record-group-toggle[aria-expanded="false"]';
    });
    if (!selector) break;
    // This selector describes a currently closed projection, not a published
    // record. If it leaves the range while measuring, rescan the live groups.
    if (!await revealMounted(page, selector)) continue;
    // Once acquired, settlement belongs to this exact control. Re-querying a
    // closed-control selector would observe its successor instead of the click.
    const control = await page.$(selector);
    if (!control) continue;
    try {
      await control.evaluate((button) => (button as HTMLElement).click());
      await expect.poll(() =>
        control.evaluate((button) =>
          !button.isConnected ||
          button.getAttribute("aria-expanded") !== "false"
        )
      ).toBe(true);
    } finally {
      await control.dispose();
    }
  }
}

export async function expandTool(
  page: Page,
  selector: string,
  scope?: Locator,
) {
  const row = await revealTool(page, selector, scope);
  const toggle = row.locator(".otk-tool-toggle");
  if (await workPanel(page).locator(selector).count()) {
    if (await toggle.getAttribute("aria-expanded") !== "true") {
      await toggle.click();
    }
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  } else await openDisclosure(page, toggle, selector + " .otk-tool-toggle");
}

async function openDisclosure(page: Page, toggle: Locator, selector: string) {
  if (await toggle.getAttribute("aria-expanded") !== "true") {
    await revealAcquired(page, selector);
    await wheelTranscript(page, -1, toggle);
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

/** Work rows live in the selected reply's panel; context rows stay in flow. */
export async function revealTool(
  page: Page,
  selector: string,
  reply?: Locator,
) {
  const panel = reply ? await openWork(reply) : undefined;
  let row = (panel ?? page).locator(selector);
  if (!await row.count()) {
    const work = panel ?? await openLatestWork(page);
    row = work.locator(selector);
    if (!await row.count()) {
      for (
        const fold of await work.locator(
          '.otk-work-run > .otk-tree-node .otk-disclosure-button:not(.otk-tool-toggle)[aria-expanded="false"]',
        ).all()
      ) {
        await fold.click();
        if (await row.count()) break;
      }
    }
  }
  await expect(row).toBeVisible();
  return row;
}

export async function showFileChanges(state: TestState, page: Page) {
  await page.locator(".otk-display-menu > button").click();
  const input = page.locator("input[name=collapseFileChanges]");
  await expect(input).not.toBeChecked();
  await input.click();
  await expect(input).toBeChecked();
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
export async function wheelTranscript(
  page: Page,
  deltaY: number,
  target?: Locator,
) {
  await wheelViewport(page.locator(".otk-messages"), deltaY, target);
}

/** Settle the scroll owner being exercised, even when it is not the transcript. */
export async function wheelViewport(
  pane: Locator,
  deltaY: number,
  target?: Locator,
) {
  const page = pane.page();
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
  // A disclosure header belongs to this scroll scope, unlike a nested output
  // scroller that can consume a wheel aimed at the pane's geometric center.
  await (target ?? pane).hover();
  await page.mouse.wheel(0, deltaY);
  await expect.poll(() =>
    page.evaluate(() =>
      (globalThis as typeof globalThis & { transcriptWheelDone: boolean })
        .transcriptWheelDone
    )
  ).toBe(true);
}

export async function scrollTranscript(page: Page, bottom: boolean) {
  await scrollViewport(page.locator(".otk-messages"), bottom);
}

export async function scrollViewport(pane: Locator, bottom: boolean) {
  const gap = () =>
    pane.evaluate(
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
      await wheelViewport(pane, bottom ? remaining : -remaining);
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
  callID?: string;
  messageID: string;
  type: string;
  tool?: string;
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
  const answer = `Finished ${name}.`;
  const before = await state.native<
    { info: { id: string }; parts: NativeToolPart[] }[]
  >(
    `/session/${sessionID}/message`,
  );
  const old = new Set(
    before.flatMap((message) => message.parts).map((part) => part.id),
  );
  const oldMessages = new Set(before.map((message) => message.info.id));
  await toolScript(state, name, input, answer);
  if (model) {
    await state.native(`/session/${sessionID}/prompt_async`, "POST", {
      model,
      parts: [{ type: "text", text: `Run ${name}` }],
    });
  } else await prompt(page, `Run ${name}`);
  let result: NativeToolPart | undefined, terminalID: string | undefined;
  await expect.poll(async () => {
    const messages = await state.native<{
      info: {
        id: string;
        role: string;
        finish?: string;
        parentID?: string;
        metadata?: { parentID?: string };
        time: { completed?: number };
      };
      parts: (NativeToolPart & { text?: string })[];
    }[]>(
      `/session/${sessionID}/message`,
    );
    result = messages.flatMap((message) => message.parts).find((part) =>
      !old.has(part.id) && part.type === "tool" &&
      part.state?.status === "completed" &&
      part.tool === name && !oldMessages.has(part.messageID)
    );
    if (!result) return false;
    const source = messages.find(({ info }) => info.id === result!.messageID);
    const parentOf = (info: typeof messages[number]["info"]) =>
      info.parentID ?? info.metadata?.parentID;
    const parent = source && parentOf(source.info);
    // Native status can briefly become idle between a tool and its continuation.
    // Match the terminal message in the same native turn when the facade
    // exposes both parents; otherwise the wire replyTo join below proves it.
    terminalID = messages.find(({ info, parts }) =>
      !oldMessages.has(info.id) &&
      info.role === "assistant" && info.finish === "stop" &&
      !!info.time.completed &&
      (!parent || !parentOf(info) || parentOf(info) === parent) &&
      parts.some((part) => part.type === "text" && part.text === answer)
    )?.info.id;
    return !!terminalID;
  }, { timeout: 60_000 }).toBe(true);
  // A reply can span several native messages. The product groups them by
  // their published replyTo, not the tool source ID or repeated answer text.
  const published = { sourceID: result!.messageID, terminalID: terminalID! };
  let turnID: string | undefined;
  await expect.poll(async () => {
    turnID = await page.evaluate(
      ({ sourceID, terminalID }) => {
        const { transcriptPublication } = globalThis as typeof globalThis & {
          transcriptPublication: Map<string, import("@otk/protocol").Message>;
        };
        const source = transcriptPublication.get(sourceID);
        const terminal = transcriptPublication.get(terminalID);
        if (source?.role !== "assistant" || terminal?.role !== "assistant") {
          return;
        }
        const key = source.replyTo ?? source.id;
        if (key === (terminal.replyTo ?? terminal.id)) return key;
      },
      published,
    );
    return turnID;
  }, { timeout: 60_000, message: `Browser ownership of ${name} reply` })
    .toBeTruthy();
  const key = JSON.stringify(`reply:${turnID!}`);
  const reply = page.locator(
    `.otk-messages [data-virtual-key=${key}] [data-role="assistant"]`,
  );
  await expect(reply.getByText(answer, { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  // The reply shell can precede publication of the exact completed call.
  await expect.poll(() => {
    return page.evaluate(({ messageID, callID }) => {
      const { transcriptPublication } = globalThis as typeof globalThis & {
        transcriptPublication: Map<string, import("@otk/protocol").Message>;
      };
      return transcriptPublication.get(messageID)?.parts.some((part) =>
        part.kind === "tool" && part.call.callID === callID &&
        part.call.status === "completed"
      );
    }, {
      messageID: result!.messageID,
      // V1 exposes a part ID and a call ID; V2 identifies the tool by call ID.
      callID: result!.callID ?? result!.id,
    });
  }, { message: `Browser publication of completed ${name} tool` }).toBe(true);
  await openWork(reply);
  return result!;
}

/** Join publication, disclose identity-owned ancestry, then measured scrolling. */
export async function revealAcquired(page: Page, selector: string) {
  const inWork = workPanel(page).locator(selector);
  if (await inWork.count()) {
    await expect(inWork.first()).toBeVisible();
    return;
  }
  await revealMeasured(page, selector, true);
}

async function revealMounted(page: Page, selector: string) {
  return await revealMeasured(page, selector, false);
}

async function revealMeasured(page: Page, selector: string, required: boolean) {
  const identity =
    /\[data-(message|native-record|tool)(\^?=)(?:"([^"]+)"|'([^']+)'|([^\]]+))\]/
      .exec(selector);
  let messageID: string | undefined;
  if (required && identity) {
    await expect.poll(async () => {
      const publishedID = await page.evaluate(
        ({ kind, prefix, value, selector }) => {
          const mounted = document.querySelector(selector)?.closest<
            HTMLElement
          >(
            "[data-message]",
          );
          if (mounted) return mounted.dataset.message;
          const messages = (globalThis as typeof globalThis & {
            transcriptPublication?: Map<
              string,
              import("@otk/protocol").Message
            >;
          }).transcriptPublication;
          return [...messages?.values() ?? []].find((message) =>
            message.parts.length > 0 && (
              kind === "message"
                ? message.id === value
                : message.parts.some((part) => {
                  const name =
                    kind === "native-record" && part.kind === "external"
                      ? part.name
                      : kind === "tool" && part.kind === "tool"
                      ? part.call.tool
                      : undefined;
                  return name !== undefined &&
                    (prefix ? name.startsWith(value) : name === value);
                })
            )
          )?.id;
        },
        {
          kind: identity[1],
          prefix: identity[2] === "^=",
          value: identity[3] ?? identity[4] ?? identity[5],
          selector,
        },
      );
      // A tool kind is not its identity (read/list/glob all share typed kinds).
      // Pin it only once the complete selector identifies a mounted record.
      if (identity[1] !== "tool") messageID = publishedID;
      return publishedID;
    }, { message: "Browser publication of " + selector }).toBeTruthy();
  }
  const probe = async () => {
    const measured = await page.locator(".otk-messages").evaluate(
      async (pane, { selector, messageID }) => {
        // A scroll notification precedes nested virtual-window installation. Join
        // the measured range (including mounted identities), not only the wheel's
        // scrollend, before treating an absent selector as an exhausted range.
        await document.fonts.ready;
        const position = pane.id
          ? document.querySelector<HTMLElement>(
            `[role="scrollbar"][aria-controls="${
              CSS.escape(pane.id)
            }"][aria-orientation="vertical"]`,
          )
          : null;
        let previous = "", stable = 0;
        while (stable < 5) {
          await new Promise(requestAnimationFrame);
          const next = JSON.stringify([
            pane.scrollTop,
            pane.clientHeight,
            pane.scrollHeight,
            pane.getAttribute("aria-busy"),
            position?.getAttribute("aria-valuemax"),
            position?.getAttribute("aria-valuenow"),
            Array.from(
              pane.querySelectorAll("[data-virtual-key]"),
              (e) => e.getAttribute("data-virtual-key"),
            ),
          ]);
          stable =
            pane.getAttribute("aria-busy") === "false" && next === previous
              ? stable + 1
              : 0;
          previous = next;
        }
        // The group declares its membership; no assumed outer/inner wrapper count.
        // Clicking the control keeps retained disclosure choices with their owner.
        const disclosure = (group: HTMLElement) =>
          Array.from(
            group.querySelectorAll<HTMLElement>(".otk-record-group-toggle"),
          ).find((button) => button.closest("[data-record-members]") === group);
        const ancestor = Array.from(
          pane.querySelectorAll<HTMLElement>("[data-record-members]"),
        ).find((group) => {
          const members: string[] = JSON.parse(group.dataset.recordMembers!);
          return messageID &&
            (members.includes(messageID) ||
              members.includes("reply:" + messageID)) &&
            disclosure(group)?.getAttribute("aria-expanded") === "false";
        });
        if (ancestor) {
          disclosure(ancestor)!.click();
          return {
            top: pane.scrollTop,
            height: pane.clientHeight,
            end: pane.scrollHeight - pane.clientHeight,
            messageID,
            disclosed: true,
          };
        }
        // WP16 gives successful terminal records a footer-owned disclosure, so
        // their interval is not mounted until that public control is opened.
        // Acquire that ancestry through the real control, not a forced DOM row.
        const completion = messageID && !pane.querySelector(selector)
          ? pane.querySelector<HTMLElement>(
            '.otk-record-completion button[aria-expanded="false"]',
          )
          : undefined;
        if (completion) {
          completion.click();
          return {
            top: pane.scrollTop,
            height: pane.clientHeight,
            end: pane.scrollHeight - pane.clientHeight,
            messageID,
            disclosed: true,
          };
        }
        const element = Array.from(pane.querySelectorAll(selector)).find((
            element,
          ) =>
            !messageID ||
            element.closest("[data-message]")?.getAttribute("data-message") ===
              messageID
          ),
          viewport = pane.getBoundingClientRect(),
          rect = element?.getBoundingClientRect();
        const end = position
          ? Number(position.getAttribute("aria-valuemax"))
          : pane.scrollHeight - pane.clientHeight;
        const delta = rect
          ? rect.top >= viewport.top && rect.bottom <= viewport.bottom
            ? 0
            : rect.top + Math.min(rect.height, pane.clientHeight) / 2 -
              viewport.top - pane.clientHeight / 2
          : undefined;
        return {
          top: pane.scrollTop,
          height: pane.clientHeight,
          end,
          messageID:
            element?.closest("[data-message]")?.getAttribute("data-message") ??
              undefined,
          rect: rect
            ? { top: rect.top, bottom: rect.bottom, height: rect.height }
            : undefined,
          viewport: { top: viewport.top, bottom: viewport.bottom },
          delta: delta === undefined
            ? undefined
            : Math.max(0, Math.min(end, pane.scrollTop + delta)) -
              pane.scrollTop,
        };
      },
      { selector, messageID },
    );
    // Virtual overscan changes the first mounted match after a wheel. The
    // acquired record identity stays fixed while its geometry settles.
    messageID ??= measured.messageID;
    return measured;
  };
  let state = await probe();
  while (state.disclosed) state = await probe();
  if (!required && state.delta === undefined) return false;
  if (state.delta === undefined) {
    // Estimated extents can grow while nested sources materialize.
    await scrollTranscript(page, false);
    state = await probe();
    while (state.disclosed) state = await probe();
  }
  while (state.delta === undefined) {
    if (state.top >= state.end) {
      throw new Error("Acquired target is unavailable: " + selector);
    }
    await wheelTranscript(page, state.height);
    state = await probe();
    while (state.disclosed) state = await probe();
  }
  await expect.poll(async () => {
    state = await probe();
    while (state.disclosed) state = await probe();
    if (state.delta === undefined) return required ? Infinity : 0;
    const remaining = Math.abs(state.delta);
    // Publication can grow again after the first measurement. Reposition the
    // same acquired identity using reader input, not an explicit reveal pin.
    if (remaining >= 1) await wheelTranscript(page, state.delta);
    return remaining;
  }).toBeLessThan(1).catch((cause) => {
    throw new Error(
      "Measured reveal did not settle: " + JSON.stringify(state),
      { cause },
    );
  });
  return state.delta !== undefined;
}

const v2 = (state: TestState) =>
  state.controller.info!.version.startsWith("2.");

/** A user shell run: V1 renders its bash tool call; V2 a plugin-owned shell
 * record (NT2), whose header carries the command and native state. */
export function shellRun(
  state: TestState,
  status: "running" | "completed",
): string {
  return v2(state)
    ? `[data-native-record="opencode-v2/shell"][data-activity-state=${
      status === "completed" ? "exited" : "running"
    }]`
    : `[data-tool=bash][data-tool-status=${status}]`;
}

/** Only rendered output, never the command header, parameters or Source fold. */
export function shellOutput(
  state: TestState,
  page: Page,
  status: "running" | "completed",
): Locator {
  return page.locator(shellRun(state, status)).locator(
    v2(state)
      ? ".otk-tool-body > .otk-text"
      : ".otk-tool-body > .otk-code-block .otk-tool-output",
  );
}

/** Open a native record's own disclosure the user's way: reveal the record,
 * then use its header toggle (never its nested Source fold). */
export async function openRecord(page: Page, selector: string) {
  await revealAcquired(page, selector);
  const toggle = recordToggle(page.locator(selector).first());
  await openDisclosure(
    page,
    toggle,
    selector + " .otk-tool-state > .otk-tool-toggle",
  );
}

/** Opening a header is not acquisition of its lazily windowed prose body. */
export async function readRecordBody(page: Page, selector: string) {
  await openRecord(page, selector);
  await revealAcquired(page, selector + " .otk-tool-body > .otk-text");
}

/** A record owns its state control; tree labels do not own disclosure. */
export function recordToggle(record: Locator) {
  return record.locator(".otk-tool-state > .otk-tool-toggle").first();
}

/** Plugin-owned compaction boundaries, with each harness's lifecycle wording. */
export function compactionBoundary(state: TestState) {
  // The native record header owns the title; compact/expanded records share it.
  const title = (name: string) =>
    `[data-native-record="${name}"] .otk-tool-state .otk-tool-brief:first-child`;
  return v2(state)
    ? {
      selector: '[data-native-record="opencode-v2/compaction"]',
      records: '[data-native-record="opencode-v2/compaction"]',
      title: title("opencode-v2/compaction"),
      queued: title("opencode-v2/compaction"),
      queuedLabel: "Session compaction queued",
      running: "Session compaction started",
      completed: /^Session compacted(?: by provider)?(?: - .* in - .* out)?$/,
    }
    : {
      selector: '[data-native-record="opencode-v1/compaction-summary"]',
      records:
        '[data-native-record="opencode-v1/compaction"], [data-native-record="opencode-v1/compaction-summary"]',
      title: title("opencode-v1/compaction-summary"),
      // Before its summary exists, a queued compaction is its marker record.
      queued: title("opencode-v1/compaction"),
      queuedLabel: "Session compaction",
      running: "Session compaction",
      completed: "Session compacted",
    };
}

export async function expectCompactionBetween(
  state: TestState,
  page: Page,
  reply: string,
  prompt: string,
) {
  const compaction = compactionBoundary(state);
  const transcript = page.getByRole("region", {
    name: "Transcript",
    exact: true,
  });
  const first = transcript.locator('[data-message][data-role="assistant"]')
    .filter({ hasText: reply });
  const next = transcript.locator('[data-message][data-role="user"]').filter({
    hasText: prompt,
  });
  const record = transcript.locator(compaction.selector);
  await expect(first).toBeVisible();
  await expect(next).toBeVisible();
  await expect(record).toBeVisible();
  await expect(transcript.locator(compaction.records)).toHaveCount(1);
  const [replyNode, promptNode] = await Promise.all([
    first.elementHandle(),
    next.elementHandle(),
  ]);
  expect(
    await record.evaluate((node, { replyNode, promptNode }) => {
      const virtual = "[data-virtual-key]";
      // The native row's internal part windows are not transcript entries.
      const entry = node.closest('[data-message][data-role="context"]');
      const frame = entry?.closest(virtual);
      const first = replyNode.closest(virtual);
      const next = promptNode.closest(virtual);
      const precedes = (a: Element, b: Element) =>
        !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      return {
        interval: !!node.closest("[data-background-interval]"),
        assistant: !!node.closest('[data-message][data-role="assistant"]'),
        topLevel: !!frame && !frame.parentElement?.closest(virtual),
        ordered: !!frame && !!first && !!next && precedes(first, frame) &&
          precedes(frame, next),
      };
    }, { replyNode, promptNode }),
  ).toEqual({
    interval: false,
    assistant: false,
    topLevel: true,
    ordered: true,
  });
}

/** After rolling back every prompt, no prompt or reply remains. Native
 * controls before the first prompt (V2 agent/model selection records) stay
 * visible per decisions 1/20. */
export async function expectNoConversation(state: TestState, page: Page) {
  await expect(
    page.locator(
      "[data-message][data-role=user], [data-message][data-role=assistant]",
    ),
  ).toHaveCount(0);
  if (!v2(state)) {
    await expect(page.locator("[data-message]")).toHaveCount(0);
    return;
  }
  const records = page.locator("[data-message][data-role=context]");
  for (const row of await records.all()) {
    await expect(
      row.locator(
        '[data-native-record="opencode-v2/agent-switched"], [data-native-record="opencode-v2/model-switched"]',
      ),
    ).toHaveCount(1);
  }
}

/** Both plugins keep summary content in the boundary body, opened the user's way. */
export async function expectCompactionSummary(
  state: TestState,
  page: Page,
  text: string,
  timeout?: number,
) {
  const { selector } = compactionBoundary(state);
  const name = /data-native-record="([^"]+)"/.exec(selector)![1];
  let messageID: string | undefined;
  // Select the published source identity, not the first mounted compaction.
  // An earlier summary can stay mounted while the requested one is virtualized.
  await expect.poll(async () => {
    messageID = await page.evaluate(({ name, text }) => {
      const messages = (globalThis as typeof globalThis & {
        transcriptPublication?: Map<string, import("@otk/protocol").Message>;
      }).transcriptPublication;
      return [...messages?.values() ?? []].reverse().find((message) =>
        message.parts.some((part) =>
          part.kind === "external" && part.name === name &&
          (part.source?.payload?.includes(text) ||
            JSON.stringify(part.activity?.body ?? []).includes(text))
        )
      )?.id;
    }, { name, text });
    return messageID;
  }, { timeout }).toBeTruthy();
  const record = `[data-message=${JSON.stringify(messageID)}] ${selector}`;
  await readRecordBody(page, record);
  await expect(page.locator(record)).toContainText(text, { timeout });
}

/** Restored prompts by acquired-message authority, each revealed in the DOM. */
export async function expectRestoredPrompts(
  state: TestState,
  page: Page,
  sessionID: string,
  count: number,
) {
  let ids: string[] = [];
  await expect.poll(async () => {
    const page = await state.product("session.messages", { sessionID }) as {
      items: { id: string; role: string }[];
    };
    ids = page.items.filter((m) => m.role === "user").map((m) => m.id);
    return ids.length;
  }).toBe(count);
  for (const id of ids) {
    await revealAcquired(page, `[data-message="${id}"] .otk-user-bubble`);
  }
}
