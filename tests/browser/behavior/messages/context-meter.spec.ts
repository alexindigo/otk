// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";

test.use({ profile: "messages-context" });
test("messages.native-catalog-context-window", {
  tag: ["@messages", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Beam Free context",
  });
  const v2 = state.controller.info!.version.startsWith("2.");
  const native = await state.native<
    {
      all: {
        id: string;
        models: Record<string, { limit: { context: number } }>;
      }[];
    }
  >(v2 ? "/model" : "/provider");
  expect(
    v2
      ? (native as unknown as {
        data: {
          providerID: string;
          id: string;
          limit: { context: number };
        }[];
      }).data
        .find((model) =>
          model.providerID === "opencode" && model.id === "beam-free"
        )!.limit.context
      : native.all.find((provider) => provider.id === "opencode")!
        .models["beam-free"].limit.context,
  ).toBe(10000);
  const catalog = await state.product("models.list", { sessionID: session.id });
  console.info(
    "U1 catalog evidence",
    JSON.stringify(
      catalog.providers.find((provider) => provider.id === "opencode")!.models
        .find((model) => model.id === "beam-free"),
    ),
  );
  await openSession(state, page, session.id);
  await prompt(page, "Check catalog context usage");
  await expect(page.locator(".otk-messages")).toContainText(
    "Catalog context reply.",
  );
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  const meter = page.locator(".otk-context-meter");
  await expect(meter).toHaveAttribute("data-tokens", "2500");
  await expect(meter).toHaveAttribute("data-limit", "10000");
  const fraction = () =>
    page.locator(".otk-context-bar").evaluate((element) =>
      element.firstElementChild!.getBoundingClientRect().width /
      element.getBoundingClientRect().width
    );
  await expect.poll(async () => Math.abs(await fraction() - .25))
    .toBeLessThanOrEqual(.001);
  await expect(meter).toHaveAttribute("title", /10,000/);
  await page.reload();
  await expect(meter).toHaveAttribute("data-limit", "10000");
  await page.locator(".otk-model-picker > button").click();
  await page.locator(".otk-model-picker input[type=search]").fill(
    "Other catalog model",
  );
  await page.locator(
    ".otk-model-picker .otk-picker-row[data-picker-key=" +
      JSON.stringify(JSON.stringify(["other", "beam-free"])) +
      "] .otk-picker-option",
  ).click();
  await expect(page.locator(".otk-model-picker .otk-composer-model-name"))
    .toHaveText("Other catalog model");
  await expect(meter).toHaveAttribute("data-limit", "10000");
  await prompt(page, "Use the other catalog window");
  await expect(meter).toHaveAttribute("data-limit", "20000");
  await expect(meter).toHaveAttribute("data-tokens", "2500");
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await expect.poll(async () => Math.abs(await fraction() - .125))
    .toBeLessThanOrEqual(.001);
  const child = await state.native<{ id: string }>("/session", "POST", {
    title: "Helper context",
    parentID: session.id,
  });
  await state.product("session.prompt", {
    sessionID: child.id,
    mode: "normal",
    model: { provider: "opencode", model: "beam-free" },
    parts: [{ kind: "text", text: "Check helper context" }],
  });
  await page.goto(`${state.url}/#/local/${child.id}`);
  await expect(meter).toHaveAttribute("data-limit", "10000");
  await expect(meter).toHaveAttribute("data-tokens", "2500");
  await expect(page.locator("textarea[name=prompt]")).toHaveCount(0);
});
