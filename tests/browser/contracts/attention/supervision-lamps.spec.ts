// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";

test.use({ profile: "isolated" });
test(
  "attention.supervision-positive-evidence-and-otk-acknowledgement-survive-restart",
  { tag: ["@attention", "@sessions"] },
  async ({ isolatedState: state, page }) => {
    const selected = await state.native<{ id: string }>("/session", "POST", {
      title: "Supervision selected",
    });
    const background = await state.controller.call<
      { id: string; nativeID: string; directory: string }
    >("nativeRequest", {
      lease: state.lease.lease,
      path: "/session",
      method: "POST",
      project: "secondary",
      body: { title: "Supervision background" },
    });
    await openSession(state, page, selected.id);
    const row = page.locator(
      `[data-project=${JSON.stringify(background.directory)}]`,
    );
    await expect(
      row.getByRole("img", { name: "No known activity", exact: true }),
    ).toBeVisible();
    const held = await state.queue(["Proven supervision completion"], "held");
    await state.controller.call("nativeRequest", {
      lease: state.lease.lease,
      path: `/session/${background.nativeID}/prompt_async`,
      method: "POST",
      project: "secondary",
      body: {
        model: { providerID: "fake", modelID: "scripted" },
        parts: [{ type: "text", text: "Complete in the background" }],
      },
    });
    await expect(row.getByRole("img", { name: "Working", exact: true }))
      .toBeVisible();
    await state.release(held.gate);
    await expect(
      row.getByRole("img", { name: "Finished, not seen", exact: true }),
    ).toBeVisible();
    await state.controller.call("restart", {
      lease: state.lease.lease,
      target: "sidecar",
    });
    await page.reload();
    await expect(
      row.getByRole("img", { name: "Finished, not seen", exact: true }),
    ).toBeVisible();
    await state.product("layout.patch", {
      leftCollapsed: true,
      rightCollapsed: true,
      discoveredCollapsed: true,
    });
    await page.reload();
    await expect(
      row.getByRole("img", { name: "Finished, not seen", exact: true }),
    ).toBeVisible();
    // Only opening this conversation acknowledges its displayed terminal.
    await openSession(state, page, background.id);
    await openSession(state, page, selected.id);
    await state.product("layout.patch", { discoveredCollapsed: false });
    await expect(
      row.getByRole("img", { name: "No known activity", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      row.getByRole("img", { name: "No known activity", exact: true }),
    ).toBeVisible();
    const lamps = await page.locator(".otk-project-marker").evaluateAll((
      markers,
    ) =>
      markers.map((marker) => marker.querySelectorAll('[role="img"]').length)
    );
    expect(lamps.length).toBeGreaterThan(0);
    expect(lamps.every((count) => count === 1)).toBe(true);
  },
);
