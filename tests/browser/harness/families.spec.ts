// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../fixtures/evidence.ts";
import { openSession } from "../fixtures/wire.ts";
import { openWorkLogs } from "../pages/transcript.ts";

test.describe("fixture family retirement", {
  tag: ["@fixture-acceptance", "@harness"],
}, () => {
  test.describe.configure({ mode: "default" });
  let prior: { unit: string; directory: string; nativeIDs: string[] };

  test("retires a parent and real helper children", async ({ state, page }) => {
    const parent = await state.native<{ id: string; nativeID: string }>(
      "/session",
      "POST",
      { title: "Owned family" },
    );
    await openSession(state, page, parent.id);
    for (const name of ["First owned helper", "Second owned helper"]) {
      await state.controller.call("queueScript", {
        lease: state.lease.lease,
        chunks: [],
        tool: {
          name: "task",
          input: {
            subagent_type: "general",
            description: name,
            prompt: name,
          },
        },
      });
      await state.queue([name + " completed."]);
      await state.queue([name + " parent completed."]);
      const input = page.locator("textarea[name=prompt]");
      await input.fill(name);
      await input.press("Enter");
      await expect(page.locator("[data-role=assistant] .otk-text").last())
        .toHaveText(name + " parent completed.");
      await openWorkLogs(page);
      await expect(
        page.locator("[data-tool=task][data-tool-status=completed]").filter({
          hasText: name,
        }),
      ).toHaveCount(1);
      await expect(page.locator(`[data-session="${parent.id}"]`))
        .toHaveAttribute("data-status", "idle");
    }
    const children = await state.native<{ id: string }[]>(
      `/session/${parent.id}/children`,
    );
    expect(children).toHaveLength(2);
    prior = {
      unit: state.controller.unit,
      directory: state.directory,
      nativeIDs: [parent.nativeID, ...children.map((child) => child.id)],
    };
    // Leave all three native sessions to the fixture owner. Explicitly deleting
    // them in the body would bypass the between-test retirement contract.
  });

  test("next lease on the same worker has no family or provider leak", async ({ state, page }) => {
    expect(prior).toBeDefined();
    expect(state.controller.unit).toBe(prior.unit);
    expect(state.directory).not.toBe(prior.directory);
    for (const nativeID of prior.nativeIDs) {
      await expect(state.native(`/session/${nativeID}`)).rejects.toThrow(
        /^404:/,
      );
    }
    expect(await state.native<unknown[]>("/session")).toEqual([]);
    expect(await state.observe()).toMatchObject({
      active: 0,
      pending: 0,
      requests: [],
    });
    expect(await state.product("tasks.list", { directory: state.directory }))
      .toEqual([]);
    expect(await state.product("prefs.get", {})).toEqual(state.lease.baseline);
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Clean next lease",
    });
    await state.queue(["Clean family observer reply."]);
    await openSession(state, page, session.id);
    await page.locator("textarea[name=prompt]").fill("Clean family observer");
    await page.locator("textarea[name=prompt]").press("Enter");
    await expect(page.locator("[data-role=assistant] .otk-text")).toHaveText(
      "Clean family observer reply.",
    );
    await expect(page.locator(`[data-session="${session.id}"]`))
      .toHaveAttribute("data-status", "idle");
  });
});
