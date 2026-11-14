// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { questions, seed, tool } from "../../pages/attention.ts";

test.use({ profile: "contract-attention-native" });
for (const kind of ["question", "permission"] as const) {
  test(`attention.primary-action-${kind}-pending-and-draft`, {
    tag: ["@attention", "@composer", "@isolated"],
  }, async ({ isolatedState: state, page }, info) => {
    const target = await seed(state, "Primary takeover action");
    const frames = await wire(page);
    await openSession(state, page, target.id);
    const input = page.locator("textarea[name=prompt]");
    await input.fill("An unsent draft survives the takeover");
    await tool(
      state,
      kind === "question" ? "question" : "bash",
      kind === "question" ? { questions: [questions[0]] } : {
        command: "printf primary-action",
        description: "Primary permission",
      },
    );
    await state.queue(["Takeover finished"]);
    await state.native(`/session/${target.id}/prompt_async`, "POST", {
      parts: [{ type: "text", text: "Request input" }],
    });
    const dock = page.locator(
      kind === "question" ? ".otk-question-dock" : ".otk-permission-dock",
    );
    const primary = dock.locator("[data-primary-action]");
    await expect(primary).toBeVisible();
    if (kind === "question") {
      await dock.getByRole("button", { name: /Typed/ }).click();
      await primary.click();
      await expect(dock.getByRole("tab", { name: "Confirm" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    }
    const original = await primary.elementHandle();
    frames.hold((frame, request) =>
      (frame.t === "request.result" && request?.method === `${kind}.reply`) ||
      (frame.t === "content" &&
        (frame.event as { op?: string })?.op === `${kind}.remove`)
    );
    await primary.click();
    await expect(primary).toBeVisible();
    await expect(primary).toBeDisabled();
    await expect(primary).toHaveAttribute(
      "aria-description",
      kind === "question" ? "Sending answer" : "Sending response",
    );
    const replies = () =>
      frames.sent.filter(({ frame }) => frame.method === `${kind}.reply`);
    // Pending is visible during preparation; measure after the admitted frame.
    await expect.poll(() => replies().length).toBe(1);
    const before = await primary.evaluate(
      (node, original) => ({
        same: node === original,
        disabled: (node as HTMLButtonElement).disabled,
        focus: document.activeElement?.outerHTML,
      }),
      original,
    );
    await primary.evaluate((node) => (node as HTMLButtonElement).click());
    const afterClick = await primary.evaluate(
      (node, original) => ({
        same: node === original,
        disabled: (node as HTMLButtonElement).disabled,
        focus: document.activeElement?.outerHTML,
      }),
      original,
    );
    await page.keyboard.press("Enter");
    await info.attach("primary-wire", {
      body: JSON.stringify({
        before,
        afterClick,
        afterEnter: await primary.evaluate(
          (node, original) => ({
            same: node === original,
            disabled: (node as HTMLButtonElement).disabled,
            focus: document.activeElement?.outerHTML,
          }),
          original,
        ),
        sent: frames.sent,
        received: frames.received,
        held: frames.held.map(({ frame, request }) => ({ frame, request })),
      }),
      contentType: "application/json",
    });
    // One native request admits one reply, whatever the control's lifetime.
    expect(replies()).toHaveLength(1);
    expect(frames.sent.filter(({ frame }) => frame.method === "session.prompt"))
      .toHaveLength(0);
    expect(before.same).toBe(true);
    expect(afterClick.same).toBe(true);
    frames.release();
    await expect(dock).toHaveCount(0);
    expect(replies()).toHaveLength(1);
    await expect(input).toBeVisible();
    await expect(input).toHaveValue("An unsent draft survives the takeover");
    await expect(page.getByRole("button", { name: "Send", exact: true }))
      .toBeEnabled();
    // The native turn continues after the reply; let it settle before teardown.
    await expect(page.locator(`[data-session="${target.id}"]`))
      .toHaveAttribute("data-status", "idle");
    expect(replies()).toHaveLength(1);
  });
}
