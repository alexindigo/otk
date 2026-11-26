// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";

test.use({ profile: "contract-sessions-hierarchy" });

test("sessions.clear-attention-reviews-a-subtree-and-keeps-live-input", {
  tag: ["@sessions", "@attention", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let reject = true;
  const transport = await wire(
    page,
    (frame) =>
      reject && frame.method === "sessions.acknowledge"
        ? { ...frame, params: { scope: "subtree", sessionID: "tstv1-missing" } }
        : frame,
  );
  const theme = process.env.OTK_CLEAR_THEME;
  if (theme) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await state.product("prefs.set", { key: "textSize", value: "125" });
    await state.product("prefs.set", { key: "animationsOff", value: true });
  }
  const main = "tstv1-otk";
  await state.product("tasks.create", {
    directory: state.directory,
    name: "Review helpers",
    sessions: [main],
  });
  for (const sessionID of [main, "tstv1-blocked"]) {
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "release",
      sessionID,
    });
  }
  await openSession(state, page, main);
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "hold",
    target: "helper-review",
  });
  const row = (id: string, view = page) =>
    view.getByRole("complementary", { name: "Right panel" }).locator(
      `[data-session="${id}"]`,
    );
  const lamp = (n: number, view = page) =>
    row(`tstv1-disp-${n}`, view).locator(".otk-status-light");
  // Observe the foreign checkout concurrently, without opening its finished
  // helper (which would acknowledge it independently of the command).
  const checkout = await page.context().newPage();
  await checkout.goto(`${state.url}/#/local/tstv1-disp-1`);
  await expect(
    checkout.getByRole("button", { name: "Project: helper-checkout" }),
  )
    .toBeVisible();
  await page.bringToFront();
  await expect(lamp(1, checkout)).toHaveAttribute("data-state", "working");
  await expect(lamp(8, checkout)).toHaveAttribute("data-state", "finished");
  await expect(lamp(4)).toHaveAttribute("data-state", "finished");
  await row(main).click({ button: "right" });
  const item = page.getByRole("menuitem", { name: "Clear attention (5)" });
  await expect(item).toBeVisible();
  if (theme) {
    await item.hover();
    await page.screenshot({ path: info.outputPath("clear-attention.png") });
  }
  await item.click();
  await expect(
    page.getByText("That session is no longer available.", { exact: true }),
  )
    .toHaveCount(1);
  await expect(lamp(4)).toHaveAttribute("data-state", "finished");
  reject = false;
  // The shared request feedback owner closes the menu when it presents an RPC error.
  await row(main).click({ button: "right" });
  await item.click();
  await expect(page.getByRole("menu", { name: "Context menu" })).toBeHidden();
  for (const n of [3, 4, 6, 7]) {
    await expect(lamp(n)).toHaveAttribute("data-state", "none");
  }
  await expect(lamp(0)).toHaveAttribute("data-state", "working");
  await expect(lamp(2)).toHaveAttribute("data-state", "blocked");
  await expect(lamp(1, checkout)).toHaveAttribute("data-state", "working");
  await expect(lamp(8, checkout)).toHaveAttribute("data-state", "none");
  const key = transport.sent.filter(({ frame }) =>
    frame.method === "sessions.acknowledge"
  ).at(-1)?.frame.ref?.key;
  expect(key).toBeDefined();
  const receipt = transport.received.find((frame) =>
    frame.t === "request.result" && frame.ref?.key === key
  )?.outcome as { ok: boolean; result: { sessions: { sessionID: string }[] } };
  expect(receipt.ok).toBe(true);
  expect(receipt.result.sessions.map(({ sessionID }) => sessionID).sort())
    .toEqual([3, 4, 6, 7, 8].map((n) => `tstv1-disp-${n}`));
  await row(main).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /^Clear attention/ }))
    .toHaveCount(0);
  await checkout.close();
});
