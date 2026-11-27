// SPDX-License-Identifier: LGPL-3.0-only
import type { Locator } from "@playwright/test";

export interface TreeLaneFinding {
  rule: "child-junction" | "trigger" | "continuity" | "dangling" | "step";
  row: string;
  detail: string;
}

/** Measure the mounted preorder rows; compare lane/paint boxes, not screenshots. */
export async function treeLaneFindings(
  scope: Locator,
): Promise<TreeLaneFinding[]> {
  return await scope.evaluate((scope) => {
    const findings: TreeLaneFinding[] = [];
    const near = (a: number, b: number) => Math.abs(a - b) <= .5;
    const box = (element: Element) => element.getBoundingClientRect();
    const x = (rect: DOMRect) => rect.left + rect.width / 2;
    const y = (rect: DOMRect) => rect.top + rect.height / 2;
    const rows = Array.from(scope.querySelectorAll<HTMLElement>(
      ".otk-tree-row:not(.is-compact)",
    ));
    if (!rows.length) {
      return [{ rule: "step", row: "tree", detail: "no lane rows rendered" }];
    }
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;inline-size:var(--tree-indent)";
    rows[0].append(probe);
    const indent = box(probe).width;
    probe.remove();
    const geometry = rows.map((row, i) => {
      const own = (selector: string) =>
        row.querySelector(`:scope > ${selector}`);
      const rect = box(row);
      const segments = Array.from(row.querySelectorAll("[data-lane-segment]"))
        .filter((lane) => lane.closest(".otk-tree-row") === row);
      const name = row.querySelector("[data-row-title]")?.textContent?.trim() ||
        `${i + 1}: ${row.textContent?.trim().slice(0, 60)}`;
      const paint = segments.flatMap((lane) => {
        const parts = Array.from(lane.querySelectorAll("[data-lane-paint]"))
          .filter((part) => getComputedStyle(part).backgroundImage !== "none")
          .map(box).filter((part) => part.height > 0 && part.width > 0);
        const starts = parts.some((p) => near(p.top, rect.top));
        const ends = parts.some((p) => near(p.bottom, rect.bottom));
        if (
          starts !== lane.matches(".is-through, .is-tee, .is-elbow") ||
          ends !== lane.matches(".is-through, .is-tee, .is-stem")
        ) {
          findings.push({
            rule: "continuity",
            row: name,
            detail:
              `${lane.className} has unexpected paint boundaries (start: ${starts}, end: ${ends})`,
          });
        }
        return parts;
      });
      return {
        name,
        depth: Number(row.dataset.treeDepth),
        outgoing: row.classList.contains("is-outgoing"),
        rect,
        junction: own(".otk-tree-junction"),
        line: own(".otk-tree-junction > .otk-tree-junction-line"),
        node: own(".otk-tree-frame > .otk-tree-node-lane"),
        trigger: own(".otk-tree-trigger-slot"),
        starts: paint.filter((p) => near(p.top, rect.top)).map(x),
        ends: paint.filter((p) => near(p.bottom, rect.bottom)).map(x),
      };
    });
    const parents = [
      new Map<number, typeof geometry[number]>(),
      new Map<number, typeof geometry[number]>(),
    ];
    for (const [i, entry] of geometry.entries()) {
      const { name: row, junction, node, line, depth, outgoing, trigger } =
        entry;
      const report = (rule: TreeLaneFinding["rule"], detail: string) =>
        findings.push({ rule, row, detail });
      if (
        !junction || !node || !line || !Number.isInteger(depth) || indent <= 0
      ) {
        report("step", "missing lane cells, depth or positive lane width");
        continue;
      }
      const axis = x(box(junction));
      const sameDirection = parents[Number(outgoing)];
      const parent = sameDirection.get(depth - 1);
      sameDirection.set(depth, entry);
      if (junction.matches(".is-tee, .is-elbow")) {
        if (!parent?.node) {
          report("child-junction", "missing the parent node lane");
        } else {
          const dx = axis - x(box(parent.node));
          if (!near(dx, 0)) report("child-junction", `axis delta ${dx} CSS px`);
        }
      }
      if (parent?.junction) {
        const dx = axis - x(box(parent.junction));
        const step = outgoing ? -indent : indent;
        if (!near(dx, step)) report("step", `${dx} instead of ${step} CSS px`);
      }
      if (trigger) {
        const glyph = trigger.querySelector(".otk-disclosure-icon svg, svg");
        if (!glyph) report("trigger", "missing box glyph");
        else {
          const dx = x(box(glyph)) - axis;
          const dy = y(box(glyph)) - y(box(line));
          if (!near(dx, 0) || !near(dy, 0)) {
            report("trigger", `centre delta (${dx}, ${dy}) CSS px`);
          }
        }
      }
      const previous = geometry[i - 1];
      if (!previous || depth === 0 || previous.outgoing !== outgoing) continue;
      const gap = entry.rect.top - previous.rect.bottom;
      if (!near(gap, 0)) report("continuity", `row gap ${gap} CSS px`);
      for (const start of entry.starts) {
        if (!previous.ends.some((end) => near(start, end))) {
          report("continuity", `no incoming paint at x=${start}`);
        }
      }
      for (const end of previous.ends) {
        if (!entry.starts.some((start) => near(start, end))) {
          report("dangling", `paint from ${previous.name} stops at x=${end}`);
        }
      }
    }
    return findings;
  });
}
