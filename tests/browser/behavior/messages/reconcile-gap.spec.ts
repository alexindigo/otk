// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { type Frame, openSession, wire } from "../../fixtures/wire.ts";
import {
  revealAcquired,
  scrollTranscript,
  toolScript,
  wheelTranscript,
} from "../../pages/transcript.ts";

test.use({ profile: "messages-tools" });

for (const witness of ["visible", "load", "failed"] as const) {
  test(`messages.reconcile-gap-${witness}`, {
    tag: ["@messages", "@isolated"],
  }, async ({ isolatedState: state, page }, info) => {
    test.setTimeout(120_000);
    const seeds = Array.from({ length: 12 }, (_, i) => `Earlier prompt ${i}`);
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Transcript recovery gap",
      messages: seeds.map((text) => ({ parts: [{ type: "text", text }] })),
    });
    type NativeMessage = {
      info: {
        id: string;
        role: string;
        finish?: string;
        time: { completed?: number };
      };
      parts: { text?: string }[];
    };
    const messages = () =>
      state.native<NativeMessage[]>(`/session/${session.id}/message`);
    const send = async (prompt: string, reply: string) => {
      await state.native(`/session/${session.id}/prompt_async`, "POST", {
        agent: "build",
        model: { providerID: "fake", modelID: "scripted" },
        parts: [{ type: "text", text: prompt }],
      });
      await expect.poll(
        async () =>
          (await messages()).some(({ info, parts }) =>
            info.role === "assistant" && info.finish === "stop" &&
            !!info.time.completed && parts.some(({ text }) => text === reply)
          ),
        { timeout: 30_000, intervals: [50, 100, 250] },
      ).toBe(true);
    };
    const anchorPrompt = "Check the current build";
    const anchorReply = "The build passed. The earlier records are still here.";
    await toolScript(state, "bash", {
      command: "true",
      description: "Check the build",
    }, anchorReply);
    await send(anchorPrompt, anchorReply);
    const anchored = (await messages()).find(({ parts }) =>
      parts.some(({ text }) =>
        text === anchorPrompt
      )
    )!.info.id;
    const expected = [...seeds, anchorPrompt, anchorReply];
    const socket = await wire(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSession(state, page, session.id);
    const pane = page.locator(".otk-messages");
    const turn = `[data-virtual-key="reply:${anchored}"]`;
    const fold = page.locator(`${turn} .otk-work-fold`);
    const fetchOlder = page.getByRole("button", {
      name: "Load older messages",
      exact: true,
    });
    const acquiredCount = page.locator(".otk-message-flow");
    await expect.poll(async () => {
      if (
        Number(await acquiredCount.getAttribute("data-message-count")) >=
          expected.length
      ) return true;
      if (await fetchOlder.isVisible()) {
        await fetchOlder.click({ timeout: 2500 });
      }
      return false;
    }, { timeout: 15_000 }).toBe(true);
    await revealAcquired(page, `${turn} .otk-work-fold`);
    await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await scrollTranscript(page, true);
    await wheelTranscript(page, -8, fold);

    const sample = (save = false) =>
      pane.evaluate(async (pane, { turn, anchorReply, save }) => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        );
        const bounds = pane.getBoundingClientRect();
        const row =
          Array.from(pane.querySelectorAll<HTMLElement>("[data-virtual-key]"))
            .filter((el) => {
              const rect = el.getBoundingClientRect();
              return !el.dataset.virtualKey!.startsWith("gap:") &&
                rect.bottom > bounds.top && rect.top < bounds.bottom;
            }).sort((a, b) =>
              a.getBoundingClientRect().top - b.getBoundingClientRect().top
            )[0];
        const text = Array.from(pane.querySelectorAll(`${turn} .otk-text`))
          .find((
            el,
          ) => el.textContent === anchorReply)?.firstChild;
        const fold = pane.querySelector(`${turn} .otk-work-fold`);
        const memory = globalThis as typeof globalThis & {
          gapWitness?: { text: Node; fold: Element };
        };
        if (save && text && fold) memory.gapWitness = { text, fold };
        return {
          key: row?.dataset.virtualKey,
          offset: row ? row.getBoundingClientRect().top - bounds.top : null,
          sameNodes: !!text?.isConnected && !!fold?.isConnected &&
            text === memory.gapWitness?.text &&
            fold === memory.gapWitness?.fold,
          expanded: fold?.getAttribute("aria-expanded"),
        };
      }, { turn, anchorReply, save });
    let before = await sample(true);
    expect(before).toMatchObject({ sameNodes: true, expanded: "true" });
    expect(before.key).toBeDefined();
    const stable = async () => {
      const after = await sample();
      expect(after).toMatchObject({
        key: before.key,
        sameNodes: true,
        expanded: "true",
      });
      expect(Math.abs(after.offset! - before.offset!)).toBeLessThanOrEqual(1);
    };

    const policy = socket.received.find(({ t }) => t === "welcome")!
      .messages as { bridgepages: number };
    const turns = (policy.bridgepages + 1) * 10 / 2 + 3;
    const olderFrame = (frame: Frame, request?: Frame) => {
      const key = frame.ref?.key ??
        (frame.request as { key?: string } | undefined)?.key;
      const call = request ?? socket.sent.find(({ frame }) =>
        key !== undefined && frame.ref?.key === key
      )?.frame;
      return call?.method === "session.messages" && !!call.params?.before;
    };
    let welcome = false;
    socket.hold((frame) => welcome ||= frame.t === "welcome");
    socket.close();
    await expect.poll(() => welcome).toBe(true);
    for (let i = 0; i < turns; i++) {
      const prompt = `New prompt ${i + 1}`;
      const reply = `New reply ${i + 1}`;
      await state.queue([reply]);
      await send(prompt, reply);
      expected.push(prompt, reply);
    }
    socket.release();
    socket.hold(olderFrame);
    await expect.poll(() => socket.held.length).toBeGreaterThan(0);

    const gap = pane.locator(".otk-transcript-gap");
    await stable();
    // At zero overscan the gap can start just below the last retained row.
    // Move it into view by trusted input only after checking reconnect did not
    // move the reader. Keep both neighbouring ranges in view for later checks.
    await wheelTranscript(page, 150, fold);
    before = await sample(true);
    const action = (name: string) =>
      gap.getByRole("button", { name, exact: true });
    const loading = () => expect(gap).toHaveText("Loading earlier messages...");
    const measure = async () => {
      const result = await gap.evaluate((row) => {
        const center = (element: Element) => {
          const box = element.getBoundingClientRect();
          return (box.top + box.bottom) / 2;
        };
        const rule = row.querySelector(".otk-transcript-gap-rule")!;
        const label = row.querySelector(".otk-chrome-meta")!;
        const icon = row.querySelector("svg")!;
        const rowKey = row.closest("[data-virtual-key]")!;
        return {
          height: row.getBoundingClientRect().height,
          laneHeight: rowKey.getBoundingClientRect().height,
          centerDelta: Math.max(
            ...[rule, icon, label].map((el) =>
              Math.abs(center(el) - center(row))
            ),
          ),
          nowrap: getComputedStyle(label).whiteSpace,
          dots: icon.querySelectorAll("circle").length,
          ruleStyle: getComputedStyle(rule).borderBlockStartStyle,
        };
      });
      expect(result).toMatchObject({
        nowrap: "nowrap",
        dots: 3,
        ruleStyle: "dotted",
      });
      expect(result.centerDelta).toBeLessThanOrEqual(1);
      return [result.height, result.laneHeight];
    };
    const padding = async (name: string) => {
      const [left, right, inset, top, bottom] = await action(name).evaluate(
        (button) => {
          const range = document.createRange();
          range.selectNodeContents(button);
          const text = range.getBoundingClientRect(),
            box = button.getBoundingClientRect();
          return [
            text.left - box.left,
            box.right - text.right,
            parseFloat(getComputedStyle(button).paddingInlineStart),
            text.top - box.top,
            box.bottom - text.bottom,
          ];
        },
      );
      expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
      expect(Math.min(left, right)).toBeGreaterThanOrEqual(inset - 1);
      expect(Math.min(top, bottom)).toBeGreaterThan(0);
    };
    const shots = async (name: string) => {
      const dir = process.env.OTK_GAP_SCREENSHOTS;
      if (!dir) return;
      for (
        const [theme, value] of [
          ["dark", "otk-dark"],
          ["linen", "otk-light"],
          ["stone", "otk-light-stone"],
        ]
      ) {
        await state.product("prefs.set", { key: "theme", value });
        await expect(page.locator("html")).toHaveAttribute(
          "data-otk-theme",
          value,
        );
        await page.screenshot({
          path: `${dir}/${name}-${theme}.png`,
          animations: "disabled",
        });
      }
    };
    await loading();
    await expect(gap).toHaveCount(1);
    await expect(gap).toBeInViewport();
    await expect(gap).toHaveAttribute("role", "status");
    await expect(gap).toHaveAttribute("aria-busy", "true");
    await expect(gap.getByRole("button")).toHaveCount(0);
    await stable();
    const height = await measure();
    if (witness === "visible") await shots("loading");
    socket.release();
    await expect(gap.getByText("Earlier messages not loaded", { exact: true }))
      .toBeVisible();
    await expect(action("Load")).toHaveAttribute(
      "title",
      "Load earlier messages",
    );
    expect(await measure()).toEqual(height);
    await padding("Load");
    await stable();
    if (witness === "visible") {
      await shots("idle");
      return;
    }

    const loadBatch = async (name: string) => {
      const count = async () =>
        Number(await acquiredCount.getAttribute("data-message-count"));
      const acquired = await count();
      await action(name).click();
      await expect.poll(count).toBeGreaterThan(acquired);
      await expect.poll(async () =>
        await gap.count() ? await gap.getAttribute("aria-busy") : null
      ).not.toBe("true");
    };
    if (witness === "failed") {
      const sentBeforeLoad = socket.sent.length;
      const nextRead = () =>
        socket.sent.slice(sentBeforeLoad).find(({ frame }) =>
          frame.method === "session.messages" && !!frame.params?.before
        )?.frame;
      socket.hold((frame, request) =>
        (frame.t === "load.chunk" || frame.t === "request.result") &&
        !!nextRead() &&
        (frame.ref?.key ??
            (frame.request as { key?: string } | undefined)?.key ??
            request?.ref?.key) === nextRead()?.ref?.key
      );
      await action("Load").click();
      await loading();
      await expect.poll(() =>
        socket.held.some(({ frame }) => frame.t === "request.result")
      ).toBe(true);
      // A socket cut alone queues/replays read custody on reconnect. Deliver a
      // terminal result before the body, preserving accepted/progress sequence.
      const result = socket.held.find(({ frame }) =>
        frame.t === "request.result"
      )!.frame;
      socket.held.splice(0);
      socket.release();
      socket.fault({
        ...result,
        outcome: {
          ok: false,
          error: {
            code: "transport.disconnected",
            retry: "new-intent",
            diagnosticID: "gap-bridge-test",
          },
        },
      });
      await expect(
        gap.getByText("Couldn't load earlier messages", { exact: true }),
      ).toBeVisible();
      await expect(gap.locator(".otk-failure-signal.is-gutter")).toHaveCount(1);
      await expect(action("Retry")).toHaveAttribute(
        "title",
        "Retry loading earlier messages",
      );
      expect(await measure()).toEqual(height);
      await padding("Retry");
      await stable();
      await action("Retry").hover();
      await padding("Retry");
      await shots("failed");
      await loadBatch("Retry");
    } else await loadBatch("Load");
    // The native transcript can include non-conversational context records.
    // Each batch is bounded by pages, not turns; another Load can be necessary.
    for (let batch = 0; batch < turns && await gap.count(); batch++) {
      await loadBatch("Load");
    }
    await expect(gap).toHaveCount(0);
    await stable();
    if (witness === "load") await shots("bridged");
    // Native selection uses the shared VirtualList's complete acquired range.
    await fold.focus();
    await page.keyboard.press("ControlOrMeta+a");
    await expect.poll(() =>
      page.evaluate(() => {
        const lines = document.getSelection()?.toString().split("\n") ?? [];
        return lines.map((line) => line.trim()).filter((line) =>
          /^(Earlier prompt|New (prompt|reply)) \d+$/.test(line) ||
          line === "Check the current build" ||
          line === "The build passed. The earlier records are still here."
        );
      })
    ).toEqual(expected);
    await info.attach("gap-anchor", {
      body: JSON.stringify({ before, after: await sample(), height }),
      contentType: "application/json",
    });
  });
}
