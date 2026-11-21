// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, throughDuration } from "../../fixtures/wire.ts";
import type { Page } from "@playwright/test";
import type { TestState } from "../../fixtures/test-state.ts";
import type { Commands } from "../../../support/fixture-control.ts";

const scenario = (
  state: TestState,
  action: Commands["scenario"]["action"],
  sessionID?: string,
) =>
  state.controller.call("scenario", {
    lease: state.lease.lease,
    action,
    ...(sessionID ? { sessionID } : {}),
  });

test.use({ profile: "contract-messages-running-layout" });
async function geometry(page: Page, responsiveHeader = false) {
  return await page.locator(".otk-messages").evaluate(
    (pane: HTMLElement, responsiveHeader) => {
      const rect = (element: Element | null) => {
        if (!element) return null;
        const b = element.getBoundingClientRect();
        return [b.x, b.y, b.width, b.height];
      };
      const viewport = rect(pane)!;
      // Style7 finding 7: required breadcrumb controls reflow instead of clipping
      // (notes/2026-11-21-style7fix.md:72-74; decision 3, AXIOMS section 1).
      // Keep the exact rectangle relative to that independently measured header;
      // composer/notices/takeovers still cannot move either trailing edge.
      const header = responsiveHeader
        ? document.querySelector(".otk-project-tabs")!.getBoundingClientRect()
          .height
        : 0;
      return {
        viewport: [
          viewport[0],
          viewport[1] - header,
          viewport[2],
          viewport[3] + header,
        ],
        top: pane.scrollTop,
        extent: pane.scrollHeight,
        footer: rect(
          pane.querySelector("[data-role=assistant] .otk-message-footer"),
        ),
        work: rect(pane.querySelector(".otk-work-fold")),
        execution: rect(pane.querySelector(".otk-tool-line")),
        thumb: rect(
          pane.parentElement!.querySelector(
            ".otk-scroll-track-y > .otk-scroll-thumb",
          ),
        ),
      };
    },
    responsiveHeader,
  );
}
async function frameProbe(page: Page, responsiveHeader = false) {
  await page.evaluate((responsiveHeader) => {
    const g = globalThis as typeof globalThis & {
      wp1Frames: number[][];
      wp1Sampling: boolean;
    };
    g.wp1Frames = [];
    g.wp1Sampling = true;
    const tick = () => {
      if (!g.wp1Sampling) return;
      const pane = document.querySelector<HTMLElement>(".otk-messages")!,
        b = pane.getBoundingClientRect();
      const header = responsiveHeader
        ? document.querySelector(".otk-project-tabs")!.getBoundingClientRect()
          .height
        : 0;
      g.wp1Frames.push([b.x, b.y - header, b.width, b.height + header]);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, responsiveHeader);
  return async () =>
    await page.evaluate(() => {
      const g = globalThis as typeof globalThis & {
        wp1Frames: number[][];
        wp1Sampling: boolean;
      };
      g.wp1Sampling = false;
      return g.wp1Frames;
    });
}
test(
  "messages.running-auto-approval-bursts-never-resize-or-move-existing-source",
  {
    tag: ["@messages", "@contracts", "@attention"],
  },
  async ({ isolatedState: state, page }, info) => {
    const { session } = await state.observe<{ session: string }>();
    await state.product("prefs.set", { key: "expandWork", value: true });
    await state.product("permission.auto", {
      sessionID: session,
      enabled: true,
    });
    await openSession(state, page, session);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator(".otk-response-progress")).toBeVisible();
    await expect(page.locator(".otk-work-fold")).toBeVisible();
    await throughDuration(300, async () => {});
    const before = await geometry(page), stop = await frameProbe(page);
    expect(before.footer).not.toBeNull();
    expect(before.execution).not.toBeNull();
    await scenario(state, "hold");
    await throughDuration(
      650,
      async () => expect(await geometry(page)).toEqual(before),
    );
    for (let n = 0; n < 15; n++) {
      await scenario(state, "release");
      await page.waitForTimeout(n % 3 === 0 ? 80 : 20);
    }
    await throughDuration(
      600,
      async () => expect(await geometry(page)).toEqual(before),
    );
    for (let n = 0; n < 3; n++) {
      await scenario(state, "hold", session);
      await page.waitForTimeout(80);
      await scenario(state, "release");
    }
    const frames = await stop();
    expect(frames.length).toBeGreaterThan(20);
    for (const frame of frames) expect(frame).toEqual(before.viewport);
    await expect(page.locator(".otk-auto-approving")).toHaveCount(0);
    await expect(page.locator(".otk-permission-dock")).toHaveCount(0);
    await info.attach("running-auto-approval-frames", {
      body: JSON.stringify(frames),
      contentType: "application/json",
    });
  },
);
test(
  "messages.running-chrome-helpers-notices-and-overflowing-takeovers-keep-viewport-track",
  {
    tag: ["@messages", "@contracts", "@sessions", "@attention"],
  },
  async ({ isolatedState: state, page }, info) => {
    const { session } = await state.observe<{ session: string }>();
    await openSession(state, page, session);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator(".otk-response-progress")).toBeVisible();
    await throughDuration(300, async () => {});
    const before = await geometry(page, true),
      stop = await frameProbe(page, true);
    for (let n = 0; n < 3; n++) {
      await scenario(state, "succeed");
      const helpers = page.locator(
        '.otk-task-crumbs [data-helper="true"]:visible',
      );
      await expect(helpers).toHaveCount([1, 4, 0][n]);
      for (const helper of await helpers.all()) {
        await expect(helper).toBeInViewport();
      }
      await throughDuration(
        180,
        async () =>
          expect((await geometry(page, true)).viewport).toEqual(
            before.viewport,
          ),
      );
    }
    await scenario(state, "fail");
    await expect(page.locator(".otk-composer-notice")).toBeVisible();
    await scenario(state, "succeed");
    await expect(page.locator(".otk-live-work-trigger")).toBeVisible();
    const noticeBounds = await page.locator(".otk-composer-notice")
      .boundingBox();
    const chipBounds = await page.locator(".otk-live-work-trigger")
      .boundingBox();
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await info.attach(`runtime-notice-${theme}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    }
    expect(noticeBounds!.y + noticeBounds!.height).toBeLessThanOrEqual(
      chipBounds!.y + 1,
    );
    expect((await geometry(page, true)).viewport).toEqual(before.viewport);
    await scenario(state, "hold", session);
    await expect(page.locator(".otk-permission-dock")).toBeVisible();
    expect((await geometry(page, true)).viewport).toEqual(before.viewport);
    await scenario(state, "stop");
    await scenario(state, "freeze", session);
    await expect(
      page.getByRole("region", { name: "Pending question", exact: true }),
    )
      .toBeVisible();
    await page.getByRole("region", { name: "Pending question", exact: true })
      .getByRole("button", { name: /Keep working/ }).click();
    expect((await geometry(page, true)).viewport).toEqual(before.viewport);
    await scenario(state, "stop");
    await scenario(state, "thaw");
    await expect(page.getByText("Runtime form", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Pending form", exact: true }).getByRole(
        "button",
        { name: "Review answers", exact: true },
      ),
    ).toBeInViewport();
    await page.getByRole("region", { name: "Pending form", exact: true })
      .getByRole(
        "button",
        { name: "Review answers", exact: true },
      ).click();
    await expect(
      page.getByRole("region", { name: "Pending form", exact: true }).getByRole(
        "button",
        { name: "Send answers", exact: true },
      ),
    ).toBeVisible();
    expect((await geometry(page, true)).viewport).toEqual(before.viewport);
    await scenario(state, "stop");
    await scenario(state, "disconnect");
    await throughDuration(
      180,
      async () =>
        expect((await geometry(page, true)).viewport).toEqual(before.viewport),
    );
    await scenario(state, "stop");
    const frames = await stop();
    for (const frame of frames) {
      expect(frame).toEqual(before.viewport);
    }
    await info.attach("running-runtime-chrome-frames", {
      body: JSON.stringify(frames),
      contentType: "application/json",
    });
  },
);
test(
  "messages.running-record-span-keeps-topology-through-fifteen-members-and-reveal",
  {
    tag: ["@messages", "@contracts", "@scroll"],
  },
  async ({ isolatedState: state, page }, info) => {
    const { session } = await state.observe<{ session: string }>();
    await openSession(state, page, session);
    await expect(page.locator(".otk-response-progress")).toBeVisible();
    await scenario(state, "freeze");
    // WP16: the first live record mints the stable interval, before settlement.
    const span = page.locator("[data-background-interval]").first();
    await expect(span).toHaveAttribute("data-count", "1");
    const original = await span.elementHandle();
    await scenario(state, "freeze");
    await expect(span).toHaveAttribute("data-count", "2");
    await expect(page.locator("[data-background-interval]")).toHaveCount(1);
    expect(
      await span.evaluate(
        (element, original) => element === original,
        original,
      ),
    ).toBe(true);
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await info.attach(`singleton-record-${theme}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    }
    await span.evaluate((element) => {
      (globalThis as typeof globalThis & { wp1Span: Element }).wp1Span =
        element;
    });
    for (let n = 3; n <= 15; n++) await scenario(state, "freeze");
    await expect(span).toHaveAttribute("data-count", "15");
    await expect(span.locator(".otk-record-group-time")).toHaveCount(0);
    expect(
      await span.evaluate((element) =>
        element ===
          (globalThis as typeof globalThis & { wp1Span: Element }).wp1Span
      ),
    ).toBe(true);
    await span.locator("button").first().click();
    await expect(span.locator(".otk-record-group")).toHaveCount(1);
    await span.locator(".otk-record-group button").first().click();
    await expect.poll(() =>
      page.locator(".otk-message[data-role=context]").count()
    ).toBeGreaterThan(0);
    await span.locator("button").first().click();
    await scenario(state, "fail");
    await page.locator(".otk-composer-notice").getByRole("button", {
      name: "See response",
    }).click();
    await expect(page.locator('.otk-message[data-message="record-10"]'))
      .toBeFocused();
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await info.attach(`wp1-running-records-${theme}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    }
  },
);
test(
  "messages.running-equal-status-publications-do-not-change-extents-or-scroll",
  {
    tag: ["@messages", "@contracts"],
  },
  async ({ isolatedState: state, page }) => {
    const { session } = await state.observe<{ session: string }>();
    await openSession(state, page, session);
    await expect(page.locator(".otk-response-progress")).toBeVisible();
    await scenario(state, "succeed", session);
    await throughDuration(400, async () => {});
    const before = await geometry(page);
    for (let n = 0; n < 12; n++) {
      await scenario(state, "succeed", session);
      await throughDuration(
        80,
        async () => expect(await geometry(page)).toEqual(before),
      );
    }
    for (let n = 0; n < 4; n++) {
      await scenario(state, "succeed", session);
      await throughDuration(
        100,
        async () => expect(await geometry(page)).toEqual(before),
      );
    }
  },
);
