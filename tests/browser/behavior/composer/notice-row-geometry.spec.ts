// SPDX-License-Identifier: LGPL-3.0-only
import type { Locator } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";

test.use({ profile: "isolated", viewport: { width: 1280, height: 800 } });

async function geometry(notice: Locator, compact: boolean) {
  const facts = await notice.evaluate((frame) => {
    const ruler = document.createElement("span");
    ruler.style.position = "absolute";
    frame.append(ruler);
    const token = (name: string) => {
      ruler.style.inlineSize = `var(${name})`;
      return ruler.getBoundingClientRect().width;
    };
    const control = token("--control-size");
    const padding = token("--space-1");
    const gap = token("--space-2");
    ruler.remove();
    const box = frame.getBoundingClientRect();
    const headline = frame.querySelector(".otk-composer-notice-row")!
      .getBoundingClientRect();
    const details = frame.querySelector(".otk-failure-details button")
      ?.getBoundingClientRect();
    const detailsIcon = frame.querySelector(".otk-disclosure-icon")
      ?.getBoundingClientRect();
    const detailsLabel = frame.querySelector(".otk-disclosure-label")
      ?.getBoundingClientRect();
    const label = frame.querySelector(".otk-record-row-label")
      ?.getBoundingClientRect();
    const icon = frame.querySelector(".otk-composer-notice-icon")
      ?.getBoundingClientRect();
    const artwork = frame.querySelector(".otk-composer-notice-icon svg")
      ?.getBoundingClientRect();
    const actions = Array.from(
      frame.querySelectorAll(".otk-record-row-actions button"),
    ).map((button) => button.getBoundingClientRect()).filter((r) => r.width);
    const input = document.querySelector("textarea[name=prompt]")!;
    const css = getComputedStyle(input);
    const textLeft = input.getBoundingClientRect().left +
      parseFloat(css.borderLeftWidth) + parseFloat(css.paddingLeft);
    const center = (r: DOMRect) => r.top + r.height / 2;
    return {
      control,
      padding,
      height: headline.height,
      hasSlots: !!(label && icon && artwork),
      actionCount: actions.length,
      startPadding: headline.top - box.top,
      endPadding: box.bottom - (details ?? headline).bottom,
      details: details && detailsIcon && detailsLabel && label && icon && {
        height: details.height,
        rowGap: details.top - headline.bottom,
        iconDelta: Math.abs(detailsIcon.left - icon.left),
        labelDelta: Math.abs(detailsLabel.left - label.left),
      },
      axis: label && icon
        ? [icon, ...actions].map((r) => Math.abs(center(r) - center(label)))
        : [],
      insetDelta: icon && actions.length
        ? Math.abs(icon.left - box.left - (box.right - actions.at(-1)!.right))
        : undefined,
      artworkPadded: artwork && icon && artwork.left > icon.left &&
        artwork.right < icon.right && artwork.top > icon.top &&
        artwork.bottom < icon.bottom,
      textDelta: icon ? Math.abs(icon.left - textLeft) : undefined,
      gapDelta: icon && label
        ? Math.abs(label.left - icon.right - gap)
        : undefined,
      columns: { textarea: textLeft, icon: icon?.left, label: label?.left },
    };
  });
  // Issue 2.114 WP3: the headline keeps its original one-control height;
  // only an owned Details trigger gets a second track, below the headline.
  expect.soft(Math.abs(facts.height - facts.control), "one-control headline")
    .toBeLessThanOrEqual(1);
  for (const inset of [facts.startPadding, facts.endPadding]) {
    expect.soft(Math.abs(inset - facts.padding)).toBeLessThanOrEqual(1);
  }
  expect.soft(facts.actionCount).toBe(compact ? 0 : 1);
  if (compact) {
    expect.soft(facts.details, "Details has its own track").toBeTruthy();
    if (facts.details) {
      expect.soft(Math.abs(facts.details.height - facts.control))
        .toBeLessThanOrEqual(1);
      expect.soft(Math.abs(facts.details.rowGap - facts.padding))
        .toBeLessThanOrEqual(1);
      expect.soft(facts.details.iconDelta).toBeLessThanOrEqual(1);
      expect.soft(facts.details.labelDelta).toBeLessThanOrEqual(1);
    }
  } else {
    expect.soft(facts.details).toBeUndefined();
  }
  expect.soft(facts.hasSlots, "notice uses the record grid slots").toBe(true);
  if (!facts.hasSlots) return;
  for (const offset of facts.axis) expect.soft(offset).toBeLessThanOrEqual(1);
  if (!compact) expect.soft(facts.insetDelta).toBeLessThanOrEqual(1);
  expect.soft(facts.artworkPadded).toBe(true);
  // WP5 notice-padding amendment: align the icon slot, not the label, to
  // the fixed textarea text edge; keep the shared record-row gap.
  expect.soft(facts.textDelta, "icon slot starts at the textarea text edge")
    .toBeLessThanOrEqual(1);
  expect.soft(facts.gapDelta, "label follows the icon slot by --space-2")
    .toBeLessThanOrEqual(1);
  return facts.columns;
}

async function revertGeometry(group: Locator) {
  const facts = await group.evaluate((el) => {
    const box = (selector: string) =>
      el.querySelector(selector)!
        .getBoundingClientRect();
    const row = box(".otk-record-group-heading");
    // Tree lanes put the glyph and caption on one spanning disclosure.
    const junction = box(".otk-record-group-toggle > .otk-disclosure-icon");
    const label = box(".otk-record-group-toggle > .otk-disclosure-caption");
    const actions = box(".otk-record-row-actions");
    const center = (rect: DOMRect) => rect.top + rect.height / 2;
    return {
      heightDelta: Math.abs(row.height - label.height),
      junctionDelta: Math.abs(center(junction) - center(label)),
      rightDelta: Math.abs(row.right - actions.right),
    };
  });
  expect(facts.heightDelta).toBeLessThanOrEqual(1);
  expect(facts.junctionDelta).toBeLessThanOrEqual(1);
  expect(facts.rightDelta).toBeLessThanOrEqual(0.5);
}

test("composer.notice-row-aligns-pointer-and-retained-failure", {
  tag: ["@composer", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  test.setTimeout(120_000);
  await state.product("prefs.set", { key: "notify.toast", value: false });
  await state.product("prefs.set", { key: "animationsOff", value: true });
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Review deployment settings",
  });
  await wire(
    page,
    (frame) =>
      frame.t === "request" && frame.method === "session.prompt"
        ? {
          ...frame,
          params: {
            ...frame.params,
            model: { provider: "fake", model: "scripte" },
          },
        }
        : frame,
  );
  await openSession(state, page, session.id);
  const input = page.locator("textarea[name=prompt]");
  const sent = "Check which settings are required for deployment";
  const notice = page.locator(".otk-composer-notice");
  const record = page.locator('[data-native-record$="/request-failure"]');
  const reference = notice.locator(".otk-failure-reference");
  type Stage = "no-notice" | "pointer" | "compact";
  const columns = new Map<string, Partial<Record<Stage, number>>>();
  const noticeColumns = new Map<string, Awaited<ReturnType<typeof geometry>>>();

  async function matrix(name: Stage) {
    for (
      const [width, scale] of [[1280, "100"], [1280, "125"], [
        900,
        "125",
      ]] as const
    ) {
      await page.setViewportSize({ width, height: 800 });
      await state.product("prefs.set", { key: "textSize", value: scale });
      await expect(page.locator("html")).toHaveCSS(
        "--otk-scale",
        String(Number(scale) / 100),
      );
      // WP3 presents the right panel as a sheet when it does not fit. Keep
      // the conversation in front so the narrow matrix measures painted UI.
      const rightCollapsed = width === 900;
      await state.product("layout.patch", { rightCollapsed });
      await expect(page.locator(".otk-app")).toHaveAttribute(
        "data-right-collapsed",
        String(rightCollapsed),
      );
      await expect(page.locator(".otk-main")).not.toHaveAttribute("inert", "");
      await expect(input).toBeVisible();
      for (
        const [theme, id] of [["dark", "otk-dark"], ["linen", "otk-light"], [
          "stone",
          "otk-light-stone",
        ]] as const
      ) {
        await state.product("prefs.set", { key: "theme", value: id });
        await expect(page.locator("html")).toHaveAttribute(
          "data-otk-theme",
          id,
        );
        await page.evaluate(() => document.fonts.ready);
        if (info.project.name === "oc-2.2.6") {
          await page.screenshot({
            path: info.outputPath(`${name}-${theme}-${width}-${scale}.png`),
            animations: "disabled",
            fullPage: true,
          });
        }
        const left = await input.evaluate((el) => {
          const css = getComputedStyle(el);
          return el.getBoundingClientRect().left +
            parseFloat(css.borderLeftWidth) + parseFloat(css.paddingLeft);
        });
        const key = `${width}/${scale} ${theme}`;
        const values = columns.get(key) ?? {};
        values[name] = left;
        columns.set(key, values);
        if (name !== "no-notice") {
          expect.soft(
            Math.abs(left - values["no-notice"]!),
            `${key}: ${name} moved the textarea text`,
          ).toBeLessThanOrEqual(1);
          noticeColumns.set(
            `${key} ${name}`,
            await geometry(notice, name === "compact"),
          );
        }
        if (name === "compact") {
          await revertGeometry(page.locator(".otk-revert-group"));
          await expect(reference).toHaveCount(0);
        }
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await state.product("prefs.set", { key: "textSize", value: "100" });
    await expect(page.locator("html")).toHaveCSS("--otk-scale", "1");
    await state.product("layout.patch", { rightCollapsed: false });
    await expect(page.locator(".otk-app")).toHaveAttribute(
      "data-right-collapsed",
      "false",
    );
  }

  await expect(notice).toHaveCount(0);
  await input.fill(sent);
  await matrix("no-notice");
  await input.press("Enter");
  await expect(record).toHaveCount(1);
  await expect(reference).toBeVisible();
  await matrix("pointer");
  await expect.soft(reference).toHaveText("Show error");
  expect.soft(
    await reference.evaluate((el) => getComputedStyle(el).textDecorationLine),
  )
    .toBe("none");
  await reference.click();
  await expect(record.locator("xpath=ancestor::article")).toBeFocused();

  // End 1.19.3's still-busy native run without withdrawing the test prompt.
  if (info.project.name === "oc-1.19.3") {
    await state.product("session.abort", { sessionID: session.id });
    await expect(page.locator(`[data-session="${session.id}"]`))
      .toHaveAttribute("data-status", "idle");
  }

  const bubble = page.getByText(sent, { exact: true }).locator(
    "xpath=ancestor::article",
  );
  await bubble.locator(".otk-user-bubble").focus();
  await bubble.locator('[data-message-command="prompt.revert"]').click();
  await page.getByRole("button", { name: "Confirm revert", exact: true })
    .click();
  await expect(page.locator(".otk-revert-group")).toContainText(
    "Reverted from",
  );
  await expect(record).toHaveCount(0);
  await expect(reference).toHaveCount(0);
  await expect(notice.locator(".otk-failure-heading")).toHaveText(
    "Running session failed",
  );
  await matrix("compact");
  console.log(
    "COMPOSER TEXT LEFT",
    JSON.stringify(Object.fromEntries(columns)),
  );
  console.log(
    "NOTICE COLUMN GEOMETRY",
    JSON.stringify(Object.fromEntries(noticeColumns)),
  );
  await expect.soft(notice.locator(".otk-failure-signal")).toHaveCount(0);
  const details = notice.getByRole("button", { name: "Details", exact: true });
  await details.click();
  await expect(details).toHaveAttribute("aria-expanded", "true");
  const detailBody = notice.locator(".otk-failure-detail-body");
  await expect(detailBody).toContainText(
    "Diagnostic ID",
  );
  const disclosed = await notice.evaluate((el) => {
    const box = (selector: string) =>
      el.querySelector(selector)!
        .getBoundingClientRect();
    const label = box(".otk-record-row-label");
    const reason = box(".otk-failure-disclosed-reason");
    return {
      below: reason.top >= label.bottom,
      inset: Math.abs(reason.left - label.left),
    };
  });
  expect(disclosed.below).toBe(true);
  expect(disclosed.inset).toBeLessThanOrEqual(1);
  if (info.project.name === "oc-2.2.6") {
    for (
      const [theme, id] of [["dark", "otk-dark"], ["linen", "otk-light"], [
        "stone",
        "otk-light-stone",
      ]] as const
    ) {
      await state.product("prefs.set", { key: "theme", value: id });
      await expect(page.locator("html")).toHaveAttribute("data-otk-theme", id);
      await page.screenshot({
        path: info.outputPath(`details-${theme}-1280-100.png`),
        animations: "disabled",
        fullPage: true,
      });
    }
  }
  await details.click();
  await expect(detailBody).toHaveCount(0);
});
