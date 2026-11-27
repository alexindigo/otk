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
    return Array.from(root.querySelectorAll(".otk-tree-frame")).filter(visible)
      .map((frame) => {
        const row = frame.querySelector(".otk-sidebar-row")!;
        const heading = frame.closest(".otk-tree-heading")!;
        const name = row.querySelector(
          ".otk-sidebar-title-text, .otk-section-row-label .otk-control-label",
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
        const lamp = frame.querySelector(
          ".otk-lamp-body",
        );
        const svg = heading.querySelector(
          ":scope > .otk-tree-trigger-slot .otk-disclosure-icon svg",
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
          depth: Number(
            heading.closest("[data-tree-node]")?.getAttribute("data-depth") ??
              0,
          ),
          painted,
          label: box(label),
          lampSlot: box(frame.querySelector(".otk-tree-node-lane")!),
          iconSlot: box(row.querySelector(".otk-sidebar-icon")!),
          labelText: box(name ?? label),
          required,
          whiteSpace: style.whiteSpace,
          highlight,
          availability: availability && visible(availability)
            ? {
              left: box(availability).x,
              right: box(availability).right,
              clipLeft: box(availabilityClip!).x,
              clipRight: box(availabilityClip!).right,
            }
            : null,
          meta: box(row.querySelector(".otk-sidebar-meta")!),
          hasMeta: !!row.querySelector(
            ".otk-sidebar-meta .otk-meta-item, .otk-sidebar-control",
          ),
          facts: Array.from(
            row.querySelectorAll(".otk-sidebar-meta .otk-meta-item"),
          )
            .filter(visible).map((item) => {
              const clip = item.parentElement!;
              return {
                text: item.textContent,
                clipping: item.scrollWidth > item.clientWidth + .5 ||
                  box(item).x < box(clip).x - .5 ||
                  box(item).right > box(clip).right + .5,
              };
            }),
          lamp: lamp && visible(lamp) ? box(lamp) : null,
        };
      });
  });
  // A single Playwright step per snapshot keeps trace recording bounded
  // while still checking every row, pair, and tolerance in every state.
  const violations: { contract: string; actual: unknown }[] = [];
  const check = (pass: boolean, contract: string, actual: unknown) => {
    if (!pass) violations.push({ contract, actual });
  };
  check(rows.length > 0, "rows are present", rows.length);
  const edges = new Map<number, number[]>();
  const labelEdges = new Map<string, number>();
  const disclosures = new Map<number, number>();
  let bottom = -Infinity;
  for (const row of rows) {
    check(
      row.heading.y >= bottom - .5,
      "adjacent real rows do not overlap vertically",
      { row: row.text, y: row.heading.y, bottom },
    );
    bottom = row.heading.bottom;
    if (!compact) {
      const current = [row.lampSlot.x, row.iconSlot.x],
        previous = edges.get(row.depth);
      if (previous) {
        current.forEach((edge, i) =>
          check(
            Math.abs(edge - previous[i]) <= .5,
            "same-depth lamp and artwork axes across every row kind",
            { row: row.text, edge, previous: previous[i] },
          )
        );
      } else edges.set(row.depth, current);
      const labelKey = `${row.depth}`;
      const labelEdge = labelEdges.get(labelKey);
      if (labelEdge === undefined) labelEdges.set(labelKey, row.label.x);
      else {
        check(
          Math.abs(row.label.x - labelEdge) <= .5,
          "same-depth label axis regardless of artwork",
          { row: row.text, x: row.label.x, labelEdge },
        );
      }
      check(
        Math.abs(row.label.x - row.iconSlot.right) <= .5,
        "label starts after the artwork track",
        { row: row.text, x: row.label.x, artworkRight: row.iconSlot.right },
      );
      check(
        row.labelText.w >= row.required - .5,
        `minimum readable label: ${row.text}`,
        { width: row.labelText.w, required: row.required },
      );
      check(
        row.whiteSpace === "nowrap",
        `single-line label: ${row.text}`,
        row.whiteSpace,
      );
      if (row.availability) {
        check(
          row.availability.left >= row.availability.clipLeft - .5,
          "availability starts inside its visible slot",
          row.availability,
        );
        check(
          row.availability.right <= row.availability.clipRight + .5,
          "availability never truncates",
          row.availability,
        );
      }
      // 2.109: metadata may yield only as whole facts; all visible facts must
      // fit their owner's clipping box, not merely fit their own DOM box.
      for (const fact of row.facts) {
        check(
          !fact.clipping,
          `metadata never truncates: ${fact.text}`,
          row.text,
        );
      }
      if (!row.hasMeta) {
        check(row.meta.w <= .5, "absent meta consumes no track", {
          row: row.text,
          width: row.meta.w,
        });
      }
    }
    for (let i = 0; i < row.painted.length; i++) {
      const item = row.painted[i];
      check(
        item.x >= row.heading.x - .5,
        "paint stays inside its heading's leading edge",
        { item, heading: row.heading },
      );
      check(
        item.right <= row.heading.right + .5,
        "paint stays inside its heading's trailing edge",
        { item, heading: row.heading },
      );
      for (let j = i + 1; j < row.painted.length; j++) {
        const a = row.painted[i], b = row.painted[j];
        const overlapX = Math.min(a.right, b.right) - Math.max(a.x, b.x),
          overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
        check(
          Math.min(overlapX, overlapY) <= .5,
          `paint does not intersect: ${a.kind}/${b.kind}: ${row.text}`,
          { overlapX, overlapY },
        );
      }
    }
    const mark = row.painted.find((p) => p.kind === "selection");
    if (row.highlight) {
      check(
        !!mark,
        "every selected row kind paints its mark, in column and rail",
        row.text,
      );
    }
    const disclosure = row.painted.find((p) => p.kind === "disclosure");
    if (!compact && disclosure) {
      const previous = disclosures.get(row.depth);
      if (previous !== undefined) {
        check(
          Math.abs(disclosure.x - previous) <= .5,
          "repository and section disclosures share the same painted axis",
          { row: row.text, x: disclosure.x, previous },
        );
      } else disclosures.set(row.depth, disclosure.x);
    }
    if (disclosure && row.highlight) {
      check(
        disclosure.right <= row.highlight.x - .5,
        "painted disclosure stays outside the selection highlight",
        { disclosure, highlight: row.highlight },
      );
    }
    if (mark && row.highlight) {
      check(
        Math.min(
          Math.abs(mark.right - row.highlight.x),
          Math.abs(mark.x - row.highlight.x),
        ) > .5,
        "selection mark is outside the highlight, not on its edge",
        { mark, highlight: row.highlight },
      );
    }
  }
  if (compact) {
    const lamps = rows.flatMap((r) => r.lamp ? [r.lamp.x] : []);
    check(
      Math.max(...lamps) - Math.min(...lamps) <= .5,
      "every compact lamp shares its axis, including Archived",
      lamps,
    );
  }
  expect.soft(violations, "sidebar row geometry").toEqual([]);
  return rows;
}
