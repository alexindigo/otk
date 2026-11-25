// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";
import { chips, messages, pendingChips, upload } from "../../pages/composer.ts";
import { pick, rightClick } from "../../pages/menus.ts";

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
  await page.getByRole("button", { name: "Confirm revert", exact: true })
    .click();
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
  await page.getByRole("button", { name: /Saved earlier branches/ })
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
  // Scoped facts may explicitly explain unknown captured timing. A saved
  // reply footer must still never borrow a live fallback or digest state.
  // Saved replies borrow the same sole footer clock as live replies.
  await expect(saved.locator("[data-role=assistant] .otk-message-footer time"))
    .toHaveAttribute(
      "datetime",
      /\d{4}-/,
    );
  await saved.locator(".otk-reply-start .otk-entity-pill").hover();
  await expect(saved.locator(".otk-entity-facts")).toContainText("This reply");
  await expect(saved).not.toContainText(
    /Digesting|streaming|response in progress/,
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
  await page.getByRole("button", { name: /Saved earlier branches/ })
    .click();
  await expect(saved).toContainText("The saved earlier reply.");
  await expect(saved).toContainText("New draft to keep");
  await expect(saved.locator("[data-role=assistant] .otk-message-footer time"))
    .toHaveAttribute(
      "datetime",
      /\d{4}-/,
    );
  await saved.locator(".otk-reply-start .otk-entity-pill").hover();
  await expect(saved.locator(".otk-entity-facts")).toContainText("This reply");
  await expect(saved).not.toContainText(
    /Digesting|streaming|response in progress/,
  );
  await saved.getByRole("button", { name: "Reuse prompt", exact: true })
    .click();
  await expect(input).toHaveValue(exact);
  await expect(chips(page)).toHaveCount(1);
  await saved.getByRole("button", { name: "Delete saved branch", exact: true })
    .click();
  await expect(saved).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Saved earlier branches/ }))
    .toHaveCount(0);
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
  await page.getByRole("button", { name: "Confirm revert", exact: true })
    .click();
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
  await rightClick(page, ".otk-messages");
  await pick(page, "Saved earlier branches");
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
    await page.getByRole("button", { name: "Confirm revert", exact: true })
      .click();
    const alert = page.getByRole("alert");
    await expect(alert).toHaveCount(1);
    await expect(alert).toContainText("Reverted from");
    await expect(alert).not.toContainText("Quota-protected branch");
    await expect(alert.locator(".otk-failure-target")).toHaveCount(0);
    await expect(alert).toContainText("were not saved");
    await expect(alert).toContainText("localStorage is full");
    await alert.locator(".otk-record-group-toggle").click();
    await alert.getByRole("button", { name: "Details", exact: true }).click();
    await expect(alert).toContainText("Delete a saved branch");
    expect(
      (await state.product("session.get", { sessionID: source.id })).revert,
    ).toBeTruthy();
    // Preservation gates destructive Send, not reversible Revert dispatch.
    const input = page.locator("textarea[name=prompt]");
    await input.fill("Replacement blocked by quota");
    await input.press("Enter");
    const choice = page.locator(".otk-permanence-choice");
    await expect(choice.getByRole("status")).toContainText(
      "Sending makes the revert permanent",
    );
    await expect(alert).toHaveCount(0);
    await expect(choice.locator(".otk-failure-target")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save copy", exact: true }))
      .toBeVisible();
    await expect(page.getByRole("button", { name: "Send anyway", exact: true }))
      .toBeVisible();
    await expect(input).toHaveValue("Replacement blocked by quota");
    expect(
      (await state.product("session.get", { sessionID: source.id })).revert,
    ).toBeTruthy();
    expect(
      (await messages(state, source.id)).some((m) =>
        m.parts.some((p) =>
          p.type === "text" && p.text === "Keep this original prompt"
        )
      ),
    ).toBe(true);
    expect(
      (await messages(state, source.id)).some((m) =>
        m.parts.some((p) =>
          p.type === "text" && p.text === "Replacement blocked by quota"
        )
      ),
    ).toBe(false);
  },
);

test("revert.restore-copy-failure-offers-retry-and-explicit-unsaved-choice", {
  tag: ["@revert", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const source = await state.native<{ id: string }>("/session", "POST", {
    title: "Restore copy recovery",
  });
  await openSession(state, page, source.id);
  await state.queue(["Retained native reply."]);
  await prompt(page, "Retained original prompt");
  await expect(page.locator(".otk-messages")).toContainText(
    "Retained native reply.",
  );
  await expect(page.locator(`[data-session="${source.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Reflect.set(globalThis, "restoreCopyStorage", () => {
      Storage.prototype.setItem = original;
    });
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("otk.branch-history")) {
        throw new DOMException("full", "QuotaExceededError");
      }
      original.call(this, key, value);
    };
  });
  await page.locator(".otk-user-bubble").focus();
  await page.locator('[data-message-command="prompt.revert"]').click();
  await page.getByRole("button", { name: "Confirm revert", exact: true })
    .click();
  const group = page.locator(".otk-revert-group");
  await expect(group).toContainText("localStorage is full");
  await expect(group).not.toContainText("replacement was not sent");
  const input = page.locator("textarea[name=prompt]");
  await input.fill("Keep this edited replacement");
  await page.getByRole("button", { name: "Restore conversation", exact: true })
    .click();
  await expect(group).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Keep without a saved copy",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".otk-composer-notice")).toContainText(
    "Saving a copy after Restore",
  );
  await expect(page.locator(".otk-composer-notice")).not.toContainText(
    "replacement was not sent",
  );
  await expect(input).toHaveValue("Keep this edited replacement");
  for (
    const [theme, id] of [["dark", "otk-dark"], ["linen", "otk-light"], [
      "stone",
      "otk-light-stone",
    ]]
  ) {
    await state.product("prefs.set", { key: "theme", value: id });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", id);
    const geometry = await page.evaluate(() => {
      const messages = document.querySelector(".otk-messages")!
        .getBoundingClientRect();
      const notice = document.querySelector(".otk-composer-notice")!
        .getBoundingClientRect();
      const prompt = document.querySelector(".otk-prompt")!
        .getBoundingClientRect();
      const controls = Array.from(
        document.querySelectorAll(".otk-composer-notice button"),
      )
        .filter((button) =>
          ["Retry", "Keep without a saved copy"].includes(
            button.textContent!.trim(),
          )
        )
        .map((button) => button.getBoundingClientRect());
      return {
        transcriptGap: notice.top - messages.bottom,
        promptGap: prompt.top - notice.bottom,
        centers: controls.map((box) => box.y + box.height / 2),
      };
    });
    expect(geometry.transcriptGap).toBeGreaterThanOrEqual(-1);
    expect(geometry.promptGap).toBeGreaterThanOrEqual(-1);
    expect(geometry.centers).toHaveLength(2);
    expect(Math.abs(geometry.centers[0] - geometry.centers[1])).toBeLessThan(
      0.5,
    );
    await page.screenshot({
      path: test.info().outputPath(`restore-copy-failure-${theme}.png`),
      fullPage: true,
    });
  }
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Keep without a saved copy",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", {
    name: "Keep without a saved copy",
    exact: true,
  }).click();
  await expect(
    page.getByRole("button", {
      name: "Keep without a saved copy",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(input).toHaveValue("Keep this edited replacement");
  await expect(page.locator(".otk-messages")).toContainText(
    "Retained native reply.",
  );
  await page.locator(".otk-user-bubble").focus();
  await page.locator('[data-message-command="prompt.revert"]').click();
  await page.getByRole("button", { name: "Confirm revert", exact: true })
    .click();
  await expect(group).toContainText("localStorage is full");
  await input.fill("Keep this edited replacement");
  await page.getByRole("button", { name: "Restore conversation", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Keep without a saved copy",
      exact: true,
    }),
  ).toBeVisible();
  await page.evaluate(() => Reflect.get(globalThis, "restoreCopyStorage")());
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Keep without a saved copy",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(input).toHaveValue("Keep this edited replacement");
  await expect(page.locator(".otk-messages")).toContainText(
    "Retained native reply.",
  );
});

test("revert.dismissed-background-failure-keeps-recovery-and-send-consent", {
  tag: ["@revert", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const source = await state.native<{ id: string }>("/session", "POST", {
    title: "Background copy recovery",
  });
  await openSession(state, page, source.id);
  await state.queue(["The earlier reply is retained."]);
  await prompt(page, "The earlier prompt is retained");
  await expect(page.locator(".otk-messages")).toContainText(
    "The earlier reply is retained.",
  );
  await expect(page.locator(`[data-session="${source.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("otk.branch-history")) {
        throw new DOMException("full", "QuotaExceededError");
      }
      original.call(this, key, value);
    };
  });
  await page.locator(".otk-user-bubble").focus();
  await page.locator('[data-message-command="prompt.revert"]').click();
  await page.getByRole("button", { name: "Confirm revert", exact: true })
    .click();
  await expect(page.locator(".otk-revert-group")).toHaveAttribute(
    "data-phase",
    "failed",
  );
  await page.getByRole("button", { name: "Dismiss revert", exact: true })
    .click();
  const notice = page.locator(".otk-composer-notice");
  await expect(notice.getByRole("button", { name: "Retry", exact: true }))
    .toBeVisible();
  await expect(
    notice.getByRole("button", {
      name: "Keep without a saved copy",
      exact: true,
    }),
  ).toBeVisible();
  await expect(notice).toContainText("localStorage is full");
  await expect(notice).not.toContainText("replacement was not sent");
  await notice.getByRole("button", {
    name: "Keep without a saved copy",
    exact: true,
  }).click();
  expect((await state.product("session.get", { sessionID: source.id })).revert)
    .toBeTruthy();
  const input = page.locator("textarea[name=prompt]");
  await input.fill("Explicit consent is still required");
  await input.press("Enter");
  const choice = page.locator(".otk-permanence-choice");
  await expect(choice.getByRole("button", { name: "Send anyway", exact: true }))
    .toBeVisible();
  await choice.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(input).toHaveValue("Explicit consent is still required");
});
