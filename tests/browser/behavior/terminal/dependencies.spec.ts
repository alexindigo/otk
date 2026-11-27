// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { messages } from "../../pages/composer.ts";
import { send } from "../../pages/primary-action.ts";
import { nativeIdle } from "../../pages/transcript.ts";
import { sessionContext } from "../../pages/sessions.ts";
import type { Page } from "@playwright/test";

const viewport = (page: Page) =>
  page.locator('.otk-terminal .otk-tabs-panel[data-active="true"] canvas');
const terminals = (page: Page) =>
  page.getByRole("tablist", { name: "Terminals", exact: true }).getByRole(
    "tab",
  );
async function command(page: Page, value: string) {
  await expect(viewport(page)).not.toHaveAttribute(
    "aria-label",
    "Terminal output",
  );
  await viewport(page).click({ position: { x: 8, y: 8 } });
  await page.keyboard.type(value);
  await page.keyboard.press("Enter");
}

for (const theme of ["otk-dark", "otk-light"]) {
  test(
    `terminal.checkout-dependencies-owner-task-phantom-shared-box-${theme}`,
    {
      tag: ["@terminal", "@sessions", "@attention"],
    },
    async ({ state, page }, info) => {
      test.setTimeout(120_000);
      const frames = await wire(page);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await state.product("prefs.set", { key: "theme", value: theme });
      const a = await state.native<{ id: string }>("/session", "POST", {
        title: "Build dependency",
      });
      const b = await state.native<{ id: string }>("/session", "POST", {
        title: "Review dependency",
      });
      const task = await state.product("tasks.create", {
        directory: state.directory,
        name: "Build workspace",
        sessions: [a.id],
      });
      const taskLamp = () =>
        page.locator(`[data-tab="${task.id}"] .otk-status-light`);
      const phantom = () => page.locator(`[data-tab="${b.id}"]`);
      const project = () =>
        page.locator(
          `.otk-project-row[data-project=${JSON.stringify(state.directory)}]`,
        );
      const projectLamp = () => project().locator(".otk-status-light");
      const ownLamp = (id: string) =>
        page.locator(`[data-session="${id}"] .otk-status-light`);
      try {
        await openSession(state, page, a.id);
        await page.getByRole("button", { name: "Open terminal", exact: true })
          .click();
        await expect(terminals(page)).toHaveCount(1);
        const quietSize = await taskLamp().evaluate((lamp) => {
          const { width, height } = lamp.getBoundingClientRect();
          return { width, height };
        });
        const quietRect = (await taskLamp().boundingBox())!;
        const quietScreenshot = await page.screenshot({
          path: info.outputPath(`${theme}-quiet-baseline.png`),
          fullPage: true,
          animations: "disabled",
          caret: "hide",
        });
        await command(
          page,
          "printf '\\033[3J\\033[2J\\033[Hshared-checkout\\r\\n'; sleep 300",
        );
        await expect(viewport(page)).toHaveAttribute(
          "aria-label",
          /shared-checkout/,
        );
        await expect(taskLamp()).toHaveAttribute("data-state", "dependencies");
        await expect(taskLamp()).toHaveAttribute(
          "aria-label",
          "Running in terminal (1)",
        );
        await expect(ownLamp(a.id)).toHaveAttribute("data-state", "none");
        const first = await state.product("terminal.list", { sessionID: a.id });
        expect(first).toHaveLength(1);
        expect(first[0].ownerSessionID).toBe(a.id);

        await openSession(state, page, b.id);
        await page.getByRole("button", { name: "Open terminal", exact: true })
          .click();
        await expect(terminals(page)).toHaveCount(1);
        await expect(viewport(page)).toHaveAttribute(
          "aria-label",
          /shared-checkout/,
        );
        expect(
          (await state.product("terminal.list", { sessionID: b.id })).map((p) =>
            p.id
          ),
        ).toEqual(first.map((p) => p.id));
        await page.getByRole("button", { name: "New terminal", exact: true })
          .click();
        await expect(terminals(page)).toHaveCount(2);
        await command(page, "printf 'review-%s\\n' checkout; sleep 300");
        await expect(viewport(page)).toHaveAttribute(
          "aria-label",
          /review-checkout/,
        );
        await expect(phantom().locator(".otk-status-light")).toHaveAttribute(
          "aria-label",
          "Running in terminal (1)",
        );
        await expect(taskLamp()).toHaveAttribute(
          "aria-label",
          "Running in terminal (1)",
        );
        await expect(projectLamp()).toHaveAttribute(
          "aria-label",
          "Running in terminal (2)",
        );
        await expect(projectLamp()).toHaveAttribute(
          "title",
          "Running in terminal (2)",
        );
        await expect(ownLamp(a.id)).toHaveAttribute("data-state", "none");
        await expect(ownLamp(b.id)).toHaveAttribute("data-state", "none");
        const shared = await state.product("terminal.list", {
          sessionID: b.id,
        });
        expect(shared.map((p) => p.ownerSessionID).sort()).toEqual(
          [a.id, b.id].sort(),
        );

        // All lamps use the same component geometry, regardless of state or count.
        const geometry = await page.locator(
          ".otk-project-tabs [role=tab] .otk-status-light",
        ).evaluateAll((lamps) =>
          lamps.map((lamp) => {
            const r = lamp.getBoundingClientRect();
            return { width: r.width, height: r.height };
          })
        );
        expect(geometry.length).toBeGreaterThanOrEqual(2);
        for (const box of geometry) expect(box).toEqual(geometry[0]);
        expect(geometry[0]).toEqual(quietSize);
        for (
          const lamp of [
            taskLamp(),
            projectLamp(),
            phantom().locator(".otk-status-light"),
          ]
        ) {
          await expect(lamp).not.toHaveAttribute("data-blink", "true");
        }
        expect(
          await projectLamp().evaluate((lamp) =>
            getComputedStyle(lamp).getPropertyValue("--lamp-color").trim()
          ),
        ).toBe(theme === "otk-dark" ? "#ff7a24" : "#c85000");
        const screenshot = await page.screenshot({
          path: info.outputPath(`${theme}-dependencies-shared-checkout.png`),
          fullPage: true,
          animations: "disabled",
          caret: "hide",
        });
        const pixels = await page.evaluate(
          async ({ png, expected, baseline, quiet, taskID }) => {
            const bitmap = await createImageBitmap(
              new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], {
                type: "image/png",
              }),
            );
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const context = canvas.getContext("2d")!;
            context.drawImage(bitmap, 0, 0);
            const regions = Array.from(
              document.querySelectorAll(
                '.otk-status-light[data-state="dependencies"]',
              ),
            ).map((lamp) => {
              const r = lamp.getBoundingClientRect();
              const { data } = context.getImageData(
                Math.floor(r.x),
                Math.floor(r.y),
                Math.ceil(r.width),
                Math.ceil(r.height),
              );
              let nearest = Infinity;
              for (let i = 0; i < data.length; i += 4) {
                nearest = Math.min(
                  nearest,
                  Math.hypot(
                    data[i] - expected[0],
                    data[i + 1] - expected[1],
                    data[i + 2] - expected[2],
                  ),
                );
              }
              return {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                nearest,
              };
            });
            const before = await createImageBitmap(
              new Blob([
                Uint8Array.from(atob(baseline), (c) => c.charCodeAt(0)),
              ], { type: "image/png" }),
            );
            const prior = new OffscreenCanvas(before.width, before.height);
            const priorContext = prior.getContext("2d")!;
            priorContext.drawImage(before, 0, 0);
            const oldPixels = priorContext.getImageData(
              Math.floor(quiet.x),
              Math.floor(quiet.y),
              Math.ceil(quiet.width),
              Math.ceil(quiet.height),
            ).data;
            const current = document.querySelector(
              `[data-tab="${taskID}"] .otk-status-light`,
            )!.getBoundingClientRect();
            const newPixels = context.getImageData(
              Math.floor(current.x),
              Math.floor(current.y),
              Math.ceil(current.width),
              Math.ceil(current.height),
            ).data;
            let changedPixels = 0;
            for (let i = 0; i < oldPixels.length; i += 4) {
              if (
                Math.hypot(
                  oldPixels[i] - newPixels[i],
                  oldPixels[i + 1] - newPixels[i + 1],
                  oldPixels[i + 2] - newPixels[i + 2],
                ) > 30
              ) {
                changedPixels++;
              }
            }
            bitmap.close();
            before.close();
            return { regions, changedPixels };
          },
          {
            png: screenshot.toString("base64"),
            expected: theme === "otk-dark" ? [255, 122, 36] : [200, 80, 0],
            baseline: quietScreenshot.toString("base64"),
            quiet: quietRect,
            taskID: task.id,
          },
        );
        expect(pixels.regions.length).toBeGreaterThanOrEqual(3);
        for (const region of pixels.regions) {
          expect(region.nearest).toBeLessThan(60);
        }
        expect(pixels.changedPixels).toBeGreaterThan(0);
        await info.attach("dependency-lamp-decoded-pixels", {
          body: JSON.stringify({ theme, quietSize, geometry, pixels }),
          contentType: "application/json",
        });
        console.info(
          `P7 screenshot: ${
            info.outputPath(`${theme}-dependencies-shared-checkout.png`)
          }`,
        );
        await state.product("prefs.set", { key: "reducedColors", value: true });
        await expect(taskLamp().locator(".otk-lamp-dependency-shape"))
          .toBeVisible();
        await expect(projectLamp().locator(".otk-lamp-dependency-shape path"))
          .toHaveAttribute("d", "M6 1 11 6 6 11 1 6ZM4 6h4");
        await state.product("prefs.set", {
          key: "reducedColors",
          value: false,
        });
        const archive = frames.received.some((frame) =>
          frame.t === "welcome" &&
          (frame.sidecar as { harness: { capabilities?: string[] } }).harness
            .capabilities?.includes("sessionArchive")
        );
        expect(archive).toBe(state.controller.info!.version.startsWith("2."));
        if (archive) {
          await state.product("session.archive", {
            sessionID: a.id,
            archived: true,
          });
          expect(
            (await state.product("terminal.list", { sessionID: b.id })).map((
              p,
            ) => p.id),
          ).toEqual(shared.map((p) => p.id));
          await expect(projectLamp()).toHaveAttribute(
            "aria-label",
            "Running in terminal (2)",
          );
          await state.product("session.archive", {
            sessionID: a.id,
            archived: false,
          });
        } else {
          console.info(
            "V1 does not advertise sessionArchive; native archival is covered on V2",
          );
        }

        await page.locator(".otk-composer").getByRole("button", {
          name: "Hide terminal",
          exact: true,
        })
          .click();
        await state.product("projects.inactive", {
          directory: state.directory,
          inactive: true,
        });
        await page.getByRole("button", {
          name: "Collapse projects",
          exact: true,
        }).click();
        await state.product("layout.patch", { rightCollapsed: true });
        await page.reload();
        await expect(projectLamp()).toHaveAttribute(
          "aria-label",
          "Running in terminal (2)",
        );
        await expect(projectLamp()).toBeInViewport({ ratio: 1 });
        await expect(taskLamp()).toHaveAttribute("data-state", "dependencies");
        await expect(phantom()).toBeInViewport({ ratio: 1 });

        // Stopping an ungrouped owner's foreground job removes dependency attention
        // immediately, even though neither session has native completion evidence.
        await page.getByRole("button", { name: "Open terminal", exact: true })
          .click();
        await expect(terminals(page)).toHaveCount(2);
        await terminals(page).nth(1).click();
        await expect(viewport(page)).toHaveAttribute(
          "aria-label",
          /review-checkout/,
        );
        await viewport(page).click({ position: { x: 8, y: 8 } });
        await page.keyboard.press("Control+c");
        await expect(projectLamp()).toHaveAttribute(
          "aria-label",
          "Running in terminal (1)",
        );
        await page.locator(`[data-tab="${task.id}"]`).click();
        // D76: stopping retires dependency attention, not the explicit open.
        await expect(phantom().locator(".otk-status-light")).toHaveAttribute(
          "data-state",
          "none",
        );
        await sessionContext(page, `[data-tab="${b.id}"]`, "session.close");
        await expect(phantom()).toHaveCount(0);
        await expect(taskLamp()).toHaveAttribute("data-state", "dependencies");
        for (const terminal of shared) {
          await state.product("terminal.close", {
            sessionID: a.id,
            terminalID: terminal.id,
          });
        }
        await expect(taskLamp()).toHaveAttribute("data-state", "none");
        await expect(projectLamp()).toHaveAttribute("data-state", "none");
        expect(
          (await state.product("projects.list", {})).find((p) =>
            p.directory === state.directory
          )?.inactive,
        ).toBe(true);
      } finally {
        for (
          const terminal of await state.product("terminal.list", {
            sessionID: a.id,
          })
        ) {
          await state.product("terminal.close", {
            sessionID: a.id,
            terminalID: terminal.id,
          });
        }
      }
    },
  );
}

test("terminal.shared-selection-is-submitted-to-the-viewer-not-the-owner", {
  tag: ["@terminal", "@sessions"],
}, async ({ state, page }) => {
  const owner = await state.native<{ id: string }>("/session", "POST", {
    title: "Shared terminal owner",
  });
  const viewer = await state.native<{ id: string }>("/session", "POST", {
    title: "Shared terminal viewer",
  });
  try {
    await openSession(state, page, owner.id);
    await page.getByRole("button", { name: "Open terminal", exact: true })
      .click();
    await expect(terminals(page)).toHaveCount(1);
    await command(
      page,
      "printf '\\033[3J\\033[2J\\033[Hshared-checkout\\r\\n'",
    );
    await expect(viewport(page)).toHaveAttribute(
      "aria-label",
      /^shared-checkout\n/,
    );
    await openSession(state, page, viewer.id);
    await page.getByRole("button", { name: "Open terminal", exact: true })
      .click();
    await expect(terminals(page)).toHaveCount(1);
    await expect(viewport(page)).toHaveAttribute(
      "aria-label",
      /^shared-checkout\n/,
    );
    // Issue 2.118: select painted cells, not a fixed 7px font advance.
    const { box, cell } = await viewport(page).evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      return {
        box: canvas.getBoundingClientRect().toJSON(),
        cell: canvas.getContext("2d")!.measureText("M").width,
      };
    });
    await page.mouse.move(box.x + 4 + 0.5 * cell, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(box.x + 4 + 14.5 * cell, box.y + 12, {
      steps: 15,
    });
    await page.mouse.up();
    await page.getByRole("button", { name: "Add to prompt", exact: true })
      .click();
    await expect(page.locator(".otk-prompt-chip")).toContainText("Terminal:");
    await page.locator(".otk-composer").getByRole("button", {
      name: "Hide terminal",
      exact: true,
    }).click();
    await state.queue(["Shared terminal received."]);
    await send(page).click();
    await expect.poll(async () =>
      (await messages(state, viewer.id)).filter((row) =>
        row.info.role === "user"
      ).flatMap((row) => row.parts).filter((part) => part.type === "text").map((
        part,
      ) => part.text).join("\n")
    ).toContain("shared-checkout");
    expect(
      (await messages(state, owner.id)).filter((row) =>
        row.info.role === "user"
      ),
    ).toHaveLength(0);
    await nativeIdle(state, viewer.id);
  } finally {
    for (
      const terminal of await state.product("terminal.list", {
        sessionID: viewer.id,
      })
    ) {
      await state.product("terminal.close", {
        sessionID: viewer.id,
        terminalID: terminal.id,
      });
    }
  }
});

test(
  "terminal.orphan-only-checkout-remains-visible-after-all-owner-sessions-are-deleted",
  {
    tag: ["@terminal", "@sessions", "@attention"],
  },
  async ({ state, page }) => {
    test.setTimeout(90_000);
    const owner = await state.native<{ id: string }>("/session", "POST", {
      title: "Orphan terminal owner",
    });
    const project = () =>
      page.locator(
        `.otk-project-row[data-project=${JSON.stringify(state.directory)}]`,
      );
    try {
      await openSession(state, page, owner.id);
      await page.getByRole("button", { name: "Open terminal", exact: true })
        .click();
      await expect(terminals(page)).toHaveCount(1);
      await command(page, "printf 'orphan-%s\\n' running; sleep 300");
      await expect(viewport(page)).toHaveAttribute(
        "aria-label",
        /orphan-running/,
      );
      await expect(project().locator(".otk-status-light")).toHaveAttribute(
        "aria-label",
        "Running in terminal (1)",
      );
      await state.product("session.delete", { sessionID: owner.id });
      await expect(page.locator(`[data-session="${owner.id}"]`)).toHaveClass(
        /is-deleted/,
      );
      await expect(
        page.locator(`[data-session="${owner.id}"] .otk-status-light`),
      ).toHaveAttribute("data-state", "none");
      await page.getByRole("region", { name: "Deleted session", exact: true })
        .getByRole("button", { name: "Close session", exact: true }).click();
      await expect(page.locator(`[data-tab="${owner.id}"]`)).toHaveCount(0);
      await expect(project().locator(".otk-status-light")).toHaveAttribute(
        "data-state",
        "dependencies",
      );
      await page.reload();
      await expect(project().locator(".otk-status-light")).toHaveAttribute(
        "aria-label",
        "Running in terminal (1)",
      );
      await expect(project()).toBeInViewport({ ratio: 1 });
      await expect(page.locator(`[data-tab="${owner.id}"]`)).toHaveCount(0);
    } finally {
      // A fresh same-checkout session can close orphaned terminals without reviving
      // their deleted owner. This is ordinary product authorization, not a fixture bypass.
      const cleanupSession =
        (await state.native<{ id: string }>("/session", "POST", {
          title: "Orphan cleanup viewer",
        })).id;
      for (
        const terminal of await state.product("terminal.list", {
          sessionID: cleanupSession,
        })
      ) {
        await state.product("terminal.close", {
          sessionID: cleanupSession,
          terminalID: terminal.id,
        });
      }
    }
  },
);
