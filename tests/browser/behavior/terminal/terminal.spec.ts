// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { messages, prompt } from "../../pages/composer.ts";
import { send } from "../../pages/primary-action.ts";
import { nativeIdle } from "../../pages/transcript.ts";
import {
  cleanup,
  observe,
  open,
  tabs,
  text,
  viewport,
} from "../../pages/terminal.ts";
import type { Page } from "@playwright/test";

// Read the renderer, including offscreen scrollback, through its native wheel
// and accessibility ports. No private renderer state or clipboard is consulted.
async function screenAndScrollback(page: Page): Promise<string> {
  const bar = page.getByRole("scrollbar", {
    name: "Terminal scrollback",
    exact: true,
  });
  const rows = [await text(page)];
  await viewport(page).hover();
  while (
    await bar.isVisible() && Number(await bar.getAttribute("aria-valuenow")) > 0
  ) {
    const previous = Number(await bar.getAttribute("aria-valuenow"));
    await page.mouse.wheel(0, -400);
    await expect.poll(async () =>
      Number(await bar.getAttribute("aria-valuenow"))
    ).toBeLessThan(previous);
    rows.unshift(await text(page));
  }
  if (await bar.isVisible()) {
    await page.mouse.wheel(0, 10000000);
    // A canonical resize can settle during the gesture. Bottom is the live
    // position/max pair, not a maximum captured under the preceding grid.
    await expect.poll(() =>
      bar.evaluate((node) =>
        Number(node.getAttribute("aria-valuenow")) ===
          Number(node.getAttribute("aria-valuemax"))
      )
    ).toBe(true);
  }
  return rows.join("\n");
}
async function command(page: Page, value: string) {
  await viewport(page).click({ position: { x: 8, y: 8 } });
  await page.keyboard.type(value);
  await page.keyboard.press("Enter");
}

// Focus the input directly after reconnect. Clicking a live full-screen app
// sends mouse bytes; btop 1.3.2 can consume a following key in the same read.
function quitRestoredBtop(page: Page) {
  return page.getByRole("textbox", { name: "Terminal input", exact: true })
    .press("q");
}

test("terminal.repeated-lag-shows-disconnected-and-explicit-reconnect", {
  tag: "@terminal",
}, async ({ state, page }, evidence) => {
  let lag: () => void = () => {
    throw new Error("Terminal socket not ready");
  };
  let snapshots = 0;
  await page.routeWebSocket("**/api/terminal", (socket) => {
    const server = socket.connectToServer();
    let channel = 0;
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (typeof message === "string") {
        const frame = JSON.parse(message);
        if (frame.t === "snapshot") {
          channel = frame.ch;
          snapshots++;
        }
      }
      socket.send(message);
    });
    lag = () =>
      socket.send(
        JSON.stringify({ t: "detached", ch: channel, reason: "lagging" }),
      );
    socket.onClose(() => server.close());
    server.onClose(() => socket.close());
  });
  const id = await open(state, page, "Terminal reconnect");
  try {
    await command(page, "printf 'kept-%s\\n' output");
    await expect(viewport(page)).toHaveAttribute("aria-label", /kept-output/);
    lag();
    await expect.poll(() => snapshots).toBe(2);
    lag();
    const reconnect = page.getByRole("button", {
      name: "Reconnect",
      exact: true,
    });
    await expect(
      page.getByRole("status").filter({ hasText: "Terminal disconnected" }),
    ).toBeVisible();
    await expect(reconnect).toBeVisible();
    // The stale canvas is not an apparently usable input target.
    await expect(page.locator(".otk-terminal-mount")).toHaveAttribute(
      "inert",
      "",
    );
    expect(
      await page.locator(".otk-ghostty-input").evaluate((input) => {
        (input as HTMLElement).focus();
        return document.activeElement === input;
      }),
    ).toBe(false);
    for (const theme of ["otk-dark", "otk-light"]) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await expect(reconnect).toBeVisible();
      expect(
        await reconnect.evaluate((button) => {
          const action = button.getBoundingClientRect();
          const label = button.previousElementSibling!.getBoundingClientRect();
          return Math.abs(
            action.y + action.height / 2 - label.y - label.height / 2,
          );
        }),
      ).toBeLessThan(0.5);
      await evidence.attach("terminal-disconnected-" + theme, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    }
    await reconnect.click();
    await expect.poll(() => snapshots).toBe(3);
    await expect(reconnect).toHaveCount(0);
    await command(page, "printf 'reconnected-%s\\n' shell");
    await expect(viewport(page)).toHaveAttribute(
      "aria-label",
      /reconnected-shell/,
    );
    lag();
    await expect.poll(() => snapshots).toBe(4);
    lag();
    await expect(reconnect).toBeVisible();
    await tabs(page).first().click();
    await expect.poll(() => snapshots).toBe(5);
    await expect(reconnect).toHaveCount(0);
  } finally {
    await cleanup(state, id);
  }
});

test(
  "terminal.shell-commands-colours-and-composer-entry",
  { tag: "@terminal" },
  async ({ state, page }) => {
    const id = await open(state, page, "Terminal shell");
    try {
      await expect(
        page.getByRole("region", { name: "Terminal", exact: true }),
      ).toBeVisible();
      const attach = await page.getByRole("button", {
        name: "Attach files",
        exact: true,
      }).boundingBox();
      const terminal = await page.locator(".otk-composer").getByRole("button", {
        name: "Hide terminal",
        exact: true,
      }).boundingBox();
      expect(terminal!.x).toBeGreaterThanOrEqual(attach!.x + attach!.width);
      expect(
        Math.abs(
          terminal!.y + terminal!.height / 2 - attach!.y - attach!.height / 2,
        ),
      ).toBeLessThan(1);
      await command(
        page,
        "ls -la --color=always /usr/bin | head -40; printf '\\npilot-list-%s\\n' finished",
      );
      await expect(viewport(page)).toHaveAttribute(
        "aria-label",
        /pilot-list-finished/,
      );
      const colourful = await viewport(page).evaluate((canvas) => {
        const c = canvas as HTMLCanvasElement,
          pixels =
            c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        let count = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (
            Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) -
                Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 40
          ) count++;
        }
        return count;
      });
      expect(colourful).toBeGreaterThan(100);
      await command(page, "cd /usr/../home && pwd");
      await expect(viewport(page)).toHaveAttribute("aria-label", /\n\/home\n/);
      await command(page, "echo $TERM $COLORTERM");
      await expect(viewport(page)).toHaveAttribute(
        "aria-label",
        /xterm-256color truecolor/,
      );
    } finally {
      await cleanup(state, id);
    }
  },
);

test("terminal.less-forward-back-search-and-main-screen-return", {
  tag: "@terminal",
}, async ({ state, page }) => {
  const id = await open(state, page, "Terminal less");
  try {
    await command(page, "printf 'before-%s\\n' less");
    await expect(viewport(page)).toHaveAttribute("aria-label", /before-less/);
    await command(page, "seq 1 5000 | less");
    await expect.poll(() => text(page)).toMatch(/^1\n2\n/);
    await page.keyboard.press("Space");
    await expect.poll(() => text(page)).not.toMatch(/^1\n2\n/);
    await page.keyboard.press("b");
    await expect.poll(() => text(page)).toMatch(/^1\n2\n/);
    await page.keyboard.type("/4321");
    await page.keyboard.press("Enter");
    await expect(viewport(page)).toHaveAttribute("aria-label", /4321/);
    await page.keyboard.press("q");
    await expect(viewport(page)).toHaveAttribute("aria-label", /before-less/);
    await command(page, "printf 'less-%s\\n' returned");
    await expect(viewport(page)).toHaveAttribute("aria-label", /less-returned/);
  } finally {
    await cleanup(state, id);
  }
});

test(
  "terminal.retained-tabs-one-shared-socket-selection-to-transcript-and-close",
  { tag: "@terminal" },
  async ({ state, page }) => {
    // Exercise the non-rounded advance retained by the renderer, not a lucky
    // integer-width font installed in this particular browser image.
    await page.addInitScript(() => {
      const measure = CanvasRenderingContext2D.prototype.measureText;
      CanvasRenderingContext2D.prototype.measureText = function (text) {
        const metrics = measure.call(this, text);
        if (text === "M") {
          Object.defineProperty(metrics, "width", { value: 7.2 });
        }
        return metrics;
      };
    });
    const wire = observe(page), id = await open(state, page, "Terminal tabs");
    try {
      await command(page, "printf 'terminal-%s\\n' one");
      await expect(viewport(page)).toHaveAttribute(
        "aria-label",
        /terminal-one/,
      );
      await page.getByRole("button", { name: "New terminal", exact: true })
        .click();
      await expect(tabs(page)).toHaveCount(2);
      await command(page, "printf 'terminal-%s\\n' two");
      await expect(viewport(page)).toHaveAttribute(
        "aria-label",
        /terminal-two/,
      );
      await tabs(page).nth(0).click();
      await expect(viewport(page)).toHaveAttribute(
        "aria-label",
        /terminal-one/,
      );
      expect(wire.sockets).toBe(1);
      expect(wire.attaches).toBe(2);
      await command(
        page,
        "printf '\\033[3J\\033[2J\\033[Hterminal-```-selected-output\\r\\n'",
      );
      await expect.poll(() => text(page)).toMatch(
        /^terminal-```-selected-output\n/,
      );
      const measured = await viewport(page).evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        return {
          box: canvas.getBoundingClientRect().toJSON(),
          cell: canvas.getContext("2d")!.measureText("M").width,
        };
      });
      expect(measured.cell).toBe(7.2);
      const canvas = measured.box;
      await page.mouse.move(canvas.x + 4 + measured.cell / 2, canvas.y + 12);
      await page.mouse.down();
      await page.mouse.move(
        canvas.x + 4 + 27.5 * measured.cell,
        canvas.y + 12,
        {
          steps: 15,
        },
      );
      await page.mouse.up();
      await expect(
        page.getByRole("button", { name: "Add to prompt", exact: true }),
      ).toBeVisible();
      await viewport(page).click({
        button: "right",
        position: { x: 80, y: 12 },
      });
      await expect(
        page.getByRole("menuitem", { name: "Add to prompt", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator(".otk-context-menu:visible")).toHaveCount(0);
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            readText: () => {
              throw new Error("Clipboard is not part of Add to prompt");
            },
            writeText: () => {
              throw new Error("Clipboard is not part of Add to prompt");
            },
          },
        });
      });
      await page.getByRole("button", { name: "Add to prompt", exact: true })
        .click();
      await expect(page.locator(".otk-prompt-chip")).toContainText(
        "Terminal:",
      );
      await expect(prompt(page)).toBeFocused();
      // Give the transcript its viewport back before asserting virtualized rows.
      await page.locator(".otk-composer").getByRole("button", {
        name: "Hide terminal",
        exact: true,
      })
        .click();
      await state.queue(["Terminal selection received."]);
      await send(page).click();
      await expect(page.locator("[data-role=user]")).toContainText(
        "terminal-```-selected-output",
      );
      await expect.poll(async () =>
        (await messages(state, id)).filter((row) => row.info.role === "user")
          .flatMap((row) => row.parts).filter((part) => part.type === "text")
          .map((part) => part.text).join("\n")
      ).toContain("````text\nterminal-```-selected-output\n````");
      // Observe the delivered reply and native completion independently of which
      // right-panel view is mounted.
      await expect(
        page.locator("[data-role=assistant] .otk-text").filter({
          hasText: "Terminal selection received.",
        }),
      ).toHaveText("Terminal selection received.");
      await nativeIdle(state, id);
      await expect(page.locator(".otk-response-progress")).toHaveCount(0);
      await expect.poll(async () =>
        (await state.observe<{ active: number }>()).active
      ).toBe(0);
      const list = await state.product("terminal.list", {
        sessionID: id,
      });
      await page.getByRole("button", { name: "Open terminal", exact: true })
        .click();
      await expect(tabs(page)).toHaveCount(2);
      await page.locator(".otk-terminal .otk-tabs-item").nth(1).getByRole(
        "button",
        { name: /^Close / },
      ).click();
      await expect(tabs(page)).toHaveCount(1);
      await expect.poll(async () =>
        (await state.product("terminal.list", {
          sessionID: id,
        })).map((info) => info.id)
      ).not.toContain(list[1].id);
      expect(wire.sockets).toBe(1);
    } finally {
      await cleanup(state, id);
    }
  },
);

test("terminal.concealed-output-is-not-exposed-in-accessible-text", {
  tag: "@terminal",
}, async ({ state, page }) => {
  const id = await open(state, page, "Terminal concealment");
  try {
    await command(page, "stty -echo");
    await command(
      page,
      "printf '\\033[3J\\033[2J\\033[H\\033[8mconcealed-sentinel\\033[0m visible-%s\\n' marker; stty echo",
    );
    await expect(viewport(page)).toHaveAttribute(
      "aria-label",
      /visible-marker/,
    );
    await expect(viewport(page)).not.toHaveAttribute(
      "aria-label",
      /concealed-sentinel/,
    );
  } finally {
    await cleanup(state, id);
  }
});

test("terminal.large-output-completes-and-page-remains-interactive", {
  tag: "@terminal",
}, async ({ state, page }) => {
  const id = await open(state, page, "Terminal output");
  try {
    await command(page, "seq 1 200000");
    await expect(viewport(page)).toHaveAttribute("aria-label", /\n200000\n/, {
      timeout: 30_000,
    });
    await command(page, "printf 'responsive-%s\\n' terminal");
    await expect(viewport(page)).toHaveAttribute(
      "aria-label",
      /responsive-terminal/,
    );
    await page.getByRole("button", { name: "New terminal", exact: true })
      .click();
    await expect(tabs(page)).toHaveCount(2);
  } finally {
    await cleanup(state, id);
  }
});

test(
  "terminal.generated-replies-suppressed-and-focused-context-keys-follow-pinned-encoder",
  { tag: "@terminal" },
  async ({ state, page }) => {
    const wire = observe(page),
      id = await open(state, page, "Terminal input ownership");
    try {
      // Like the integration probe, consume the daemon's reply in the requester,
      // rather than leaving that reply in the interactive shell's next line.
      await command(
        page,
        "stty -echo; printf '\\033[6n'; IFS= read -r -d R -t 2 reply; stty echo; printf '\\nquery-%s\\n' done",
      );
      await expect(viewport(page)).toHaveAttribute("aria-label", /query-done/);
      expect(
        // deno-lint-ignore no-control-regex -- Assert no browser-generated cursor response.
        /\x1b\[\d+;\d+R/.test(wire.input.join("")),
      ).toBe(false);
      const before = wire.input.length;
      await page.keyboard.press("ContextMenu");
      await expect(page.locator(".otk-context-menu:visible")).toHaveCount(0);
      expect(wire.input.length).toBe(before);
      // This next encoded key is an ordered wire barrier: no ContextMenu frame
      // may precede it, and the pinned encoder's exact Shift+F10 bytes arrive.
      await page.keyboard.press("Shift+F10");
      await expect.poll(() => wire.input.slice(before)).toEqual(["\x1b[21;2~"]);
      await expect(page.locator(".otk-context-menu:visible")).toHaveCount(0);
      const escaped = wire.input.length;
      await page.keyboard.press("Escape");
      await expect.poll(() => wire.input.slice(escaped)).toEqual(["\x1b"]);
      await expect(
        page.getByRole("region", { name: "Terminal", exact: true }),
      ).toBeVisible();
    } finally {
      await cleanup(state, id);
    }
  },
);

test(
  "terminal.btop-full-screen-panels-and-quit",
  { tag: "@terminal" },
  async ({ state, page }) => {
    const id = await open(state, page, "Terminal btop");
    try {
      await command(page, "printf 'before-%s\\n' btop");
      await expect(viewport(page)).toHaveAttribute("aria-label", /before-btop/);
      await command(page, "btop");
      await expect(viewport(page)).toHaveAttribute("aria-label", /cpu/i);
      await expect(viewport(page)).toHaveAttribute("aria-label", /mem/i);
      await expect(viewport(page)).not.toHaveAttribute(
        "aria-label",
        /Terminal size too small/,
      );
      await page.keyboard.press("q");
      // Wait for main-screen restoration, including mouse-reporting reset,
      // before the next command's pointer activation.
      await expect(viewport(page)).toHaveAttribute("aria-label", /before-btop/);
      await command(page, "printf 'btop-%s\\n' returned");
      await expect(viewport(page)).toHaveAttribute(
        "aria-label",
        /btop-returned/,
      );
    } finally {
      await cleanup(state, id);
    }
  },
);

test("terminal.composer-toggle-detaches-without-closing-the-shell", {
  tag: "@terminal",
}, async ({ state, page }) => {
  const wire = observe(page), id = await open(state, page, "Terminal toggle");
  try {
    await command(page, "printf 'retained-%s\\n' shell");
    await expect(viewport(page)).toHaveAttribute(
      "aria-label",
      /retained-shell/,
    );
    const before = await state.product("terminal.list", { sessionID: id });
    await page.locator(".otk-composer").getByRole("button", {
      name: "Hide terminal",
      exact: true,
    })
      .click();
    await expect(page.getByRole("region", { name: "Terminal", exact: true }))
      .toHaveCount(0);
    await expect.poll(() => wire.detaches).toBe(1);
    expect(
      (await state.product("terminal.list", { sessionID: id })).map((info) =>
        info.id
      ),
    ).toEqual(before.map((info) => info.id));
    await page.getByRole("button", { name: "Open terminal", exact: true })
      .click();
    await expect(viewport(page)).toHaveAttribute(
      "aria-label",
      /retained-shell/,
    );
    await page.locator(".otk-terminal").getByRole("button", {
      name: "Hide terminal",
      exact: true,
    })
      .click();
    await expect(page.getByRole("region", { name: "Terminal", exact: true }))
      .toHaveCount(0);
    await expect.poll(() => wire.detaches).toBe(2);
    expect(wire.sockets).toBe(1);
  } finally {
    await cleanup(state, id);
  }
});

for (
  const size of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }]
) {
  test(`terminal.dock-and-editor-geometry-${size.width}x${size.height}`, {
    tag: "@terminal",
  }, async ({ state, page }) => {
    await page.setViewportSize(size);
    const id = await open(state, page, "Terminal geometry");
    try {
      const hide = page.locator(".otk-terminal").getByRole("button", {
        name: "Hide terminal",
        exact: true,
      });
      await expect(hide).toHaveAttribute("title", "Hide terminal");
      await expect(hide.locator("svg path")).toHaveAttribute(
        "d",
        "m6 9 6 6 6-6",
      );
      // Native shell titles can contain an arbitrarily long working directory.
      // Keep tab selection, its close control and header actions reachable.
      const title = "terminal-long-title-".repeat(24);
      // The fixture natives start Bash with different prompt initialization.
      // Replace PS1's title escape too, so its next prompt cannot overwrite OSC.
      await command(
        page,
        `PS1='geometry$ '; printf '\\033]0;%s\\007' '${title}'`,
      );
      await expect(tabs(page).first()).toHaveAttribute("title", title);
      await expect.poll(() =>
        page.evaluate(() => {
          const box = document.querySelector(".otk-terminal")!
            .getBoundingClientRect();
          const composer = document.querySelector(".otk-composer")!
            .getBoundingClientRect();
          const transcript = document.querySelector(".otk-transcript-viewport")!
            .getBoundingClientRect();
          return {
            aligned: Math.abs(box.left - composer.left) <= .5 &&
              Math.abs(box.right - composer.right) <= .5,
            height:
              Math.abs(box.height - Math.round(innerHeight * 2 / 3)) <= .5 ||
              transcript.height <= .5,
            flow: box.bottom <= composer.top + .5 && composer.top >= 0 &&
              composer.bottom <= innerHeight + .5,
          };
        })
      ).toEqual({ aligned: true, height: true, flow: true });
      await page.getByRole("button", { name: "Edit prompt", exact: true })
        .click();
      const editor = page.getByRole("dialog", {
        name: "Edit prompt",
        exact: true,
      });
      await expect(editor).toBeVisible();
      const expected = await editor.boundingBox();
      await editor.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(editor).toHaveCount(0);
      await expect.poll(() =>
        page.locator(".otk-terminal .otk-tabs-header button").evaluateAll((
          buttons,
        ) =>
          buttons.every((button) => {
            const rect = button.getBoundingClientRect();
            return button.contains(
              document.elementFromPoint(
                rect.x + rect.width / 2,
                rect.y + rect.height / 2,
              ),
            );
          })
        )
      ).toBe(true);
      await page.getByRole("button", { name: "Expand terminal", exact: true })
        .click();
      const expanded = page.getByRole("dialog", {
        name: "Terminal",
        exact: true,
      });
      await expect(expanded).toBeVisible();
      await expect.poll(async () => {
        const actual = await expanded.boundingBox();
        return !!actual && !!expected &&
          ["x", "y", "width", "height"].every((key) =>
            Math.abs(
              actual[key as keyof typeof actual] -
                expected[key as keyof typeof expected],
            ) <= .5
          );
      }).toBe(true);
      await expect(page.locator(".otk-composer-surface")).toBeHidden();
      await expect(
        expanded.getByRole("textbox", { name: "Terminal input", exact: true }),
      ).toBeFocused();
      await expanded.getByRole("button", {
        name: "Collapse terminal",
        exact: true,
      }).click();
      await expect(expanded).toHaveCount(0);
      await expect(
        page.getByRole("textbox", { name: "Terminal input", exact: true }),
      ).toBeFocused();
      // The generic host has no per-dialog close label. Its existing Close
      // control still collapses this feature, without terminating its shell.
      await page.getByRole("button", { name: "Expand terminal", exact: true })
        .click();
      await expect(expanded).toBeVisible();
      await expanded.getByRole("button", {
        name: "Close Terminal",
        exact: true,
      }).click();
      await expect(expanded).toHaveCount(0);
      await expect(
        page.getByRole("textbox", { name: "Terminal input", exact: true }),
      ).toBeFocused();
      expect(await state.product("terminal.list", { sessionID: id }))
        .toHaveLength(1);
    } finally {
      await cleanup(state, id);
    }
  });
}

test("terminal.expand-collapse-retains-renderer-channel-and-escape-ownership", {
  tag: "@terminal",
}, async ({ state, page }) => {
  // Checkpoint reset now replaces the engine. Observe its real constructor,
  // without adding a product-only port, to detect any destructive restore.
  await page.addInitScript(() => {
    const instantiate = WebAssembly.instantiate;
    let engines = 0;
    Object.defineProperty(globalThis, "__terminalEngines", {
      get: () => engines,
    });
    Object.defineProperty(WebAssembly, "instantiate", {
      value: async (...args: unknown[]) => {
        const result = await Reflect.apply(instantiate, WebAssembly, args);
        const instance = result instanceof WebAssembly.Instance
          ? result
          : result.instance;
        if (typeof instance.exports.ghostty_terminal_new !== "function") {
          return result;
        }
        const exports = {
          ...instance.exports,
          ghostty_terminal_new: (...values: unknown[]) => {
            engines++;
            return Reflect.apply(
              instance.exports.ghostty_terminal_new as CallableFunction,
              undefined,
              values,
            );
          },
        };
        const observed = new Proxy(instance, {
          get: (target, key) =>
            key === "exports" ? exports : Reflect.get(target, key, target),
        });
        return result instanceof WebAssembly.Instance
          ? observed
          : { ...result, instance: observed };
      },
    });
  });
  const wire = observe(page),
    id = await open(state, page, "Terminal expansion");
  try {
    // Preserve the real wrapped prompt. Its resize redraw may erase adjacent
    // rows, so put the sentinel safely above that documented shell-owned area.
    await command(
      page,
      "printf 'before-%s\\n' expansion; for i in $(seq 1 80); do printf 'expansion-filler-%s\\n' $i; done",
    );
    await expect(viewport(page)).toHaveAttribute(
      "aria-label",
      /expansion-filler-80/,
    );
    expect(await screenAndScrollback(page)).toContain("before-expansion");
    const engines = await page.evaluate(() =>
      Reflect.get(globalThis, "__terminalEngines")
    );
    expect(engines).toBeGreaterThan(0);
    const terminalID =
      (await state.product("terminal.list", { sessionID: id }))[0].id;
    await page.getByRole("button", { name: "Expand terminal", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Terminal", exact: true });
    await expect(dialog).toBeVisible();
    expect(await screenAndScrollback(page)).toContain("before-expansion");
    await expect(
      dialog.getByRole("textbox", { name: "Terminal input", exact: true }),
    ).toBeFocused();
    await command(page, "seq 1 5000 | less");
    await expect.poll(() => text(page)).toMatch(/^1\n2\n/);
    const before = wire.input.length;
    await page.keyboard.press("Escape");
    await expect.poll(() => wire.input.slice(before)).toEqual(["\x1b"]);
    await expect(dialog).toBeVisible();
    // Escape starts a less command prefix; cancel that prefix before quitting.
    await page.keyboard.press("Control+c");
    await page.keyboard.press("q");
    await expect(viewport(page)).toHaveAttribute("aria-label", /\$\s*$/);
    expect(await screenAndScrollback(page)).toContain("before-expansion");
    await dialog.getByRole("button", { name: "Close Terminal", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    expect(await screenAndScrollback(page)).toContain("before-expansion");
    await expect(
      page.getByRole("textbox", { name: "Terminal input", exact: true }),
    ).toBeFocused();
    expect(wire.sockets).toBe(1);
    expect(wire.attaches).toBe(1);
    expect(wire.detaches).toBe(0);
    expect(wire.restores).toEqual(["replay"]);
    expect(
      await page.evaluate(() => Reflect.get(globalThis, "__terminalEngines")),
    ).toBe(engines);
    expect(
      (await state.product("terminal.list", { sessionID: id })).map((info) =>
        info.id
      ),
    ).toEqual([terminalID]);
  } finally {
    await cleanup(state, id);
  }
});
test(
  "terminal.btop-reload-restores-same-live-screen",
  { tag: "@terminal" },
  async ({ state, page }) => {
    const wire = observe(page),
      id = await open(state, page, "Terminal btop reload");
    try {
      await command(page, "printf 'before-%s\\n' reload");
      await expect(viewport(page)).toHaveAttribute(
        "aria-label",
        /before-reload/,
      );
      await command(page, "btop");
      await expect(viewport(page)).toHaveAttribute("aria-label", /cpu/i);
      expect(wire.restores.at(-1)).toBe("replay");
      const list = await state.product("terminal.list", {
        sessionID: id,
      });
      await page.reload();
      await page.getByRole("button", { name: "Open terminal", exact: true })
        .click();
      await expect(viewport(page)).toBeVisible();
      await expect(viewport(page)).toHaveAttribute("aria-label", /cpu/i);
      expect(wire.restores.at(-1)).toBe("replay");
      expect(
        (await state.product("terminal.list", {
          sessionID: id,
        })).map((info) => info.id),
      ).toEqual(list.map((info) => info.id));
      const previous = await viewport(page).evaluate((canvas) =>
        (canvas as HTMLCanvasElement).toDataURL()
      );
      await expect.poll(() =>
        viewport(page).evaluate((canvas) =>
          (canvas as HTMLCanvasElement).toDataURL()
        )
      ).not.toBe(previous);
      await quitRestoredBtop(page);
      await expect(viewport(page)).toHaveAttribute("aria-label", /\$\s*$/);
      expect(await screenAndScrollback(page)).toContain("before-reload");
      await command(page, "printf 'reload-%s\\n' returned");
      await expect(viewport(page)).toHaveAttribute(
        "aria-label",
        /reload-returned/,
      );
    } finally {
      await cleanup(state, id);
    }
  },
);

test("terminal.truncated-replay-falls-back-to-live-btop-checkpoint", {
  tag: "@terminal",
}, async ({ state, page }) => {
  const wire = observe(page),
    id = await open(state, page, "Terminal truncated replay");
  try {
    await command(page, "seq 1 400000; printf 'truncated-%s\\n' ready");
    await expect(viewport(page)).toHaveAttribute(
      "aria-label",
      /truncated-ready/,
      { timeout: 30000 },
    );
    await command(page, "btop");
    await expect(viewport(page)).toHaveAttribute("aria-label", /cpu/i);
    await page.reload();
    await page.getByRole("button", { name: "Open terminal", exact: true })
      .click();
    await expect(viewport(page)).toHaveAttribute("aria-label", /cpu/i);
    expect(wire.restores.at(-1)).toBe("checkpoint");
    const before = await viewport(page).evaluate((canvas) =>
      (canvas as HTMLCanvasElement).toDataURL()
    );
    await expect.poll(() =>
      viewport(page).evaluate((canvas) =>
        (canvas as HTMLCanvasElement).toDataURL()
      )
    ).not.toBe(before);
    await quitRestoredBtop(page);
    // A truncated active-screen checkpoint cannot preserve the inactive screen.
    await expect(viewport(page)).toHaveAttribute("aria-label", /\$\s*$/);
    expect(await screenAndScrollback(page)).not.toContain("truncated-ready");
    await command(page, "printf 'fallback-%s\\n' returned");
    await expect(viewport(page)).toHaveAttribute(
      "aria-label",
      /fallback-returned/,
    );
  } finally {
    await cleanup(state, id);
  }
});
