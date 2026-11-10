// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../fixtures/evidence.ts";
import { openSession, wire } from "../fixtures/wire.ts";

test("smoke.native-agent-identities-retain-display-labels", {
  tag: ["@smoke", "@composer"],
}, async ({ state, page }, info) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Native agent identity",
  });
  const traffic = await wire(page);
  await openSession(state, page, session.id);
  const agents = await state.product(
    "agents.list",
    { sessionID: session.id, primary: true },
  );
  const agent = agents.find((agent) => (agent.id ?? agent.name) === "build")!;
  expect(agent).toBeDefined();
  const identity = agent.id ?? agent.name;
  const picker = page.locator(".otk-agent-picker");
  await picker.locator(":scope > button").click();
  await picker.locator(
    `[data-picker-key=${JSON.stringify(identity)}] .otk-picker-option`,
  ).click();
  await state.queue(["Agent identity reached the provider."]);
  const prompt = page.locator("textarea[name=prompt]");
  await prompt.fill("Use the selected native agent");
  await prompt.press("Enter");
  await expect(page.locator("[data-role=assistant] .otk-text")).toHaveText(
    "Agent identity reached the provider.",
  );
  expect(
    traffic.sent.filter(({ frame }) => frame.method === "session.prompt").at(
      -1,
    )!
      .frame.params!.agent,
  ).toBe(identity);
  for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await picker.locator(":scope > button").click();
    await expect(picker.locator(".otk-popover-panel")).toBeVisible();
    await info.attach(`agent-identity-${theme}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await page.keyboard.press("Escape");
  }
});
