// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../fixtures/evidence.ts";
import { isolatedTest as test } from "../fixtures/isolated.ts";
import { openSession } from "../fixtures/wire.ts";
import { prompt } from "../pages/transcript.ts";
import { sessionContext } from "../pages/sessions.ts";

test.use({ profile: "revert-native" });
test(
  "sessions.native-compaction-lifecycle-survives-prompt-independent-context",
  {
    tag: ["@sessions", "@composer"],
  },
  async ({ isolatedState: state, page }, info) => {
    test.setTimeout(120_000);
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Native compaction lifecycle",
      messages: [{ parts: [{ type: "text", text: "Context to summarize" }] }],
    });
    await openSession(state, page, session.id);
    const divider = page.locator(".otk-compaction-divider");
    const capture = async (phase: string) => {
      for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
        await state.product("prefs.set", { key: "theme", value: theme });
        await expect(page.locator("html")).toHaveAttribute(
          "data-otk-theme",
          theme,
        );
        await info.attach(`compaction-${phase}-${theme}`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png",
        });
      }
    };
    const gate = await state.queue([
      "## Objective\n\nA native compaction summary.",
    ], "held");
    await sessionContext(
      page,
      `[data-session="${session.id}"]`,
      "session.compact",
    );
    await page.keyboard.press("Escape");
    await expect(divider).toHaveText("Compacting\u2026");
    await capture("running");
    await state.release(gate.gate);
    await expect(divider).toHaveText("Session compacted");
    await expect(page.locator(".otk-messages")).toContainText(
      "A native compaction summary.",
    );
    if (state.controller.info!.version.startsWith("2.")) {
      await expect(
        page.locator(".otk-user-bubble").filter({
          hasText: "A native compaction summary.",
        }),
      ).toHaveCount(0);
    }
    await expect(page.locator(`[data-session="${session.id}"]`))
      .toHaveAttribute("data-status", "idle");
    await capture("completed");
    await page.reload();
    await expect(divider).toHaveText("Session compacted");
    // V2 reports a native failed compaction record; V1 accepts free-form summaries.
    if (state.controller.info!.version.startsWith("2.")) {
      await state.queue(["Fresh context before failure."]);
      await prompt(page, "Add more context before the next compaction");
      await expect(page.locator(".otk-messages")).toContainText(
        "Fresh context before failure.",
      );
      await expect(page.locator(`[data-session="${session.id}"]`))
        .toHaveAttribute("data-status", "idle");
      await state.queue(["Intentionally invalid native summary."]);
      await state.queue(["Intentionally invalid retry summary."]);
      await sessionContext(
        page,
        `[data-session="${session.id}"]`,
        "session.compact",
      );
      await expect(divider.last()).toHaveText("Compaction failed");
      await expect(page.locator(".otk-messages")).toContainText(
        "Compaction summary did not match the required template",
      );
      await capture("failed");
      await page.reload();
      await expect(divider.last()).toHaveText("Compaction failed");
    }
  },
);
