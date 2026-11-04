// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";
import { receivedPrompt } from "../../fixtures/provider.ts";
import { independentPage } from "../../pages/visual.ts";
test("visual.reasoning-display-persists-broadcasts-and-retains-exact-writes", {
  tag: ["@visual", "@smoke", "@smoke.preferences"],
}, async ({ state, page, browser }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Preferences",
  });
  const traffic = await wire(page);
  await openSession(state, page, session.id);
  await state.controller.call("queueScript", {
    lease: state.lease.lease,
    reasoning: [
      "**Checking preferences**\n\n",
      "Reasoning body visible only when expanded.",
    ],
    chunks: ["Preference proof."],
    delay: 150,
  });
  await prompt(page, "Reason about the display");
  await expect.poll(async () =>
    receivedPrompt(
      (await state.observe<{ requests: unknown[] }>()).requests,
      "Reason about the display",
    )
  ).toBe(true);
  await expect(page.locator(".otk-reasoning > button")).toContainText(
    "Thought",
  );
  await expect(
    page.locator("[data-role=assistant] .otk-text").filter({
      hasText: "Preference proof.",
    }),
  ).toHaveText("Preference proof.");
  await expect(page.locator(".otk-reasoning-body")).toHaveCount(0);
  await page.locator(".otk-reasoning > button").click();
  await expect(page.locator(".otk-reasoning-body")).toContainText(
    "Reasoning body visible",
  );
  await page.locator(".otk-display-menu > button").click();
  await page.locator("select[name=thinking]").selectOption("show");
  await expect(page.locator("select[name=thinking]")).toHaveValue("show");
  await page.locator("input[name=timestamps]").click();
  await expect.poll(() =>
    page.locator(".otk-user-meta time").evaluate((el) =>
      getComputedStyle(el).visibility
    )
  ).toBe("visible");
  await page.reload();
  await expect(page.locator(".otk-reasoning-body")).toBeVisible();
  await expect(page.locator("select[name=thinking]")).toHaveValue("show");
  const { page: other, errors } = await independentPage(state, browser);
  await other.goto(state.url + `/#/local/${session.id}`);
  await expect(other.locator(".otk-reasoning-body")).toBeVisible();
  await page.locator(".otk-display-menu > button").click();
  await page.locator("select[name=thinking]").selectOption("hide");
  for (const p of [page, other]) {
    await expect(p.locator(".otk-reasoning-body")).toHaveCount(0);
    await expect(p.locator("select[name=thinking]")).toHaveValue("hide");
  }
  expect(
    traffic.sent.filter(({ frame }) => frame.method === "prefs.set").map((
      { frame },
    ) => frame.params),
  ).toEqual([
    { key: "models.recent", value: [{ provider: "fake", model: "scripted" }] },
    { key: "thinking", value: "show" },
    { key: "timestamps", value: true },
    { key: "thinking", value: "hide" },
  ]);
  expect(errors).toEqual([]);
});
test("visual.appearance-real-working-lights-preferences-and-reload", {
  tag: ["@visual"],
}, async ({ state, page, browser }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Visual system",
  });
  await openSession(state, page, session.id);
  const light = page.locator(
    `[data-session="${session.id}"] .otk-status-light`,
  );
  await expect(light).toHaveAttribute("data-state", "idle");
  expect(
    await page.locator("textarea[name=prompt]").evaluate(async (el) => {
      await document.fonts.ready;
      return getComputedStyle(el).fontFamily;
    }),
  ).toBe('"IBM Plex Sans", sans-serif');
  const gate = await state.queue([
    "Working with the visual system.",
    " Finished.",
  ], "held");
  await prompt(page, "Show the working light");
  await expect(light).toHaveAttribute("data-state", "working");
  await state.release(gate.gate);
  await expect(page.locator("[data-role=assistant] .otk-text")).toHaveText(
    "Working with the visual system. Finished.",
  );
  await expect(light).toHaveAttribute("data-state", "idle");
  await page.locator(".otk-settings-entry").click();
  const { page: other, errors } = await independentPage(state, browser);
  await other.goto(state.url);
  for (const key of ["reducedColors", "animationsOff"]) {
    await page.locator(`input[name=${key}]`).click();
    const attr = key === "reducedColors"
      ? "data-otk-reduced-colors"
      : "data-otk-animations-off";
    for (const p of [page, other]) {
      await expect(p.locator("html")).toHaveAttribute(attr, "");
    }
  }
  const prefs = await state.product("prefs.get", {});
  expect(prefs.reducedColors).toBe(true);
  expect(prefs.animationsOff).toBe(true);
  await page.reload();
  for (const attr of ["data-otk-reduced-colors", "data-otk-animations-off"]) {
    await expect(page.locator("html")).toHaveAttribute(attr, "");
  }
  await openSession(state, page, session.id);
  expect(
    await light.locator(".otk-lamp-shape").evaluate((el) =>
      getComputedStyle(el).display
    ),
  ).toBe("block");
  expect(
    await light.locator(".otk-lamp-body").evaluate((el) =>
      getComputedStyle(el).display
    ),
  ).toBe("none");
  expect(errors).toEqual([]);
});
