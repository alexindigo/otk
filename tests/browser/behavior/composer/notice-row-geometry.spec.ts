// SPDX-License-Identifier: LGPL-3.0-only
import type { Locator } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";

test.use({ profile: "isolated", viewport: { width: 1280, height: 800 } });

async function geometry(notice: Locator) {
  const facts = await notice.evaluate((frame) => {
    const ruler = document.createElement("span");
    ruler.style.position = "absolute";
    frame.append(ruler);
    const token = (name: string) => {
      ruler.style.inlineSize = `var(${name})`;
      return ruler.getBoundingClientRect().width;
    };
    const limit = token("--control-size") + 2 * token("--space-1");
    const gap = token("--space-2");
    ruler.remove();
    const box = frame.getBoundingClientRect();
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
      limit,
      height: box.height,
      hasSlots: !!(label && icon && artwork && actions.length),
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
  expect.soft(facts.height, "closed notice is one control high plus padding")
    .toBeLessThanOrEqual(facts.limit + 1);
  expect.soft(facts.hasSlots, "notice uses the record grid slots").toBe(true);
  if (!facts.hasSlots) return;
  for (const offset of facts.axis) expect.soft(offset).toBeLessThanOrEqual(1);
  expect.soft(facts.insetDelta).toBeLessThanOrEqual(1);
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
    const junction = box(".otk-tree-toggle");
    const label = box(".otk-record-row-label");
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
          noticeColumns.set(`${key} ${name}`, await geometry(notice));
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
