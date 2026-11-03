// SPDX-License-Identifier: LGPL-3.0-only
import { expect, type Page } from "@playwright/test";
import type { TestState } from "../fixtures/test-state.ts";
import type { Json } from "../../support/fixture-control.ts";

export const questions = [
  {
    header: "Rendering",
    question: "Choose the output",
    options: [{ label: "Typed", description: "OTK shapes" }, {
      label: "Raw",
      description: "Harness shapes",
    }],
    multiple: false,
  },
  {
    header: "Details",
    question: "Choose details",
    options: [{ label: "Files", description: "Include files" }, {
      label: "Tools",
      description: "Include tools",
    }],
    multiple: true,
  },
];
export const panel = ".otk-question-dock .otk-tabs-panel[data-active=true]";
export const primary = ".otk-question-actions .otk-primary";
export async function seed(state: TestState, title: string, parentID?: string) {
  return await state.native<{ id: string; nativeID: string }>(
    "/session",
    "POST",
    { title, ...(parentID ? { parentID } : {}) },
  );
}
export async function tool(
  state: TestState,
  name: string,
  input: Record<string, Json>,
  target?: "remote",
) {
  await state.controller.call("queueScript", {
    lease: state.lease.lease,
    chunks: [],
    tool: { name, input },
    ...(target ? { target } : {}),
  });
}
export async function prompt(page: Page, text: string) {
  await page.locator("textarea[name=prompt]").fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}
export async function reply(page: Page, id: string, text: string) {
  await expect(page.locator("[data-role=assistant] .otk-text").last())
    .toHaveText(text);
  await expect(page.locator(`[data-session="${id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
}
export async function file(
  state: TestState,
  name: string,
  content: string | null,
  remote = false,
) {
  await expect.poll(async () =>
    (await state.observe<
      {
        files: Record<string, string | null>;
        remoteFiles: Record<string, string | null>;
      }
    >())[remote ? "remoteFiles" : "files"][name]
  ).toBe(content);
}
export async function scenario(
  state: TestState,
  action: "hold" | "release" | "freeze" | "thaw" | "fail" | "succeed",
  sessionID?: string,
) {
  return await state.controller.call("scenario", {
    lease: state.lease.lease,
    action,
    ...(sessionID ? { sessionID } : {}),
  });
}
export async function settings(page: Page) {
  await page.locator(".otk-settings-entry").click();
  await expect(page.locator(".otk-notification-settings")).toBeVisible();
}
export async function closeSettings(page: Page) {
  await page.locator(".otk-settings .otk-view-header button").click();
  await expect(page.locator(".otk-settings")).toHaveCount(0);
}
