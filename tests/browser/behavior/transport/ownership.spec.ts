// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import type { Request } from "@playwright/test";

test.describe("creation ownership", () => {
  test.use({ profile: "transport-freeze" });
  for (const newerSelection of [false, true]) {
    test(
      `transport.creation-${newerSelection ? "newer-selection" : "late-draft"}`,
      { tag: ["@transport", "@isolated", "@sessions", "@composer"] },
      async ({ isolatedState: state, page }) => {
        const a = await state.native<{ id: string }>("/session", "POST", {
          title: "Original A",
        });
        const b = newerSelection
          ? await state.native<{ id: string }>("/session", "POST", {
            title: "Newer selection B",
          })
          : undefined;
        const frames = await wire(page);
        await openSession(state, page, a.id);
        await state.controller.call("scenario", {
          lease: state.lease.lease,
          action: "freeze",
        });
        await page.locator(".otk-project-tabs .otk-new-session").click();
        await expect.poll(() =>
          frames.sent.some(({ frame }) => frame.method === "session.create")
        ).toBe(true);
        if (b) {
          await page.locator(`[data-session="${b.id}"]`).click();
          await expect(page).toHaveURL(new RegExp(`${b.id}$`));
          await expect(page.locator(`[data-session="${b.id}"]`))
            .toHaveAttribute("aria-current", "page");
        }
        await page.locator("textarea[name=prompt]").fill(
          b ? "Belongs to B" : "Work typed during creation",
        );
        await state.controller.call("scenario", {
          lease: state.lease.lease,
          action: "thaw",
        });
        if (b) {
          await expect(page.locator("[data-session]")).toHaveCount(3);
          await expect(
            page.locator(".otk-session-crumb[aria-current] .otk-crumb-title"),
          ).toHaveText("Newer selection B");
          await expect(page).toHaveURL(`${state.url}/#/local/${b.id}`);
          await expect(page.locator("textarea[name=prompt]")).toHaveValue(
            "Belongs to B",
          );
        } else {
          await expect(page).not.toHaveURL(new RegExp(`${a.id}$`));
          await expect(page.locator("textarea[name=prompt]")).toHaveValue("");
          await openSession(state, page, a.id);
          await expect(page.locator("textarea[name=prompt]")).toHaveValue(
            "Work typed during creation",
          );
          await expect(
            page.locator(".otk-session-crumb[aria-current] .otk-crumb-title"),
          ).toHaveText("Original A");
        }
      },
    );
  }
});

test(
  "transport.removed-login",
  { tag: ["@transport", "@isolated"] },
  async ({ isolatedState: state, page }) => {
    const { url } = await state.controller.call<{ url: string }>("auxiliary", {
      lease: state.lease.lease,
      kind: "remote-password",
    });
    let release!: () => void, admit!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      admit = resolve;
    });
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const terminal = (request: Request) => {
      if (request.url() === url + "/api/login") settle();
    };
    page.on("requestfinished", terminal);
    page.on("requestfailed", terminal);
    await page.route(url + "/api/login", async (route) => {
      admit();
      await held;
      await route.continue();
    });
    const frames = await wire(page);
    await page.goto(state.url);
    await page.locator(".otk-settings-entry").click();
    await page.locator("input[name=url]").fill(url);
    await page.locator(".otk-settings-content > .otk-form button[type=submit]")
      .click();
    const card = page.locator(
      "[data-settings-sidecar]:not([data-settings-sidecar=local])",
    );
    await card.locator("input[name=username]").fill("tester");
    await card.locator("input[name=password]").fill("secret");
    await card.locator("button[type=submit]").click();
    await entered;
    await card.locator(":scope > header button").click();
    await expect(card).toHaveCount(0);
    release();
    await settled;
    await state.product("prefs.set", { key: "timestamps", value: true });
    await expect.poll(() =>
      frames.received.some((frame) =>
        frame.t === "prefs" &&
        (frame.prefs as { timestamps: boolean }).timestamps
      )
    ).toBe(true);
    expect(frames.connections().opened).toBe(1);
    expect(
      await page.evaluate(() =>
        JSON.parse(localStorage.getItem("otk.sidecars")!).length
      ),
    ).toBe(0);
  },
);
