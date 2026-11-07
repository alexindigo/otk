// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";

test(
  "messages.programmatic-reveal-real-click",
  { tag: ["@messages"] },
  async ({ state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Reveal without follow feedback",
    });
    await openSession(state, page, session.id);
    for (const name of ["First reveal", "Second reveal"]) {
      await state.controller.call("queueScript", {
        lease: state.lease.lease,
        chunks: [],
        tool: {
          name: "task",
          input: { subagent_type: "general", description: name, prompt: name },
        },
      });
      await state.queue([name + " child done."]);
      await state.queue([name + " parent done."]);
      await prompt(page, name);
      await expect(page.locator(`[data-session="${session.id}"]`))
        .toHaveAttribute("data-status", "idle");
      await expect(
        page.locator("[data-tool=task][data-tool-status=completed]").filter({
          hasText: name,
        }),
      ).toHaveCount(1);
    }
    const children = await state.product("session.children", {
      sessionID: session.id,
    });
    const first = children.items.find((child) =>
      child.title.includes("First reveal")
    )!;
    expect(first).toBeTruthy();
    await page.locator("[data-panel-view=timeline]").click();
    await page.locator('.otk-timeline-reveal[title="First reveal"]').click();
    await expect(page.locator(".otk-user-bubble:focus")).toHaveCount(1);
    const action = page.locator("[data-tool=task]").filter({
      has: page.locator(".otk-tool-brief", { hasText: /^First reveal$/ }),
    }).locator(".otk-task-card");
    await expect(action).toBeAttached();
    const point = await action.evaluate(async (element) => {
      const pane = document.querySelector(".otk-messages")!,
        before = pane.scrollTop;
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      );
      const r = element.getBoundingClientRect(),
        p = pane.getBoundingClientRect();
      return {
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
        before,
        after: pane.scrollTop,
        inView: r.y + r.height / 2 > p.y && r.y + r.height / 2 < p.bottom,
      };
    });
    expect(
      point.inView && Math.abs(point.before - point.after) <= .5,
      JSON.stringify(point),
    ).toBe(true);
    // Retain the exact measured hit point; actionability scrolling would conceal
    // movement between the viewport owner's reveal and the actual gesture.
    await page.mouse.click(point.x, point.y);
    await expect(page).toHaveURL(
      `${state.url}/#/local/${session.id}/${first.id}`,
    );
    await expect(page.locator(".otk-subagent-bar")).toContainText(
      "First reveal",
    );
    await expect(page.locator(".otk-prompt")).toHaveCount(0);
  },
);

test("messages.busy-worker-plaintext-release", {
  tag: ["@messages", "@contracts"],
}, async ({ state, page, context }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Rendering capability lifetime",
  });
  await openSession(state, page, session.id);
  const reply = await state.controller.call<{ gate: string }>("queueScript", {
    lease: state.lease.lease,
    chunks: ["Plain activity ", "continues ", "without code ", "and finishes."],
    delay: 400,
    gate: "held",
  });
  const cdp = await context.newCDPSession(page);
  await prompt(page, "Observe a real plaintext reply");
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "busy",
  );
  await expect.poll(async () =>
    ((await cdp.send("Target.getTargets")).targetInfos as { type: string }[])
      .some((target) => target.type === "worker")
  ).toBe(true);
  await expect(page.locator(".otk-code,.otk-token")).toHaveCount(0);
  await state.release(reply.gate);
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await expect(page.locator(".otk-messages")).toContainText(
    "Plain activity continues without code and finishes.",
  );
  await expect.poll(async () =>
    ((await cdp.send("Target.getTargets")).targetInfos as { type: string }[])
      .some((target) => target.type === "worker")
  ).toBe(false);
  await expect(page.locator(".otk-code,.otk-token")).toHaveCount(0);
  await cdp.detach();
});
