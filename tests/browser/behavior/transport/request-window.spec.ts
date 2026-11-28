// SPDX-License-Identifier: LGPL-3.0-only
import { send } from "../../pages/primary-action.ts";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { prompt, reply } from "../../pages/composer.ts";

test.use({ profile: "isolated" });
test(
  "composer.pending-read-restarts-with-fresh-window-before-send-without-tab-reload",
  {
    tag: ["@composer", "@messages", "@transport", "@isolated"],
  },
  async ({ isolatedState: state, page }, info) => {
    test.setTimeout(90_000);
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Read window across deployment",
    });
    const frames = await wire(page);
    let navigations = 0;
    page.on("framenavigated", () => navigations++);
    await openSession(state, page, session.id);
    await state.queue(["The first prompt establishes a durable window."]);
    await prompt(page).fill("First prompt before deployment");
    await send(page).click();
    await reply(
      state,
      page,
      session.id,
      "The first prompt establishes a durable window.",
    );
    const oldWindow =
      (frames.sent.find(({ frame }) => frame.method === "session.prompt")!.frame
        .ref as unknown as { window: string }).window;
    frames.hold((frame, request) =>
      frame.t === "request.result" && request?.method === "session.get"
    );
    await state.queue(["The captured send survives the restarted read."]);
    await prompt(page).fill(
      "Retained draft while a pre-send read crosses deployment",
    );
    await send(page).click();
    await expect.poll(() =>
      frames.held.filter(({ request }) => request?.method === "session.get")
        .length
    ).toBeGreaterThan(0);
    const before = navigations;
    // The old socket's undelivered reply is lost, as on a real process restart.
    frames.held.splice(0);
    frames.hold(() => false);
    try {
      await state.controller.call("restart", {
        lease: state.lease.lease,
        target: "sidecar",
      });
      await expect.poll(() =>
        frames.received.filter((frame) => frame.t === "welcome").length
      ).toBeGreaterThanOrEqual(2);
      await expect(prompt(page)).toHaveValue("");
      await reply(
        state,
        page,
        session.id,
        "The captured send survives the restarted read.",
      );
      await expect(
        page.getByText("The captured send survives the restarted read.", {
          exact: true,
        }),
      ).toBeInViewport();
      const fresh = frames.received.filter((frame) => frame.t === "welcome").at(
        -1,
      )!.requests as { window: { id: string } };
      expect(fresh.window.id).not.toBe(oldWindow);
      const requests = frames.sent.filter(({ frame }) =>
        frame.method === "session.prompt"
      );
      expect(requests).toHaveLength(2);
      expect(
        (requests.at(-1)!.frame.ref as unknown as { window: string }).window,
      ).toBe(
        fresh.window.id,
      );
      await state.queue(["External content after deployment remains live."]);
      await state.native(`/session/${session.id}/prompt_async`, "POST", {
        parts: [{ type: "text", text: "External prompt after deployment" }],
      });
      await reply(
        state,
        page,
        session.id,
        "External content after deployment remains live.",
      );
      expect(navigations).toBe(before);
    } finally {
      await info.attach("restart-request-boundaries", {
        body: JSON.stringify({
          sent: frames.sent.map(({ frame }) => ({
            t: frame.t,
            method: frame.method,
            ref: frame.ref,
          })),
          received: frames.received.filter((frame) =>
            ["welcome", "request.rejected"].includes(frame.t)
          ).map((frame) => ({
            t: frame.t,
            ref: frame.ref,
            error: frame.error,
            requests: frame.requests,
          })),
        }),
        contentType: "application/json",
      });
    }
  },
);
