// SPDX-License-Identifier: LGPL-3.0-only
import type { Page } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";

/** A wide DOM box is not readable when a shrinking ancestor clips its paint. */
export function readableLabel(el: Element) {
  const r = el.getBoundingClientRect(), style = getComputedStyle(el);
  let left = r.left, right = r.right;
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (/hidden|clip|auto|scroll/.test(getComputedStyle(p).overflowX)) {
      const box = p.getBoundingClientRect();
      left = Math.max(left, box.left);
      right = Math.min(right, box.right);
    }
  }
  const probe = document.createElement("span");
  Object.assign(probe.style, {
    position: "fixed",
    visibility: "hidden",
    display: "block",
    inlineSize: "6ch",
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
  });
  document.body.append(probe);
  const six = probe.getBoundingClientRect().width;
  probe.remove();
  const range = document.createRange();
  range.selectNodeContents(el);
  return {
    visible: Math.max(0, right - left),
    minimum: Math.min(six, range.getBoundingClientRect().width),
  };
}

/** Observe the actual paint-bearing SVG, lamp body and selection backgrounds,
 * not the button boxes (which hid the load-order defect on the style scene). */
export async function sidebarGeometry(page: Page, compact = false) {
  const rows = await page.locator(".otk-project-inbox").evaluate((root) => {
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return {
        x: r.x,
        right: r.right,
        y: r.y,
        bottom: r.bottom,
        w: r.width,
        h: r.height,
      };
    };
    const visible = (el: Element) => {
      if (
        el.getBoundingClientRect().width <= 0 ||
        el.getBoundingClientRect().height <= 0
      ) return false;
      for (let p: Element | null = el; p && p !== root; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (
          s.visibility === "hidden" || s.display === "none" ||
          Number(s.opacity) === 0
        ) return false;
      }
      return true;
    };
    return Array.from(root.querySelectorAll(".otk-sidebar-row")).filter(visible)
      .map((row) => {
        const heading = row.closest(".otk-tree-heading") ??
          row.closest(".otk-project-row")!;
        const name = row.querySelector(
          ".otk-project-name, .otk-section-row-label .otk-control-label",
        );
        const label = row.querySelector(".otk-sidebar-label")!;
        const style = getComputedStyle(label);
        const textStyle = getComputedStyle(name ?? label);
        const probe = document.createElement("span");
        Object.assign(probe.style, {
          position: "fixed",
          visibility: "hidden",
          display: "block",
          inlineSize: "6ch",
          fontFamily: textStyle.fontFamily,
          fontSize: textStyle.fontSize,
          fontWeight: textStyle.fontWeight,
        });
        document.body.append(probe);
        const sixCharacters = probe.getBoundingClientRect().width;
        probe.remove();
        const range = document.createRange();
        range.selectNodeContents(name ?? label);
        const fullText = range.getBoundingClientRect().width;
        const required = name?.closest(".otk-section-row-label")
          ? fullText
          : Math.min(sixCharacters, fullText);
        const lamp = row.querySelector(
          ".otk-lamp-body",
        );
        const svg = heading.querySelector(
          ":scope > .otk-tree-own .otk-disclosure-icon svg",
        );
        const selection =
          heading.querySelector(".otk-sidebar-selection.is-selected") ??
            (heading.matches(".otk-sidebar-selection.is-selected")
              ? heading
              : null);
        const painted = [
          svg,
          lamp,
          row.querySelector(".otk-project-avatar"),
          label,
          row.querySelector(".otk-project-visit"),
        ]
          .filter((e): e is Element => !!e && visible(e)).map((e) => ({
            kind: e.tagName === "svg" ? "disclosure" : e.className,
            ...box(e),
          }));
        let highlight = null;
        if (selection) {
          highlight = box(selection);
          const mark = heading.querySelector(".otk-tree-selection-mark");
          if (mark) painted.push({ kind: "selection", ...box(mark) });
          const hs = getComputedStyle(heading),
            ss = getComputedStyle(selection);
          const paint = hs.backgroundImage !== "none"
            ? { el: heading, s: hs }
            : { el: selection, s: ss };
          const r = box(paint.el),
            [w, h] = paint.s.backgroundSize.split(" ").map(parseFloat);
          const inset = parseFloat(paint.s.backgroundPositionX) || 0;
          if (!mark && Number.isFinite(w) && Number.isFinite(h)) {
            painted.push({
              kind: "selection",
              x: r.x + inset,
              right: r.x + inset + w,
              y: r.y + (r.h - h) / 2,
              bottom: r.y + (r.h + h) / 2,
              w,
              h,
            });
          }
        }
        const availability = row.querySelector(".otk-project-availability");
        const availabilityClip = availability?.closest(
          ".otk-sidebar-meta, .otk-sidebar-label",
        );
        return {
          text: row.textContent,
          heading: box(heading),
          painted,
          label: box(label),
          lampSlot: box(row.querySelector(".otk-sidebar-lamp")!),
          iconSlot: box(row.querySelector(".otk-sidebar-icon")!),
          labelText: box(name ?? label),
          required,
          whiteSpace: style.whiteSpace,
          highlight,
          availability: availability
            ? {
              left: box(availability).x,
              right: box(availability).right,
              clipLeft: box(availabilityClip!).x,
              clipRight: box(availabilityClip!).right,
            }
            : null,
          meta: box(row.querySelector(".otk-sidebar-meta")!),
          hasMeta: !!row.querySelector(".otk-sidebar-meta")?.children.length,
          lamp: lamp && visible(lamp) ? box(lamp) : null,
        };
      });
  });
  expect(rows.length).toBeGreaterThan(0);
  const edges = new Map<number, number[]>();
  const disclosures = new Map<number, number>();
  let bottom = -Infinity;
  for (const row of rows) {
    expect.soft(row.heading.y, "adjacent real rows do not overlap vertically")
      .toBeGreaterThanOrEqual(bottom - .5);
    bottom = row.heading.bottom;
    if (!compact) {
      const current = [row.lampSlot.x, row.iconSlot.x, row.label.x],
        previous = edges.get(row.heading.x);
      if (previous) {
        current.forEach((edge, i) =>
          expect.soft(
            Math.abs(edge - previous[i]),
            "same-depth lamp/artwork/label axes across every row kind",
          ).toBeLessThanOrEqual(.5)
        );
      } else edges.set(row.heading.x, current);
      expect.soft(row.labelText.w, `minimum readable label: ${row.text}`)
        .toBeGreaterThanOrEqual(row.required - .5);
      expect.soft(row.whiteSpace, `single-line label: ${row.text}`).toBe(
        "nowrap",
      );
      if (row.availability) {
        expect.soft(
          row.availability.left,
          "availability starts inside its visible slot",
        ).toBeGreaterThanOrEqual(row.availability.clipLeft - .5);
        expect.soft(row.availability.right, "availability never truncates")
          .toBeLessThanOrEqual(row.availability.clipRight + .5);
      }
      if (!row.hasMeta) {
        expect.soft(row.meta.w, "absent meta consumes no track")
          .toBeLessThanOrEqual(.5);
      }
    }
    for (let i = 0; i < row.painted.length; i++) {
      const item = row.painted[i];
      expect.soft(item.x, "paint stays inside its heading's leading edge")
        .toBeGreaterThanOrEqual(row.heading.x - .5);
      expect.soft(item.right, "paint stays inside its heading's trailing edge")
        .toBeLessThanOrEqual(row.heading.right + .5);
      for (let j = i + 1; j < row.painted.length; j++) {
        const a = row.painted[i], b = row.painted[j];
        const overlapX = Math.min(a.right, b.right) - Math.max(a.x, b.x),
          overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
        expect.soft(
          Math.min(overlapX, overlapY),
          `paint does not intersect: ${a.kind}/${b.kind}: ${row.text}`,
        ).toBeLessThanOrEqual(.5);
      }
    }
    const mark = row.painted.find((p) => p.kind === "selection");
    if (row.highlight) {
      expect.soft(
        !!mark,
        "every selected row kind paints its mark, in column and rail",
      ).toBe(true);
    }
    const disclosure = row.painted.find((p) => p.kind === "disclosure");
    if (!compact && disclosure) {
      const previous = disclosures.get(row.heading.x);
      if (previous !== undefined) {
        expect.soft(
          Math.abs(disclosure.x - previous),
          "repository and section disclosures share the same painted axis",
        ).toBeLessThanOrEqual(.5);
      } else disclosures.set(row.heading.x, disclosure.x);
    }
    if (disclosure && row.highlight) {
      expect.soft(
        disclosure.right,
        "painted disclosure stays outside the selection highlight",
      ).toBeLessThanOrEqual(row.highlight.x - .5);
    }
    if (mark && row.highlight) {
      expect.soft(
        Math.min(
          Math.abs(mark.right - row.highlight.x),
          Math.abs(mark.x - row.highlight.x),
        ),
        "selection mark is outside the highlight, not on its edge",
      ).toBeGreaterThan(.5);
    }
  }
  if (compact) {
    const lamps = rows.flatMap((r) => r.lamp ? [r.lamp.x] : []);
    expect.soft(
      Math.max(...lamps) - Math.min(...lamps),
      "every compact lamp shares its axis, including Archived",
    ).toBeLessThanOrEqual(.5);
  }
  return rows;
}
