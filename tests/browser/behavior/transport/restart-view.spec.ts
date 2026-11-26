// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { type Frame, openSession, wire } from "../../fixtures/wire.ts";

for (const interruption of ["restart", "disconnect"] as const) {
  test(`transport.latest-view-during-${interruption}`, {
    tag: ["@transport", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    const frames = await wire(page);
    let documents = 0;
    page.on("request", (request) => {
      if (request.resourceType() === "document") documents++;
    });
    const a = await state.native<{ id: string }>("/session", "POST", {
      title: "Back to this session",
      messages: [{ parts: [{ type: "text", text: "Session A transcript" }] }],
    });
    const b = await state.native<{ id: string }>("/session", "POST", {
      title: "Leave this session",
      messages: [{ parts: [{ type: "text", text: "Session B transcript" }] }],
    });
    await openSession(state, page, a.id);
    await openSession(state, page, b.id);

    const identity = (frame: Frame) =>
      frame.sidecar as { build: string; instance: string };
    const previous = identity(frames.received.find((f) => f.t === "welcome")!);
    const sent = frames.sent.length;
    const received = frames.received.length;
    const outgoing = () => frames.sent.slice(sent).map(({ frame }) => frame);
    // Delay the real welcome and all subsequent frames in their original order.
    let holding = false;
    frames.hold((frame) => holding ||= frame.t === "welcome");
    if (interruption === "restart") {
      await state.controller.call("restart", {
        lease: state.lease.lease,
        target: "sidecar",
      });
    } else frames.close();
    await expect.poll(() => holding).toBe(true);
    const current = identity(frames.held[0].frame);
    expect(current.build).toBe(previous.build);
    if (interruption === "restart") {
      expect(current.instance).not.toBe(previous.instance);
    } else expect(current.instance).toBe(previous.instance);
    expect(outgoing().reverse().find((f) => f.t === "hello")?.view)
      .toMatchObject({
        selected: b.id,
      });

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${a.id}$`));
    await expect(page.locator(".otk-session-crumb[aria-current]"))
      .toContainText("Back to this session");
    expect(outgoing().some((f) => f.t === "view" && f.selected === a.id))
      .toBe(false);
    const connection = page.locator(
      ".otk-server-status[data-connection=local]",
    );
    frames.release();
    frames.hold((frame) =>
      frame.t === "view.ready" &&
      outgoing().some((f) =>
        f.t === "view" && f.selected === a.id && f.epoch === frame.epoch
      )
    );
    await expect.poll(() => frames.held.length, {
      message:
        "The server must acknowledge the changed view without another navigation",
    }).toBeGreaterThan(0);
    await expect(connection).toHaveAttribute("title", /: reconnecting;/);
    expect(
      outgoing().some((f) => f.t === "view.settled" && f.sessionID === a.id),
    )
      .toBe(false);
    frames.release();

    await expect.poll(() => {
      const outgoingFrames = outgoing();
      const view = outgoingFrames.slice().reverse().find((f) =>
        f.t === "view" && f.selected === a.id
      );
      return view !== undefined &&
        frames.received.slice(received).some((f) =>
          f.t === "inbox.snapshot" && f.epoch === view.epoch
        ) && outgoingFrames.some((f) =>
          f.t === "view.settled" && f.sessionID === a.id &&
          f.epoch === view.epoch
        );
    }, {
      message:
        "The server must install and settle A without another navigation",
    })
      .toBe(true);
    await expect(connection).toHaveAttribute("title", /: connected;/);
    await expect(page.getByRole("region", { name: "Transcript", exact: true }))
      .toContainText("Session A transcript");
    expect(documents).toBe(1);
  });
}
