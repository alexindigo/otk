// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import {
  drawing,
  imagePreview,
  paths,
  plan,
  planLink,
  replyPaths,
  shot,
  startPaths,
  status,
  textPreview,
} from "../../pages/file-paths.ts";
import { cleanup, observe, tabs } from "../../pages/terminal.ts";
import { prompt } from "../../pages/transcript.ts";

test(
  "messages.file-path-linked-forms",
  { tag: "@messages" },
  async ({ state, page }) => {
    const id = await replyPaths(state, page);
    await expect(status(page, id)).toHaveAttribute("data-status", "idle");
    await expect(paths(page)).toHaveCount(3);
    for (
      const [label, destination] of [[shot(state), shot(state)], [
        "notes/plan.md:2-3",
        `${state.directory}/notes/plan.md`,
      ], ["the plan", `${state.directory}/notes/plan.md`]]
    ) {
      const link = page.getByRole("button", { name: label, exact: true });
      await expect(link).toHaveAccessibleDescription("Opens a preview");
      expect(await link.getAttribute("title")).toMatch(/^\//);
      expect(await link.getAttribute("title")).toContain(destination);
    }
    await expect(page.locator(".otk-code-block")).toContainText(shot(state));
    await expect(page.locator(".otk-code-block .otk-path-link")).toHaveCount(0);
  },
);

test(
  "messages.file-path-text-preview",
  { tag: "@messages" },
  async ({ state, page }) => {
    await replyPaths(state, page);
    const link = planLink(page), dialog = await textPreview(page);
    await expect(dialog.locator("code")).toHaveJSProperty("textContent", plan);
    expect(
      await dialog.locator(".otk-code-numbers .is-marked").allTextContents(),
    ).toEqual(["2", "3"]);
    for (const label of ["Copy path", "Open folder in terminal"]) {
      await expect(
        dialog.getByRole("button", { name: label }),
      ).toBeVisible();
    }
    await expect(dialog.getByRole("button", { name: "Open preview" }))
      .toHaveCount(0);
    const close = dialog.getByRole("button", { name: /^Close / });
    const geometry = await close.evaluate((button) => {
      const control = button.getBoundingClientRect();
      const frame = button.closest("dialog")!.getBoundingClientRect();
      const probe = document.createElement("span");
      probe.style.cssText = "position:absolute;inline-size:var(--control-size)";
      button.append(probe);
      const size = probe.getBoundingClientRect().width;
      probe.remove();
      return {
        height: control.height,
        width: control.width,
        size,
        insetDifference: Math.abs(
          control.top - frame.top -
            (frame.right - control.right),
        ),
      };
    });
    expect.soft(geometry.width).toBeCloseTo(geometry.size, 1);
    expect.soft(geometry.height).toBeCloseTo(geometry.size, 1);
    expect.soft(geometry.insetDifference).toBeLessThanOrEqual(1);
    await expect(close.locator("svg")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(link).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(link).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await close.click();
    await expect(link).toBeFocused();
  },
);

test(
  "messages.file-path-image-preview",
  { tag: "@messages" },
  async ({ state, page }) => {
    await replyPaths(state, page);
    const dialog = await imagePreview(state, page);
    const src = await dialog.locator("img").getAttribute("src");
    expect(src).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(Buffer.from(src!.split(",")[1], "base64").toString()).toBe(drawing);
  },
);

test(
  "messages.file-path-other-actions",
  { tag: "@messages" },
  async ({ state, page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await replyPaths(state, page, "File: `data/blob.bin`");
    const link = page.getByRole("button", {
      name: "data/blob.bin",
      exact: true,
    });
    await expect(link).toHaveAccessibleDescription("Shows file actions");
    await link.click();
    const menu = page.getByRole("menu", { name: "Context menu" });
    await expect(menu.getByRole("menuitem").nth(0)).toHaveAccessibleName(
      "Copy path",
    );
    await expect(menu.getByRole("menuitem").nth(1)).toHaveAccessibleName(
      "Open folder in terminal",
    );
    await expect(menu.getByRole("menuitem", { name: "Open preview" }))
      .toHaveCount(0);
    await menu.getByRole("menuitem", { name: "Copy path" }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(`${state.directory}/data/blob.bin`);
  },
);

test("messages.file-path-open-folder-terminal", {
  tag: ["@messages", "@terminal"],
}, async ({ state, page }) => {
  const wire = observe(page);
  const id = await replyPaths(state, page);
  try {
    await planLink(page).click({ button: "right" });
    await page.getByRole("menuitem", {
      name: "Open folder in terminal",
      exact: true,
    }).click();
    await expect(tabs(page)).toHaveCount(1);
    const cd = `cd -- '${state.directory}/notes'`;
    // The shell may have enabled bracketed paste by the time the dock attaches.
    const submitted = [
      `${cd}\r`,
      `\x1b[200~${cd}\x1b[201~\r`,
    ];
    await expect.poll(() => submitted.includes(wire.input.join(""))).toBe(true);
  } finally {
    await cleanup(state, id);
  }
});

test(
  "messages.file-path-checked-once-after-streaming",
  { tag: "@messages" },
  async ({ state, page }) => {
    const requests: string[][] = [];
    page.on("websocket", (socket) => {
      if (new URL(socket.url()).pathname !== "/api/ws") return;
      socket.on("framesent", ({ payload }) => {
        if (typeof payload !== "string") return;
        const frame = JSON.parse(payload);
        if (frame.method === "file.stat") requests.push(frame.params.paths);
      });
    });
    const id = await startPaths(state, page);
    const { gate } = await state.controller.call<{ gate: string }>(
      "queueScript",
      {
        lease: state.lease.lease,
        chunks: [
          "`notes/plan.md` `shots/a.svg` `data/blob.bin` `notes/gone.md`",
          ...Array(19).fill(" waiting"),
        ],
        delay: 40,
        gate: "held",
      },
    );
    try {
      await prompt(page, "Stream the paths");
      await expect(status(page, id)).toHaveAttribute("data-status", "busy");
      await expect(page.getByText("notes/plan.md", { exact: true }))
        .toBeVisible();
      expect(requests).toEqual([]);
    } finally {
      await state.release(gate);
    }
    await expect(status(page, id)).toHaveAttribute("data-status", "idle");
    await expect(paths(page)).toHaveCount(3);
    expect(requests).toEqual([[
      "notes/plan.md",
      "shots/a.svg",
      "data/blob.bin",
      "notes/gone.md",
    ]]);
    await page.getByRole("button", { name: "data/blob.bin", exact: true })
      .focus();
    await page.keyboard.press("Tab");
    expect(requests).toHaveLength(1);
  },
);

test(
  "messages.file-path-user-prompt",
  { tag: "@messages" },
  async ({ state, page }) => {
    const id = await startPaths(state, page);
    await state.queue(["Here it is."]);
    await prompt(page, `Show \`${shot(state)}\``);
    await expect(page.getByRole("button", { name: shot(state), exact: true }))
      .toBeVisible();
    await expect(page.getByText("Here it is.", { exact: true })).toBeVisible();
    await expect(status(page, id)).toHaveAttribute("data-status", "idle");
  },
);
