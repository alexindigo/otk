// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";
import { chips, messages, pendingChips, upload } from "../../pages/composer.ts";

test.use({
  profile: "revert-native",
  viewport: { width: 1440, height: 1000 },
  timezoneId: "America/Los_Angeles",
});
test("revert.saved-branch-survives-send-and-reload", {
  tag: ["@revert", "@messages", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const source = await state.native<{ id: string }>("/session", "POST", {
    title: "Earlier branch",
  });
  await state.product("prefs.set", { key: "animationsOff", value: true });
  await openSession(state, page, source.id);
  const exact = "Keep this exact prompt\n  including spacing.";
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 24;
    canvas.getContext("2d")!.fillRect(0, 0, 32, 24);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await upload(page, [{
    name: "earlier.png",
    mime: "image/png",
    bytes: image,
  }]);
  await expect(pendingChips(page)).toHaveCount(0);
  await state.queue(["The saved earlier reply."]);
  await prompt(page, exact);
  await expect(page.locator(".otk-messages")).toContainText(
    "The saved earlier reply.",
  );
  await expect(page.locator(`[data-session="${source.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  const oldPrompt = (await messages(state, source.id)).find((m) =>
    m.info.role === "user"
  )!;
  const input = page.locator("textarea[name=prompt]");
  await input.fill("Original unsent draft");
  await page.locator(".otk-user-bubble").focus();
  await page.locator('[data-message-command="prompt.revert"]').click();
  await expect(
    page.getByRole("button", { name: "Restore conversation", exact: true }),
  ).toBeVisible();
  await state.queue(["The replacement reply."]);
  await prompt(page, "Replacement prompt");
  await expect(page.locator(".otk-messages")).toContainText(
    "The replacement reply.",
  );
  expect(
    (await messages(state, source.id)).some((m) =>
      m.info.id === oldPrompt.info.id
    ),
  ).toBe(false);
  await page.getByRole("button", { name: /Unrevert: .*saved earlier branch/ })
    .click();
  const saved = page.getByRole("region", {
    name: "Saved earlier branch",
    exact: true,
  });
  const capture = async (phase: string) => {
    for (
      const [name, id] of [["dark", "otk-dark"], ["linen", "otk-light"], [
        "stone",
        "otk-light-stone",
      ]]
    ) {
      await state.product("prefs.set", { key: "theme", value: id });
      await expect(page.locator("html")).toHaveAttribute("data-otk-theme", id);
      await saved.locator(".otk-saved-header").scrollIntoViewIfNeeded();
      if (phase === "saved") {
        const top =
          (await saved.locator(".otk-saved-toolbar").boundingBox())!.y;
        await saved.locator(".otk-saved-message").last()
          .scrollIntoViewIfNeeded();
        expect(
          Math.abs(
            (await saved.locator(".otk-saved-toolbar").boundingBox())!.y - top,
          ),
        ).toBeLessThan(1);
        await expect(
          saved.getByRole("heading", {
            name: "Saved earlier branch",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          saved.getByRole("button", {
            name: "Back to live conversation",
            exact: true,
          }),
        ).toBeVisible();
      }
      await page.screenshot({
        path: test.info().outputPath(`rv2-${phase}-${name}.png`),
        fullPage: true,
      });
    }
  };
  await expect(saved).toBeVisible();
  await expect(saved).toContainText(
    "This earlier branch was replaced; you can read it and reuse its prompts",
  );
  await expect(saved).toContainText("Files are not restored");
  await expect(saved).toContainText("The saved earlier reply.");
  await expect(saved).not.toContainText(
    /Digesting|Time unknown|streaming|response in progress/,
  );
  await expect(saved.getByRole("status")).toHaveCount(0);
  await expect(saved.locator('[data-message-command="prompt.revert"]'))
    .toHaveCount(0);
  await input.fill("New draft to keep");
  await saved.getByRole("button", { name: "Reuse prompt", exact: true })
    .click();
  await expect(input).toHaveValue("New draft to keep");
  await capture("choice");
  await page.getByRole("button", { name: "Use saved prompt", exact: true })
    .click();
  await expect(input).toHaveValue(exact);
  await expect(chips(page)).toHaveCount(1);
  await capture("saved");
  await expect(saved).toContainText("Saved prompt: Keep this exact prompt");
  await expect(saved).not.toContainText("saved prompt:");
  await page.reload();
  await page.getByRole("button", { name: /Unrevert: .*saved earlier branch/ })
    .click();
  await expect(saved).toContainText("The saved earlier reply.");
  await expect(saved).toContainText("New draft to keep");
  await expect(saved).not.toContainText(
    /Digesting|Time unknown|streaming|response in progress/,
  );
  await saved.getByRole("button", { name: "Reuse prompt", exact: true })
    .click();
  await expect(input).toHaveValue(exact);
  await expect(chips(page)).toHaveCount(1);
  await saved.getByRole("button", { name: "Delete saved branch", exact: true })
    .click();
  await expect(saved).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Unrevert:/ })).toHaveCount(0);
  await expect(page.locator(".otk-messages")).toContainText(
    "The replacement reply.",
  );
  await state.queue(["The earlier prompt ran again."]);
  await input.focus();
  await expect(page.locator(".otk-send-button")).toBeEnabled();
  await input.press("Enter");
  await expect(page.locator(".otk-messages")).toContainText(
    "The earlier prompt ran again.",
  );
  const rerun = (await messages(state, source.id)).filter((m) =>
    m.info.role === "user"
  ).at(-1)!;
  expect(rerun.parts.find((p) => p.type === "text")?.text).toBe(exact);
  expect(rerun.parts.find((p) => p.type === "file")?.url).toBe(
    `data:image/png;base64,${image}`,
  );
});

test("revert.restore-retains-both-edited-drafts-across-reload", {
  tag: ["@revert", "@messages", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const source = await state.native<{ id: string }>("/session", "POST", {
    title: "Edited revert draft",
  });
  await openSession(state, page, source.id);
  await state.queue(["Restored native reply."]);
  await prompt(page, "The earlier prompt");
  await expect(page.locator(".otk-messages")).toContainText(
    "Restored native reply.",
  );
  await expect(page.locator(`[data-session="${source.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  const input = page.locator("textarea[name=prompt]");
  await input.fill("Original draft before revert");
  await page.locator(".otk-user-bubble").focus();
  await page.locator('[data-message-command="prompt.revert"]').click();
  const restore = page.getByRole("button", {
    name: "Restore conversation",
    exact: true,
  });
  await expect(restore).toBeVisible();
  await input.fill("Current edited draft");
  await restore.click();
  await expect(page.locator(".otk-messages")).toContainText(
    "Restored native reply.",
  );
  await expect(input).toHaveValue("Current edited draft");
  await expect(
    page.getByRole("button", { name: "Use saved draft", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keep current draft", exact: true })
    .click();
  await expect(input).toHaveValue("Current edited draft");
  await page.reload();
  await page.getByRole("button", { name: /Unrevert: .*saved earlier branch/ })
    .click();
  const saved = page.getByRole("region", {
    name: "Saved earlier branch",
    exact: true,
  });
  await expect(saved).toContainText("Original draft before revert");
  await expect(saved).toContainText("Current edited draft");
  await saved.getByRole("button", {
    name: "Use draft: Before revert",
    exact: true,
  }).click();
  await expect(input).toHaveValue("Original draft before revert");
});

test(
  "revert.quota-failure-is-one-actionable-failure-and-keeps-native-history",
  {
    tag: ["@revert", "@messages", "@isolated"],
  },
  async ({ isolatedState: state, page }) => {
    const source = await state.native<{ id: string }>("/session", "POST", {
      title: "Quota-protected branch",
    });
    await openSession(state, page, source.id);
    await state.queue(["The original reply remains."]);
    await prompt(page, "Keep this original prompt");
    await expect(page.locator(".otk-messages")).toContainText(
      "The original reply remains.",
    );
    await expect(page.locator(`[data-session="${source.id}"]`)).toHaveAttribute(
      "data-status",
      "idle",
    );
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("otk.branch-history.v1/")) {
          throw new DOMException("Storage is full", "QuotaExceededError");
        }
        return original.call(this, key, value);
      };
    });
    await page.locator(".otk-user-bubble").focus();
    await page.locator('[data-message-command="prompt.revert"]').click();
    const alert = page.getByRole("alert");
    await expect(alert).toHaveCount(1);
    await expect(alert).toContainText("Saving an earlier branch");
    await expect(alert).toContainText("Quota-protected branch");
    await expect(alert).toContainText("were not saved");
    await expect(alert).toContainText("localStorage is full");
    await expect(alert).toContainText("Delete a saved branch");
    expect(
      (await state.product("session.get", { sessionID: source.id })).revert,
    ).toBeFalsy();
    await expect(page.locator(".otk-messages")).toContainText(
      "The original reply remains.",
    );
  },
);
