// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({ profile: "provider-hold" });
for (const kind of ["held", "stepped"] as const) {
  test(`harness.provider-${kind}-inactivity`, {
    tag: ["@harness", "@isolated", "@duration"],
  }, async ({ isolatedState: state, page }, info) => {
    expect((await state.observe<{ chunkTimeout: number }>()).chunkTimeout).toBe(
      2000,
    );
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Consumer-owned stream",
    });
    await page.goto(state.url);
    await page.locator(
      `[data-project=${JSON.stringify(state.directory)}] .otk-project-open`,
    ).click();
    await expect(page).toHaveURL(new RegExp(`${session.id}$`));
    const gate = await state.queue(
      kind === "held" ? ["Held output"] : ["Held output", " Released"],
      kind,
    );
    if (kind === "stepped") await state.release(gate.gate);
    const prompt = "Wait for the fixture consumer";
    const composer = page.locator("textarea[name=prompt]");
    await composer.fill(prompt);
    await composer.press("Enter");
    const output = page.locator("[data-role=assistant] .otk-text");
    const tab = page.getByRole("tablist", { name: "Tasks and active sessions" })
      .getByRole("tab", { selected: true });
    await expect(output).toHaveText("Held output");
    await expect(tab).toHaveAttribute("data-status", "busy");
    const start = performance.now();
    // A real elapsed native-inactivity contract, not a readiness delay or browser clock.
    await expect.poll(() => performance.now() - start, { timeout: 10000 })
      .toBeGreaterThanOrEqual(6500);
    const calls = (await state.observe<{ requests: unknown[] }>()).requests
      .filter((request) => {
        const body = JSON.stringify(request);
        return body.includes(prompt) &&
          !body.includes("Generate a title for this conversation:");
      });
    expect(calls).toHaveLength(1);
    await expect(tab).toHaveAttribute("data-status", "busy");
    await expect(output).toHaveText("Held output");
    await state.release(gate.gate);
    await expect(output).toHaveText(
      kind === "held" ? "Held output" : "Held output Released",
    );
    await expect(tab).toHaveAttribute("data-status", "idle");
    const final = (await state.observe<{ requests: unknown[] }>()).requests
      .filter((request) => {
        const body = JSON.stringify(request);
        return body.includes(prompt) &&
          !body.includes("Generate a title for this conversation:");
      });
    expect(final).toHaveLength(1);
    await info.attach("native-inactivity", {
      body: JSON.stringify({
        chunkTimeout: 2000,
        heldMilliseconds: performance.now() - start,
        calls: final.length,
      }),
      contentType: "application/json",
    });
  });
}
