// SPDX-License-Identifier: LGPL-3.0-only
import type { Page } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import type { TestState } from "../../fixtures/test-state.ts";

type Session = { id: string; directory: string };
async function sessions(state: TestState) {
  const a = await state.native<Session>("/session", "POST", {
    title: "First session",
  });
  const b = await state.controller.call<Session>("nativeRequest", {
    lease: state.lease.lease,
    path: "/session",
    method: "POST",
    project: "secondary",
    body: { title: "Second session" },
  });
  await state.product("layout.patch", {
    leftCollapsed: false,
    discoveredCollapsed: false,
  });
  return { a, b };
}

function selected(page: Page, session: Session) {
  return Promise.all([
    expect(page).toHaveURL(new RegExp(`#\\/local/${session.id}$`)),
    expect(page.locator(`[data-crumb=${JSON.stringify(session.id)}]`))
      .toBeVisible(),
  ]);
}

async function openProject(page: Page, session: Session) {
  await page.locator(
    `.otk-project-row[data-project=${
      JSON.stringify(session.directory)
    }] .otk-project-open`,
  ).click();
  await selected(page, session);
}

const tags = { tag: ["@sessions", "@contracts"] };
test("sessions.history-project-click-single-entry", tags, async ({
  isolatedState: state,
  page,
}) => {
  const { a, b } = await sessions(state);
  await page.goto(state.url);
  await openProject(page, a);
  await openProject(page, b);
  await page.goBack();
  await selected(page, a);
  await page.goForward();
  await selected(page, b);
});

test(
  "sessions.history-reload",
  tags,
  async ({ isolatedState: state, page }) => {
    const { a, b } = await sessions(state);
    await page.goto(state.url);
    await openProject(page, a);
    await openProject(page, b);
    await page.reload();
    await selected(page, b);
    await page.goBack();
    await selected(page, a);
    await page.goForward();
    await selected(page, b);
  },
);
