// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { TestState } from "../fixtures/test-state.ts";
import { openSession } from "../fixtures/wire.ts";

export const viewport = (page: Page) =>
  page.locator('.otk-terminal .otk-tabs-panel[data-active="true"] canvas');
export const tabs = (page: Page) =>
  page.getByRole("tablist", { name: "Terminals", exact: true }).getByRole(
    "tab",
  );
export const text = (page: Page) =>
  viewport(page).getAttribute("aria-label").then((value) => value ?? "");

export async function open(state: TestState, page: Page, title: string) {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title,
  });
  await openSession(state, page, session.id);
  await page.getByRole("button", { name: "Open terminal", exact: true })
    .click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(viewport(page)).toBeVisible();
  await expect.poll(() => text(page)).not.toBe("Terminal output");
  return session.id;
}

export async function cleanup(state: TestState, sessionID: string) {
  const list = await state.product("terminal.list", {
    sessionID,
  });
  for (const { id } of list) {
    await state.product("terminal.close", { sessionID, terminalID: id });
  }
}

export function observe(page: Page) {
  const data = {
    sockets: 0,
    attaches: 0,
    detaches: 0,
    input: [] as string[],
    restores: [] as string[],
  };
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname !== "/api/terminal") return;
    data.sockets++;
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload === "string") {
        const message = JSON.parse(payload);
        if (message.t === "snapshot") data.restores.push(message.restore);
      }
    });
    socket.on("framesent", ({ payload }) => {
      if (typeof payload === "string") {
        if (JSON.parse(payload).t === "attach") data.attaches++;
        if (JSON.parse(payload).t === "detach") data.detaches++;
      } else data.input.push(payload.subarray(4).toString("utf8"));
    });
  });
  return data;
}
