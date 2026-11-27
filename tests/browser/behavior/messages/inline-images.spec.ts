// SPDX-License-Identifier: LGPL-3.0-only
import type { Page } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { revealAcquired } from "../../pages/transcript.ts";
import {
  ending,
  openImages,
  revealImage,
  samples,
  showReply,
} from "../../pages/inline-images.ts";

test.use({ profile: "messages-private-home" });
const route = "**/api/inline-image?*";
const images = (page: Page) => page.locator(".otk-inline-image img");
const first = (page: Page) =>
  page.getByRole("button", { name: "Open image: Cabinet mockup" });

test(
  "messages.inline-image-renders-local",
  { tag: "@messages" },
  async ({ isolatedState: state, page }) => {
    const f = await openImages(state, page);
    await showReply(state, page, f.reply);
    await expect(images(page)).toHaveCount(3);
    for (const image of samples) {
      const locator = await revealImage(page, image.alt);
      await expect(locator).toHaveAttribute("alt", image.alt);
      await expect(locator).toHaveJSProperty("naturalWidth", image.width);
      await expect(locator).toHaveJSProperty("naturalHeight", image.height);
      const box = await locator.boundingBox();
      expect(box!.width).toBeLessThanOrEqual(Math.min(560, image.width));
      expect(Math.abs(box!.width / box!.height - image.width / image.height))
        .toBeLessThan(.01);
    }
  },
);

test(
  "messages.inline-image-no-layout-jump",
  { tag: "@messages" },
  async ({ isolatedState: state, page }) => {
    const f = await openImages(state, page);
    let release!: () => void;
    const held = new Promise<void>((resolve) => release = resolve);
    let count = 0;
    await page.route(route, async (request) => {
      count++;
      await held;
      await request.continue();
    });
    try {
      await showReply(state, page, f.reply);
      await expect(images(page)).toHaveCount(3);
      for (const image of samples) await revealImage(page, image.alt);
      const marker = page.getByText(ending, { exact: true });
      await marker.scrollIntoViewIfNeeded();
      await expect.poll(() => count).toBe(3);
      const before = await marker.boundingBox();
      release();
      for (const [index, image] of samples.entries()) {
        await expect(images(page).nth(index)).toHaveJSProperty(
          "naturalWidth",
          image.width,
        );
      }
      const after = await marker.boundingBox();
      expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(.5);
    } finally {
      release();
    }
  },
);

test(
  "messages.inline-image-zoom",
  { tag: "@messages" },
  async ({ isolatedState: state, page }) => {
    const f = await openImages(state, page);
    await showReply(state, page, f.reply);
    await first(page).click();
    const dialog = page.getByRole("dialog", { name: "a.png" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("img")).toHaveJSProperty("naturalWidth", 320);
    await expect(dialog.getByText(/PNG image .*320 x 200/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Copy path" }))
      .toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Open folder in terminal" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(first(page)).toBeFocused();
    await page.getByRole("button", { name: "Open image: Slab mockup" }).press(
      "Enter",
    );
    await expect(page.getByRole("dialog", { name: "b.png" })).toBeVisible();
  },
);

test(
  "messages.inline-image-outside-reason",
  { tag: "@messages" },
  async ({ isolatedState: state, page }) => {
    const f = await openImages(state, page);
    await showReply(state, page, f.reasons);
    await expect(
      page.getByRole("img", { name: "Shared mockup: Outside allowed folders" }),
    ).toBeVisible();
    await expect(page.getByText("~/Downloads/outside.png", { exact: true }))
      .toBeVisible();
    await expect(images(page)).toHaveCount(0);
  },
);

test(
  "messages.inline-image-never-html",
  { tag: "@messages" },
  async ({ isolatedState: state, page }) => {
    const f = await openImages(state, page);
    const responses: string[] = [];
    page.on("response", (response) => {
      if (/\/api\/inline-image\?|\.png$/.test(response.url())) {
        responses.push(response.headers()["content-type"]);
      }
    });
    await showReply(state, page, f.reply + "\n\n" + f.reasons);
    await expect(images(page)).toHaveCount(3);
    await expect(await revealImage(page, samples[0].alt)).toHaveJSProperty(
      "naturalWidth",
      320,
    );
    await revealAcquired(
      page,
      '.otk-inline-image-label[aria-label="Shared mockup: Outside allowed folders"]',
    );
    await expect(
      page.getByRole("img", { name: "Shared mockup: Outside allowed folders" }),
    ).toBeVisible();
    expect(responses).toContain("image/png");
    expect(responses.every((value) => !value.startsWith("text/html")))
      .toBeTruthy();
    const denied = await page.request.get(`${state.url}/api/inline-image`, {
      params: { session: f.id, path: "~/Downloads/outside.png" },
    });
    expect(denied.status()).toBe(403);
    expect(await denied.json()).toEqual({ code: "image-outside" });
  },
);

test(
  "messages.inline-image-menu",
  { tag: "@messages" },
  async ({ isolatedState: state, page }) => {
    const f = await openImages(state, page);
    await showReply(state, page, f.reply);
    await first(page).locator("img").click({ button: "right" });
    for (
      const name of [
        "Open preview",
        "Copy path",
        "Open folder in terminal",
        "Copy reply",
      ]
    ) {
      await expect(page.getByRole("menuitem", { name, exact: true }))
        .toBeVisible();
    }
    await expect(page.getByRole("menuitem", { name: "Copy image address" }))
      .toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: /Run in terminal/ }))
      .toHaveCount(0);
  },
);
