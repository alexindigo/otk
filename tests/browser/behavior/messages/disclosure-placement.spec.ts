// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import {
  prompt,
  settledNativeReply,
  toolScript,
} from "../../pages/transcript.ts";

test.use({ profile: "messages-forms" });

test("messages.work-panel-fold-intent-stays-on-its-surface", {
  tag: ["@messages", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await page.setViewportSize({ width: 1560, height: 1100 });
  const { id } = await state.native<{ id: string }>("/session", "POST", {
    title: "Work panel fold placement",
  });
  await openSession(state, page, id);
  const answer = "I printed the marker.";
  await toolScript(state, "bash", {
    command: "echo retained-marker",
    description: "Print the retained marker",
  }, answer);
  await prompt(page, "Print the marker.");
  await settledNativeReply(state, id, answer);
  await state.product("layout.patch", {
    rightView: "work",
    rightCollapsed: false,
  });
  await page.goto(state.url);
  await page.reload();
  await page.goto(`${state.url}/#/local/${id}`);

  const panel = page.getByRole("tabpanel", { name: "Work log" });
  const transcript = page.getByRole("region", {
    name: "Transcript",
    exact: true,
  });
  const log = transcript.locator(".otk-work-fold");
  const panelTool = panel.getByRole("button", {
    name: "Print the retained marker",
    exact: true,
  });
  const transcriptTool = transcript.locator(
    "[data-tool=bash] .otk-tool-toggle",
  );
  await expect(log).toHaveAttribute("aria-expanded", "false");
  await expect(panelTool).toHaveAttribute("aria-expanded", "false");
  await panelTool.press("ArrowRight");
  await expect(panelTool).toHaveAttribute("aria-expanded", "true");
  await expect(log).toHaveAttribute("aria-expanded", "false");
  await log.press("ArrowRight");
  await expect(transcriptTool).toHaveAttribute("aria-expanded", "false");

  await panelTool.press("ArrowLeft");
  await transcriptTool.press("ArrowRight");
  await expect(transcriptTool).toHaveAttribute("aria-expanded", "true");
  await expect(panelTool).toHaveAttribute("aria-expanded", "false");
});
