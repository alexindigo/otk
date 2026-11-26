// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/composer.ts";
import type { PromptInput } from "@otk/protocol";
import { expectPrimaryBlocked, send } from "../../pages/primary-action.ts";

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
          await expect(page.locator(".otk-composer-agent")).toHaveText("Build");
          await expect.poll(async () => (await observe()).calls).toBe(1);
          // Decision 34 and fx-green5's Send-latency requirement: only prompt
          // references join readiness. This plain text references no held model.
          await prompt(page).fill("Capture the choice made during readiness");
          await prompt(page).press("Enter");
          await expect.poll(async () => (await observe()).sent).toHaveLength(1);
          const first = (await observe()).sent[0];
          expect({
            agent: first.agent,
            model: first.model,
            variant: first.variant,
          }).toEqual({ agent: "build", model: undefined, variant: undefined });
          expect(first.parts).toEqual([{
            kind: "text",
            text: "Capture the choice made during readiness",
          }]);
          // No native receipt: the pending entry owns the send under OTK's
          // supplied identity (2.39), so the composer releases the draft.
          await expect(prompt(page)).toHaveValue("");
          await page.locator(".otk-agent-picker > button").click();
          await page.locator('.otk-agent-picker [data-picker-key="review"]')
            .click();
          await expect(page.locator(".otk-composer-agent")).toHaveText(
            "Review",
          );
          expect((await observe()).sent).toHaveLength(1);
          await scenario("release");
          await prompt(page).fill("Send the later explicit choice");
          await prompt(page).press("Enter");
          await expect.poll(async () => (await observe()).sent).toHaveLength(2);
          const sent = (await observe()).sent[1];
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
            text: "Send the later explicit choice",
          }]);
          expect((await observe()).sent[0]).toEqual(first);
          await expect(prompt(page)).toHaveValue("");
          return;
        }
        if (kind === "native-null") {
          await expect(page.locator(".otk-composer-agent")).toHaveText("Build");
          await open();
          await expect(picker.locator("[role=status]")).toHaveText(
            "Loading...",
          );
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
          await expect(picker.locator("[role=status]")).toHaveText(
            "Loading...",
          );
          await expect(picker.locator(".otk-picker-empty")).toHaveCount(0);
          await expect(picker).not.toContainText("unavailable");
          // The loading presentation precedes backend acquisition; reject only
          // after the real listModels consumer has joined this controlled promise.
          await expect.poll(async () => (await observe()).calls).toBe(1);
          await scenario("fail");
        }
        await expect(picker.locator("[role=alert] .otk-failure-content"))
          .toHaveText(
            /OTK has no further details/,
          );
        await expect(picker).not.toContainText(
          kind === "missing"
            ? "Catalog temporarily unreachable"
            : "Catalog offline",
        );
        await expect(picker.locator(".otk-picker-empty")).toHaveCount(0);
        if (kind === "missing") {
          await expect(picker).not.toContainText("unavailable");
          await picker.getByRole("button", { name: "Retry", exact: true })
            .click();
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
              /OTK has no further details/,
            );
          await expect(picker).not.toContainText("Refresh failed");
          await expect(picker.locator(".otk-picker-name > span").first())
            .toHaveText("Available model");
          await picker.getByRole("button", { name: "Retry", exact: true })
            .click();
          await expect(picker.locator("[role=alert], [role=status]"))
            .toHaveCount(0);
          expect((await observe()).calls).toBe(4);
        }
      },
    );
  });
}

test.describe("input-referenced catalog", () => {
  test.use({ profile: "composer-commands" });
  test("composer.catalog-referenced-command-waits-for-choice", {
    tag: ["@composer", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Referenced command readiness",
    });
    const frames = await wire(page);
    frames.hold((frame) =>
      frame.t === "catalog.chunk" && frame.kind === "commands"
    );
    try {
      await openSession(state, page, session.id);
      await expect.poll(() => frames.held.length).toBeGreaterThan(0);
      const text = "/probe held catalog choice";
      // The argument bypasses autocomplete activation: this is a real Send
      // whose own input references the held command catalog (decision 34).
      await prompt(page).fill(text);
      await send(page).click();
      await expect(page.locator(".otk-prompt")).toHaveAttribute(
        "aria-description",
        "Preparing or sending prompt...",
      );
      await expectPrimaryBlocked(send(page), "Previous message still sending");
      await expect(prompt(page)).toHaveValue(text);
      const submissions = () =>
        frames.sent.filter(({ frame }) =>
          ["session.prompt", "session.command", "session.shell"].includes(
            frame.method ?? "",
          )
        );
      expect(submissions()).toHaveLength(0);
      await state.queue(["Referenced command delivered."]);
      frames.release();
      await expect(page.locator("[data-role=assistant] .otk-text"))
        .toHaveText("Referenced command delivered.");
      await expect(prompt(page)).toHaveValue("");
      if (state.controller.info!.version.startsWith("2.")) {
        await expect(page.locator(".otk-composer-notice")).toContainText(
          "did not provide a way to confirm its message",
        );
        await expect(page.getByRole("button", { name: "Check send" }))
          .toBeVisible();
      }
      expect(submissions()).toHaveLength(1);
      expect(submissions()[0].frame.method).toBe("session.command");
      expect(submissions()[0].frame.params).toMatchObject({
        sessionID: session.id,
        command: "probe",
        arguments: "held catalog choice",
      });
    } finally {
      frames.release();
    }
  });
});
