// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { wire } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/composer.ts";
import type { PromptInput } from "@otk/protocol";

for (
  const kind of [
    "missing",
    "none",
    "pending-choice",
    "failed-variant",
    "native-null",
  ] as const
) {
  test.describe(kind, () => {
    test.use({ profile: `contract-composer-${kind}` });
    test(
      `composer.catalog-${kind}`,
      { tag: ["@composer", "@isolated"] },
      async ({ isolatedState: state, page }) => {
        const frames = await wire(page);
        const id = kind === "native-null" ? "opcv1-core" : "tstv1-core";
        await page.goto(`${state.url}/#/local/${id}`);
        const picker = page.locator(".otk-model-picker");
        const open = async () => {
          await picker.locator(":scope > button").click();
          await expect(picker.locator(".otk-popover-panel")).toBeVisible();
        };
        const observe = () =>
          state.observe<{ sent: PromptInput[]; calls: number }>();
        const scenario = (action: "fail" | "release") =>
          state.controller.call("scenario", {
            lease: state.lease.lease,
            action,
          });
        if (kind === "none") {
          await expect(page.locator(".otk-prompt-context")).toContainText(
            "Default model",
          );
          await expect(picker).toHaveCount(0);
          expect(
            frames.sent.some(({ frame }) => frame.method === "models.list"),
          ).toBe(false);
          return;
        }
        if (kind === "pending-choice") {
          await expect(page.locator(".otk-agent-picker")).toBeVisible();
          await prompt(page).fill("Capture the choice made during readiness");
          await prompt(page).press("Enter");
          await page.locator(".otk-agent-picker > button").click();
          await page.locator('.otk-agent-picker [data-picker-key="review"]')
            .click();
          await expect(page.locator(".otk-composer-agent")).toHaveText(
            "Review",
          );
          expect((await observe()).sent).toHaveLength(0);
          await scenario("release");
          await expect.poll(async () => (await observe()).sent).toHaveLength(1);
          const sent = (await observe()).sent[0];
          expect({
            agent: sent.agent,
            model: sent.model,
            variant: sent.variant,
          }).toEqual({
            agent: "review",
            model: { provider: "later", model: "choice" },
            variant: "high",
          });
          expect(sent.parts).toEqual([{
            kind: "text",
            text: "Capture the choice made during readiness",
          }]);
          await expect(prompt(page)).toHaveValue("");
          return;
        }
        if (kind === "native-null") {
          await expect(page.locator(".otk-composer-agent")).toHaveText("Build");
          await open();
          await expect(picker.locator("[role=status]")).toHaveText("Loading…");
          await expect(
            page.locator(
              ".otk-variant-picker, .otk-prompt-context > span:not(.otk-popover)",
            ),
          ).toHaveCount(0);
          await page.keyboard.press("Escape");
          await scenario("release");
          await expect(page.locator(".otk-composer-provider")).toHaveText(
            "Fixture provider",
          );
          await expect(page.locator(".otk-composer-model-name")).toHaveText(
            "Plain model",
          );
          await prompt(page).fill("Send with native absence");
          await prompt(page).press("Enter");
          await expect.poll(async () => (await observe()).sent).toHaveLength(1);
          const sent = (await observe()).sent[0];
          expect(sent.agent).toBe("build");
          expect(sent.model).toEqual({ provider: "fixture", model: "plain" });
          expect(Object.hasOwn(sent, "variant")).toBe(false);
          return;
        }
        if (kind === "failed-variant") {
          await expect(page.locator(".otk-prompt-context > span:last-child"))
            .toHaveText("High");
          await expect(page.locator(".otk-composer-provider")).toHaveText(
            "offline",
          );
        } else {await expect(page.locator(".otk-composer-model-name"))
            .toHaveText("restored-model");}
        await open();
        if (kind === "missing") {
          await expect(picker.locator("[role=status]")).toHaveText("Loading…");
          await expect(picker.locator(".otk-picker-empty")).toHaveCount(0);
          await expect(picker).not.toContainText("unavailable");
          // The loading presentation precedes backend acquisition; reject only
          // after the real listModels consumer has joined this controlled promise.
          await expect.poll(async () => (await observe()).calls).toBe(1);
          await scenario("fail");
        }
        await expect(picker.locator("[role=alert] .otk-failure-content"))
          .toHaveText(
            /No publishable failure reason is available/,
          );
        await expect(picker).not.toContainText(
          kind === "missing"
            ? "Catalog temporarily unreachable"
            : "Catalog offline",
        );
        await expect(picker.locator(".otk-picker-empty")).toHaveCount(0);
        if (kind === "missing") {
          await expect(picker).not.toContainText("unavailable");
          await picker.locator("[role=alert] button").click();
          await expect(picker).toContainText(
            "disconnected/restored-model — unavailable",
          );
          await expect(picker.locator("[role=alert]")).toHaveCount(0);
        }
        await page.keyboard.press("Escape");
        await prompt(page).fill(
          kind === "missing"
            ? "Send with restored unavailable identity"
            : "Keep the unknown restored variant",
        );
        await prompt(page).press("Enter");
        await expect.poll(async () => (await observe()).sent).toHaveLength(1);
        const sent = (await observe()).sent[0];
        expect({
          agent: sent.agent,
          model: sent.model,
          ...(kind === "failed-variant" ? { variant: sent.variant } : {}),
        }).toEqual(
          kind === "missing"
            ? {
              agent: "build",
              model: { provider: "disconnected", model: "restored-model" },
            }
            : {
              agent: "review",
              model: { provider: "offline", model: "restored" },
              variant: "high",
            },
        );
        if (kind === "missing") {
          await open();
          await picker.locator(".otk-picker-status > button").click();
          await expect(picker.locator("[role=alert] .otk-failure-content"))
            .toHaveText(
              /No publishable failure reason is available/,
            );
          await expect(picker).not.toContainText("Refresh failed");
          await expect(picker.locator(".otk-picker-name > span").first())
            .toHaveText("Available model");
          await picker.locator("[role=alert] button").click();
          await expect(picker.locator("[role=alert], [role=status]"))
            .toHaveCount(0);
          expect((await observe()).calls).toBe(4);
        }
      },
    );
  });
}
