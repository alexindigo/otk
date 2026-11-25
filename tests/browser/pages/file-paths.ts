// SPDX-License-Identifier: LGPL-3.0-only
import { expect, type Page } from "@playwright/test";
import type { TestState } from "../fixtures/test-state.ts";
import { openSession } from "../fixtures/wire.ts";
import { prompt } from "./transcript.ts";

export const plan =
  "# Release plan\n\n- Check the preview\n- Review the screenshots\n- Confirm the path";
export const drawing =
  '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="200" viewBox="0 0 360 200"><rect width="360" height="200" rx="12" fill="#203b46"/><circle cx="270" cy="60" r="24" fill="#ecc689"/><path d="M0 190 105 65 175 139 219 96 360 190V200H0Z" fill="#76ab9c"/></svg>';
export const paths = (page: Page) => page.locator(".otk-path-link");
export const planLink = (page: Page) =>
  page.getByRole("button", { name: "notes/plan.md:2-3", exact: true });
export const shot = (state: TestState) => `${state.directory}/shots/a.svg`;
export const status = (page: Page, id: string) =>
  page.locator(`[data-session="${id}"]`);
export const transcript = (state: TestState) =>
  `See ${
    shot(state)
  } for the image.\n\nReview \`notes/plan.md:2-3\` or [the plan](notes/plan.md). Missing: \`notes/gone.md\`, [credentials](.envrc) and \`../../etc/hostname\`.\n\n\`\`\`text\n${
    shot(state)
  }\n\`\`\``;

export async function startPaths(state: TestState, page: Page) {
  await state.controller.call("writeProjectFiles", {
    lease: state.lease.lease,
    files: {
      "notes/plan.md": plan,
      "shots/a.svg": drawing,
      "data/blob.bin": "not\0text",
      ".envrc": "export FIXTURE=not-a-secret",
    },
  });
  const { id } = await state.native<{ id: string }>("/session", "POST", {
    title: "File paths",
  });
  await openSession(state, page, id);
  return id;
}

export async function replyPaths(
  state: TestState,
  page: Page,
  body = transcript(state),
  afterOpen?: () => Promise<void>,
) {
  const id = await startPaths(state, page);
  await afterOpen?.();
  await state.queue([body]);
  await prompt(page, "Show the release files");
  return id;
}

export async function textPreview(page: Page) {
  await planLink(page).click();
  const dialog = page.getByRole("dialog", { name: "plan.md", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function imagePreview(state: TestState, page: Page) {
  await page.getByRole("button", { name: shot(state), exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "a.svg", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
