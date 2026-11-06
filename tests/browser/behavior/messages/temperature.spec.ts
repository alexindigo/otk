// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import type { MessagePolicy } from "@otk/protocol";
test.use({ profile: "messages-temperature" });
test(
  "messages.warm-cold-selected-demand-drafts",
  { tag: ["@messages"] },
  async ({ isolatedState: state, page }, info) => {
    // The retention owner is createTranscripts' browser Date/setTimeout clock.
    // Install before navigation; native/provider deadlines remain on real time.
    const epoch = new Date("2000-01-01T00:00:00Z");
    await page.clock.install({ time: epoch });
    // Establish paused time before constructing any app/transport timers. A
    // later large jump would also expire the connection's silence watchdog.
    await page.clock.pauseAt(new Date(epoch.getTime() + 1000));
    const tick = async <T>(run: () => Promise<T>): Promise<T> => {
      let done = false, result: T | undefined, failure: unknown;
      const task = run().then((value) => {
        result = value;
      }, (error) => {
        failure = error;
      }).finally(() => {
        done = true;
      });
      await expect.poll(async () => {
        await page.clock.runFor(32);
        return done;
      }).toBe(true);
      await task;
      if (failure) throw failure;
      return result!;
    };
    const open = (id: string) => tick(() => openSession(state, page, id));
    const held = await state.queue(
      ["The cold scope is current again."],
      "held",
    );
    const a = await state.native<{ id: string }>("/session", "POST", {
      title: "Temperature project A",
    });
    const b = await state.controller.call<{ id: string }>("nativeRequest", {
      lease: state.lease.lease,
      path: "/session",
      method: "POST",
      project: "secondary",
      body: { title: "Temperature project B" },
    });
    for (
      const [session, project, label] of [[a, undefined, "Alpha"], [
        b,
        "secondary",
        "Beta",
      ]] as const
    ) {
      for (let i = 0; i < 25; i++) {
        await state.controller.call("nativeRequest", {
          lease: state.lease.lease,
          path: `/session/${session.id}/message`,
          method: "POST",
          project,
          body: {
            noReply: true,
            parts: [{ type: "text", text: `${label} prompt ${i}` }],
          },
        });
      }
    }
    const capture = await wire(page);
    // With the browser clock paused, readiness joins must advance its render
    // frames too. Each observation advances one bounded frame pair; real I/O
    // is still admitted/settled by the controller and genuine wire results.
    const paint = async (text: string) => {
      await expect.poll(async () => {
        await page.clock.runFor(32);
        return await page.locator(".otk-message-flow").textContent();
      }).toContain(text);
    };
    const pages = (id: string) =>
      capture.sent.filter(({ frame }) =>
        frame.method === "session.messages" && frame.params?.sessionID === id
      );
    const settled = (id: string, since = 0) => {
      // Released reads have no successful result. Correlate the new lifetime's
      // responses by request identity rather than comparing unlike totals.
      const keys = new Set(
        pages(id).slice(since).map(({ frame }) => frame.ref!.key),
      );
      return capture.received.filter((frame) =>
        frame.t === "request.result" && keys.has(frame.ref?.key ?? "") &&
        (frame.outcome as { ok: boolean; result?: { items?: unknown[] } })
          ?.ok &&
        (frame.outcome as { result?: { items?: unknown[] } })?.result?.items
      );
    };
    await page.setViewportSize({ width: 1280, height: 900 });
    // Warm both real scope owners before measuring a warm return. A first-ever
    // B acquisition is independent work and must not consume A's cooling window.
    await open(b.id);
    await open(a.id);
    await tick(() =>
      expect.poll(() => settled(a.id).length).toBeGreaterThanOrEqual(2)
    );
    await page.locator("textarea[name=prompt]").fill(
      "Unsent temperature draft",
    );
    // Source admission precedes viewport/follow settlement. Borrow the known
    // newest source only once it is visibly rendered with installed fonts, not
    // an incidental row from an intermediate virtual range.
    await tick(() =>
      page.evaluate(() => document.fonts.ready.then(() => true))
    );
    const borrowed = "Alpha prompt 24";
    await tick(() =>
      expect.poll(() =>
        page.locator(".otk-message-flow p").evaluateAll((rows) => {
          const v = document.querySelector(".otk-messages")!
            .getBoundingClientRect();
          return rows.filter((e) => {
            const r = e.getBoundingClientRect();
            return r.bottom > v.top && r.top < v.bottom;
          }).map((e) => e.textContent);
        })
      ).toContain(borrowed)
    );
    const policy = capture.received.find((frame) => frame.t === "welcome")!
      .messages as MessagePolicy;
    expect(policy.coolms).toBeGreaterThan(0);
    expect(policy.preloadms).toBeGreaterThan(0);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator(`[data-project-sessions~="${b.id}"] .otk-project-open`)
      .click();
    await page.locator(`[data-session="${b.id}"]`).click();
    await page.clock.runFor(32);
    await expect(page).toHaveURL(new RegExp(b.id + "$"));
    await paint("Beta prompt 24");
    capture.hold((frame, request) =>
      frame.t === "request.result" && request?.method === "session.messages" &&
      request.params?.sessionID === a.id
    );
    const start = performance.now();
    // Warm source is the intended readiness while new page results stay held.
    await page.locator(`[data-project-sessions~="${a.id}"] .otk-project-open`)
      .click();
    await page.locator(`[data-session="${a.id}"]`).click();
    await page.clock.runFor(32);
    await expect(page).toHaveURL(new RegExp(a.id + "$"));
    await expect(page.locator("textarea[name=prompt]")).toHaveValue(
      "Unsent temperature draft",
    );
    await paint(borrowed);
    await info.attach("warm-retained-source-ms", {
      body: JSON.stringify({
        ms: performance.now() - start,
        heldNewPages: true,
      }),
      contentType: "application/json",
    });
    capture.release();
    await open(b.id);
    await page.clock.fastForward(policy.coolms + 1);
    await expect.poll(() =>
      capture.sent.some(({ frame }) =>
        frame.t === "unsubscribe" && frame.sessionID === a.id
      )
    ).toBe(true);
    await expect(page.locator(".otk-message-flow")).not.toContainText(
      "Alpha prompt",
    );
    const before = pages(a.id).length;
    await state.native(`/session/${a.id}/prompt_async`, "POST", {
      parts: [{ type: "text", text: "Wake the cold project" }],
    });
    await tick(() =>
      expect(page.locator(`[data-project="${state.directory}"]`))
        .toHaveAttribute("data-rollup", "working")
    );
    const initialReads = () =>
        pages(a.id).filter(({ frame }) => !frame.params?.before).length,
      initialBeforeClick = initialReads();
    expect(pages(a.id).length).toBe(before);
    expect(page.url().endsWith(a.id)).toBe(false);
    await page.getByRole("button", { name: "Collapse projects", exact: true })
      .click();
    await page.getByRole("button", {
      name: "Collapse right panel",
      exact: true,
    }).click();
    await expect(page.locator(`.otk-project-inbox`)).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    await expect(page.locator(".otk-right-panel")).toBeHidden();
    await expect(page.locator(`[data-project="${state.directory}"]`))
      .toHaveAttribute("data-rollup", "working");
    await page.getByRole("button", { name: "Expand projects", exact: true })
      .click();
    await open(a.id);
    await page.clock.runFor(32);
    await expect(page.locator("textarea[name=prompt]")).toHaveValue(
      "Unsent temperature draft",
    );
    await paint("Wake the cold project");
    expect(initialReads()).toBe(initialBeforeClick + 1);
    // Finish metadata updates lamps while cold, without acquiring another body.
    await open(b.id);
    await page.clock.fastForward(policy.coolms + 1);
    const expiredSubscriptions =
      capture.sent.filter(({ frame }) =>
        frame.t === "unsubscribe" && frame.sessionID === a.id
      ).length;
    const beforeFinish = pages(a.id).length;
    await state.release(held.gate);
    await tick(() =>
      expect(page.locator(`[data-project="${state.directory}"]`))
        .toHaveAttribute("data-rollup", "finished")
    );
    expect(pages(a.id).length).toBe(beforeFinish);
    const finishedInitial = initialReads();
    await page.clock.fastForward(policy.preloadms + 1);
    await expect.poll(() =>
      capture.sent.filter(({ frame }) =>
        frame.t === "unsubscribe" && frame.sessionID === a.id
      ).length
    ).toBe(expiredSubscriptions);
    await open(a.id);
    expect(initialReads()).toBe(finishedInitial + 1);
    // Both retention deadlines are now observed. Resume normal animation frames
    // so the reacquired measured viewport can install its visible final tail.
    await page.clock.resume();
    await expect(page.locator(".otk-message-flow")).toContainText(
      "The cold scope is current again.",
    );
    await expect(page.locator(`[data-session="${a.id}"]`)).toHaveAttribute(
      "data-status",
      "idle",
    );
  },
);
