// SPDX-License-Identifier: LGPL-3.0-only
import type { Page } from "@playwright/test";
import { expect, test } from "../../fixtures/evidence.ts";
import type { Frame } from "../../fixtures/wire.ts";
import {
  cleanup,
  observe,
  open,
  tabs,
  viewport,
} from "../../pages/terminal.ts";

const frame = (page: Page) => page.locator('section[aria-label="Terminal"]');
const dialog = (page: Page) => page.locator('dialog[data-dialog="terminal"]');
const composer = (page: Page) => page.locator(".otk-prompt-actions");
const dock = (page: Page) => page.locator(".otk-composer-surface");
const closeShell = (page: Page) =>
  frame(page).locator(".otk-tabs-item").first().getByRole("button", {
    name: /^Close /,
  }).click();

async function chrome(page: Page, count: number, expanded: boolean) {
  const terminal = frame(page);
  const button = (name: string) =>
    terminal.getByRole("button", { name, exact: true });
  await expect(tabs(page)).toHaveCount(count);
  await expect(terminal).toBeVisible();
  await expect(button(expanded ? "Collapse terminal" : "Expand terminal"))
    .toBeVisible();
  await expect(button("Hide terminal")).toBeVisible();
  await expect(button("New terminal")).toHaveCount(count ? 1 : 2);
  const header = terminal.locator(".otk-surface-title");
  for (
    const name of [
      "New terminal",
      expanded ? "Collapse terminal" : "Expand terminal",
      "Hide terminal",
    ]
  ) {
    await expect(header.getByRole("button", { name, exact: true }))
      .toBeVisible();
  }
  await expect(terminal.getByRole("heading", { name: "Terminal", exact: true }))
    .toHaveCount(expanded ? 0 : 1);
  if (expanded) {
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByRole("heading", { name: "Terminal" }))
      .toBeVisible();
    await expect(dialog(page).getByRole("button", { name: "Close Terminal" }))
      .toBeVisible();
    await expect(dock(page)).toHaveAttribute("hidden", "");
  } else {
    await expect(dialog(page)).toHaveCount(0);
    await expect(dock(page)).toBeVisible();
    await expect(dock(page)).not.toHaveAttribute("hidden", "");
    await expect(composer(page).getByRole("button", { name: "Hide terminal" }))
      .toBeVisible();
    await expect(composer(page).getByRole("button", { name: "Open terminal" }))
      .toHaveCount(0);
  }
  const empty = terminal.getByText("No terminals in this session", {
    exact: true,
  });
  if (count) await expect(empty).toHaveCount(0);
  else {
    await expect(empty).toBeVisible();
    await expect(
      terminal.locator(".otk-surface-body").getByRole("button", {
        name: "New terminal",
        exact: true,
      }),
    ).toBeVisible();
  }
}

for (const mode of ["docked", "expanded"] as const) {
  test(`terminal.dock-chrome.${mode}-2-1-0-1`, {
    tag: "@terminal",
  }, async ({ state, page }) => {
    const wire = observe(page);
    const id = await open(state, page, `Terminal ${mode} chrome`);
    try {
      const expanded = mode === "expanded";
      const terminal = frame(page);
      const expand = terminal.getByRole("button", { name: "Expand terminal" });
      const collapse = terminal.getByRole("button", {
        name: "Collapse terminal",
      });
      if (expanded) await expand.click();
      await chrome(page, 1, expanded);
      await terminal.getByRole("button", { name: "New terminal", exact: true })
        .click();
      await chrome(page, 2, expanded);
      await expect(tabs(page).nth(1)).toHaveAttribute("aria-selected", "true");
      await expect.poll(() => wire.attaches).toBe(2);
      await expect(viewport(page)).toHaveAttribute("aria-label", /\$\s*$/);
      const selected = await terminal.locator(
        '.otk-tabs-panel[data-active="true"] .otk-terminal-mount',
      ).getAttribute("data-terminal");
      expect(selected).toBeTruthy();
      await closeShell(page);
      await chrome(page, 1, expanded);
      await expect(tabs(page).first()).toHaveAttribute("aria-selected", "true");
      await expect(terminal.locator(
        '.otk-tabs-panel[data-active="true"] .otk-terminal-mount',
      )).toHaveAttribute("data-terminal", selected!);
      await closeShell(page);
      await chrome(page, 0, expanded);
      await expect(expanded ? collapse : expand).toBeFocused();
      if (expanded) {
        await collapse.click();
        await chrome(page, 0, false);
        await expand.click();
        await chrome(page, 0, true);
      }
      await terminal.locator(".otk-surface-body").getByRole("button", {
        name: "New terminal",
        exact: true,
      }).click();
      await chrome(page, 1, expanded);
      await expect(viewport(page)).toHaveAttribute("aria-label", /\$\s*$/);
      expect(wire.sockets).toBe(1);
      expect(wire.attaches).toBe(3);
    } finally {
      await cleanup(state, id);
    }
  });
}

test("terminal.dock-chrome.zero-hide-and-reopen", {
  tag: "@terminal",
}, async ({ state, page }) => {
  const id = await open(state, page, "Terminal hide at zero");
  try {
    await closeShell(page);
    await chrome(page, 0, false);
    await frame(page).getByRole("button", { name: "Hide terminal" }).click();
    await expect(frame(page)).toHaveCount(0);
    await composer(page).getByRole("button", { name: "Open terminal" }).click();
    await chrome(page, 1, false);
    await expect(viewport(page)).toHaveAttribute("aria-label", /\$\s*$/);
  } finally {
    await cleanup(state, id);
  }
});

test("terminal.dock-chrome.zero-error-keeps-chrome", {
  tag: "@terminal",
}, async ({ state, page }) => {
  let rejectCreate = false;
  let failCreate: (() => void) | undefined;
  await page.routeWebSocket("**/api/ws", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const request = JSON.parse(message.toString()) as Frame;
      if (
        !rejectCreate || request.t !== "request" ||
        request.method !== "terminal.create"
      ) return server.send(message);
      failCreate = () =>
        socket.send(JSON.stringify({
          t: "request.rejected",
          ref: request.ref,
          error: {
            code: "terminal-unavailable",
            retry: "none",
            diagnosticID: "terminal-chrome-fixture-unavailable",
            facts: { reason: "Terminal host is unavailable" },
          },
        }));
    });
  });
  const id = await open(state, page, "Terminal create error at zero");
  try {
    await closeShell(page);
    await expect(tabs(page)).toHaveCount(0);
    rejectCreate = true;
    const terminal = frame(page);
    const create = terminal.locator(".otk-surface-title").getByRole("button", {
      name: "New terminal",
    });
    await create.click();
    await expect(create).toHaveAttribute("aria-busy", "true");
    await expect(terminal.locator(".otk-surface-body").getByRole("status"))
      .toHaveText("Opening terminal...");
    await expect.poll(() => !!failCreate).toBe(true);
    failCreate!();
    await expect(
      terminal.locator(".otk-surface-body").getByText(
        "Terminal host is unavailable",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(create).toHaveAttribute("aria-busy", "false");
    await chrome(page, 0, false);
  } finally {
    await cleanup(state, id);
  }
});

test("terminal.dock-chrome.replace-expanded-with-commands", {
  tag: "@terminal",
}, async ({ state, page }) => {
  const wire = observe(page);
  const id = await open(state, page, "Replace expanded terminal");
  try {
    await viewport(page).click({ position: { x: 8, y: 8 } });
    await page.keyboard.type("clear; printf 'kept-%s\\n\\n\\n' replacement");
    await page.keyboard.press("Enter");
    await expect(viewport(page)).toHaveAttribute(
      "aria-label",
      /kept-replacement/,
    );
    const expand = frame(page).getByRole("button", { name: "Expand terminal" });
    await expand.click();
    const expanded = dialog(page);
    await expect(expanded.getByRole("textbox", { name: "Terminal input" }))
      .toBeFocused();
    await expanded.getByRole("button", { name: "Close Terminal" }).focus();
    await page.keyboard.press("Control+k");

    const commands = page.getByRole("dialog", {
      name: "Commands",
      exact: true,
    });
    await expect(commands.getByRole("textbox", { name: "Find a command" }))
      .toBeFocused();
    await expect(dock(page)).toBeVisible();
    await expect(dock(page)).not.toHaveAttribute("hidden", "");
    // The composer is visually present, but inert until the modal closes.
    await expect(
      composer(page).getByRole("button", {
        name: "Hide terminal",
        includeHidden: true,
      }),
    ).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(commands).toHaveCount(0);
    await chrome(page, 1, false);
    await expect(expand).toBeFocused();
    await expect(viewport(page)).toHaveAttribute(
      "aria-label",
      /kept-replacement/,
    );
    expect(wire.sockets).toBe(1);
    expect(wire.attaches).toBe(1);
  } finally {
    await cleanup(state, id);
  }
});

test("terminal.dock-chrome.dialog-close-command-collapses", {
  tag: "@terminal",
}, async ({ state, page }) => {
  const wire = observe(page);
  const id = await open(
    state,
    page,
    "Close expanded terminal programmatically",
  );
  try {
    const mount = frame(page).locator(".otk-terminal-mount");
    const terminal = await mount.getAttribute("data-terminal");
    expect(terminal).toBeTruthy();
    await frame(page).getByRole("button", { name: "Expand terminal" }).click();
    await chrome(page, 1, true);
    // Close the native dialog directly, bypassing the X and Escape dismissal.
    await dialog(page).evaluate((node: HTMLDialogElement) => node.close());
    await chrome(page, 1, false);
    await expect(mount).toHaveAttribute("data-terminal", terminal!);
    expect(wire.sockets).toBe(1);
    expect(wire.attaches).toBe(1);
  } finally {
    await cleanup(state, id);
  }
});
