// SPDX-License-Identifier: LGPL-3.0-only
import { expect, type Locator } from "@playwright/test";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { revealAcquired, scrollTranscript } from "../../pages/transcript.ts";

async function geometry(nodes: Locator) {
  const facts = await nodes.evaluateAll((nodes) =>
    nodes.map((node) => {
      const row = node.querySelector(":scope > .otk-tree-heading")!;
      const rail = row.querySelector(":scope > .otk-tree-junction")!;
      const box = row.querySelector(
        ":scope > .otk-tree-trigger-slot .otk-tree-toggle",
      );
      const connector = rail.querySelector(".otk-tree-connector")!;
      const upper = rail.querySelector(".otk-tree-upper")!;
      const lower = rail.querySelector(".otk-tree-lower")!;
      const r = rail.getBoundingClientRect(), b = box?.getBoundingClientRect();
      const heading = rail.querySelector(
        ".otk-tree-junction-line",
      )!
        .getBoundingClientRect();
      const c = connector.getBoundingClientRect(),
        u = upper.getBoundingClientRect();
      const label = row.querySelector(
        ":scope > .otk-tree-frame > .otk-tree-label",
      )!;
      const content = (label.firstElementChild ?? label)
        .getBoundingClientRect();
      const style = getComputedStyle(lower);
      const continuation = node.querySelector(
        ":scope > .is-gap > .otk-tree-junction > .otk-tree-through-paint",
      );
      const incoming = rail.matches(".is-tee, .is-elbow") ? rail : null;
      const incomingBox = incoming?.getBoundingClientRect();
      const parent = node.parentElement?.closest(".otk-tree-node");
      const parentRail = parent?.querySelector(
        ":scope > .otk-tree-heading .otk-tree-node-lane",
      )?.getBoundingClientRect();
      const parentJunction = parent?.querySelector(
        ":scope > .otk-tree-heading > .otk-tree-junction",
      )?.getBoundingClientRect();
      const parentStem = parent?.querySelector(
        ":scope > .otk-tree-heading .otk-tree-node-lane.is-stem",
      )?.getBoundingClientRect();
      const icon = row.querySelector(".otk-tree-node-slot") ??
        parent?.querySelector(":scope > .otk-tree-heading .otk-tree-node-slot");
      const svg = box?.querySelector("svg");
      const parentHeading = parent?.querySelector(":scope > .otk-tree-heading")
        ?.getBoundingClientRect();
      const firstChild = parent?.querySelector(
        ":scope > .otk-tree-region .otk-tree-node",
      );
      const contentEdge = row.querySelector(":scope > .otk-tree-frame")!
        .getBoundingClientRect();
      return {
        connected: node.classList.contains("is-connected"),
        last: rail.matches(".is-elbow"),
        outgoing: node.classList.contains("is-outgoing"),
        box: b ? [b.x + b.width / 2, b.y + b.height / 2] : undefined,
        boxTop: b?.top,
        boxBottom: b?.bottom,
        boxSize: b ? [b.width, b.height] : undefined,
        stroke: svg
          ? getComputedStyle(svg.querySelector("rect")!).stroke
          : undefined,
        boxColor: svg ? getComputedStyle(svg).color : undefined,
        muted: getComputedStyle(node).getPropertyValue("--otk-fg-3").trim(),
        junction: [r.x + r.width / 2, heading.y + heading.height / 2],
        indent: r.width,
        iconSize: parseFloat(getComputedStyle(icon ?? rail).fontSize),
        iconSlot: icon?.getBoundingClientRect().width,
        levelStep: parentJunction
          ? Math.abs(r.x - parentJunction.x)
          : undefined,
        stemEnd: parentStem?.bottom,
        contentCenter: content.y + content.height / 2,
        rowCenter: heading.y + heading.height / 2,
        connector: [c.x, c.right, c.y],
        labelEdge: node.classList.contains("is-outgoing")
          ? contentEdge.right
          : contentEdge.left,
        parentBottom: firstChild === node ? parentHeading?.bottom : undefined,
        upper: u.bottom,
        lowerStart: lower.getBoundingClientRect().top,
        lower: style.backgroundImage,
        incoming: incomingBox
          ? [incomingBox.x + incomingBox.width / 2, incomingBox.y]
          : undefined,
        parentAxis: parentRail
          ? parentRail.x + parentRail.width / 2
          : undefined,
        incomingLower: incoming
          ? getComputedStyle(incoming.querySelector(".otk-tree-lower")!)
            .backgroundImage
          : undefined,
        dots:
          getComputedStyle(incoming?.querySelector(".otk-tree-upper") ?? lower)
            .backgroundSize,
        horizontalDots: getComputedStyle(connector).backgroundSize,
        tail: continuation
          ? getComputedStyle(continuation).backgroundImage
          : "none",
      };
    })
  );
  expect(facts.length).toBeGreaterThan(1);
  for (const fact of facts) {
    expect(Math.abs(fact.junction[1] - fact.rowCenter)).toBeLessThanOrEqual(1);
    if (fact.box) {
      expect(Math.abs(fact.box[0] - fact.junction[0])).toBeLessThanOrEqual(1);
      expect(Math.abs(fact.box[1] - fact.junction[1])).toBeLessThanOrEqual(1);
      expect(Math.abs(fact.box[1] - fact.contentCenter)).toBeLessThanOrEqual(1);
      expect(fact.boxSize![0]).toBeCloseTo(fact.boxSize![1], 1);
      expect(fact.boxSize![0] / fact.iconSize).toBeGreaterThan(.5);
      expect(fact.boxSize![0] / fact.iconSize).toBeLessThan(.85);
      expect(fact.stroke).not.toBe("none");
      expect(fact.stroke).toBe(fact.boxColor);
      if (fact.lower !== "none") expect(fact.lower).toContain(fact.boxColor!);
    }
    expect(fact.dots).toBe("1px 2px");
    expect(fact.horizontalDots).toBe("2px 1px");
    expect(fact.indent / fact.iconSize).toBeGreaterThan(1);
    expect(fact.indent / fact.iconSize).toBeLessThanOrEqual(1.5);
    if (fact.iconSlot) {
      expect(fact.indent / fact.iconSlot).toBeLessThanOrEqual(1.5);
    }
    expect((fact.connector[1] - fact.connector[0]) / fact.indent)
      .toBeLessThanOrEqual(.6);
    if (!fact.connected) continue;
    expect(Math.abs(fact.connector[2] - fact.junction[1])).toBeLessThanOrEqual(
      1,
    );
    // UI convention: guides meet the junction's edges, never run underneath
    // artwork and rely on a background mask to hide the overlap.
    expect(Math.abs(fact.upper - (fact.boxTop ?? fact.junction[1])))
      .toBeLessThanOrEqual(1);
    expect(Math.abs(fact.lowerStart - (fact.boxBottom ?? fact.junction[1])))
      .toBeLessThanOrEqual(1);
    expect(fact.incomingLower === "none").toBe(fact.last);
    if (fact.parentAxis !== undefined) {
      expect(Math.abs(fact.levelStep! - fact.indent)).toBeLessThanOrEqual(1);
      expect(
        Math.abs(fact.incoming![0] - fact.parentAxis),
        JSON.stringify(fact),
      ).toBeLessThanOrEqual(
        1,
      );
    }
    if (fact.parentBottom !== undefined) {
      expect(Math.abs(fact.stemEnd! - fact.parentBottom)).toBeLessThanOrEqual(
        1,
      );
      expect(Math.abs(fact.incoming![1] - fact.parentBottom))
        .toBeLessThanOrEqual(1);
    }
    expect(Math.abs(fact.connector[fact.outgoing ? 0 : 1] - fact.labelEdge))
      .toBeLessThanOrEqual(1);
    if (fact.last) expect(fact.tail).toBe("none");
  }
  return facts;
}

async function scaledGeometry(nodes: Locator) {
  try {
    for (const size of ["0.8", "1.3"]) {
      await nodes.page().evaluate(
        (size) =>
          document.documentElement.style.setProperty("--otk-scale", size),
        size,
      );
      await geometry(nodes);
    }
  } finally {
    await nodes.page().evaluate(() =>
      document.documentElement.style.removeProperty("--otk-scale")
    );
  }
}

test.describe("work tree", () => {
  test.use({ profile: "contract-messages-disclosures" });
  test("messages.tree-junction-geometry-keyboard-and-lazy-body", {
    tag: ["@messages", "@contracts", "@tree"],
  }, async ({ isolatedState: state, page }, info) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSession(state, page, "tstv1-otk");
    const root = page.locator(".otk-work-log > .otk-tree-node");
    await expect(
      root.locator(":scope > .otk-tree-heading .otk-tree-node-slot svg"),
    )
      .toHaveCount(1);
    const toggle = root.locator(":scope > .otk-tree-heading .otk-tree-control");
    await expect(root.locator(":scope > .otk-tree-heading [aria-expanded]"))
      .toHaveCount(1);
    await root.locator(":scope > .otk-tree-heading label.otk-tree-toggle")
      .click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await toggle.press("ArrowLeft");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.focus();
    await page.keyboard.press("ArrowRight");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const tool = page.locator(".otk-tool-toggle");
    await expect(
      page.locator(
        "[data-tool] > .otk-tree-node > .otk-tree-heading .otk-tree-node-slot svg",
      ),
    )
      .toHaveCount(1);
    await tool.click();
    await expect(page.locator(".otk-code")).toContainText("foldedSecret");
    await tool.evaluate((element) => (element as HTMLElement).blur());
    for (
      const [theme, name] of [["otk-dark", "dark"], ["otk-light", "linen"], [
        "otk-light-stone",
        "stone",
      ]]
    ) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await geometry(root.locator(".otk-tree-node").or(root));
      await page.screenshot({
        path: info.outputPath(`wp12-work-log-${name}.png`),
        fullPage: true,
      });
    }
    await scaledGeometry(root.locator(".otk-tree-node").or(root));
    await toggle.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".otk-code")).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator(".otk-code")).toContainText("foldedSecret");
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});

test.describe("project tree", () => {
  test.use({ profile: "contract-sessions-worktrees" });
  test("projects.tree-persisted-junction-before-lamp-and-mandatory-child", {
    tag: ["@projects", "@sessions", "@contracts", "@tree"],
  }, async ({ isolatedState: state, page }, info) => {
    const { root, entries } = await state.observe<
      { root: string; entries: { id: string; directory: string }[] }
    >();
    const directory = entries[0].directory;
    const row = (path: string) =>
      page.locator(`.otk-project-row[data-project=${JSON.stringify(path)}]`);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(state.url);
    const parent = row(directory).locator(
      "xpath=ancestor::section[contains(@class,'otk-tree-node')][1]",
    );
    const toggle = parent.locator(
      ":scope > .otk-tree-heading .otk-tree-toggle",
    );
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(
      row(directory).getByRole("img", { name: "Working", exact: true }),
    ).toBeVisible();
    const box = await toggle.boundingBox(),
      lamp = await row(directory).locator(".otk-status-light").boundingBox();
    expect(box!.x + box!.width).toBeLessThan(lamp!.x);
    await toggle.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(row(root + "/worktrees/feature-two")).toHaveCount(0);
    // Decision 59: collapse hides all children, including mandatory activity.
    await expect(row(root + "/worktrees/feature-one")).toHaveCount(0);
    await expect(
      row(directory).getByRole("img", { name: "Working", exact: true }),
    )
      .toBeVisible();
    await expect.poll(async () =>
      (await state.product("prefs.get", {})).shellLayout.projectCollapsed
        ?.[JSON.stringify(["local", directory])]
    ).toBe(true);
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.focus();
    await page.keyboard.press("ArrowRight");
    await expect(row(root + "/worktrees/feature-two")).toBeVisible();
    const leaf = row(root + "/worktrees/feature-two").locator(
      "xpath=ancestor::section[contains(@class,'otk-tree-node')][1]",
    );
    await expect(leaf.locator(":scope > .otk-tree-heading .otk-tree-toggle"))
      .toHaveCount(0);
    const tip = await row(root + "/worktrees/feature-two").evaluate(
      (element) => {
        const connector = element.closest(".otk-tree-node")!.querySelector(
          ":scope > .otk-tree-heading .otk-tree-connector",
        )!
          .getBoundingClientRect();
        const marker = element.querySelector(".otk-tree-node-line")!
          .getBoundingClientRect();
        return {
          end: connector.right,
          iconSlot: marker.left,
          lineY: connector.y,
          iconY: marker.y + marker.height / 2,
        };
      },
    );
    expect(Math.abs(tip.end - tip.iconSlot)).toBeLessThanOrEqual(1);
    expect(Math.abs(tip.lineY - tip.iconY)).toBeLessThanOrEqual(1);
    const other = JSON.stringify(["other", "/other-project"]);
    await state.product("layout.project", {
      sidecarId: "other",
      directory: "/other-project",
      collapsed: true,
    });
    const saved = (await state.product("prefs.get", {})).shellLayout
      .projectCollapsed!;
    expect(saved[other]).toBe(true);
    expect(saved[JSON.stringify(["local", directory])]).toBe(false);
    await toggle.evaluate((element) => (element as HTMLElement).blur());
    for (
      const [theme, name] of [["otk-dark", "dark"], ["otk-light", "linen"], [
        "otk-light-stone",
        "stone",
      ]]
    ) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await geometry(page.locator(".otk-project-inbox .otk-tree-node"));
      await page.screenshot({
        path: info.outputPath(`wp12-sidebar-${name}.png`),
        fullPage: true,
      });
    }
    await scaledGeometry(page.locator(".otk-project-inbox .otk-tree-node"));
  });
});

test.describe("activity tree", () => {
  test.use({ profile: "contract-messages-running-layout" });
  test("messages.tree-activity-span-and-identical-run-junctions", {
    tag: ["@messages", "@contracts", "@tree"],
  }, async ({ isolatedState: state, page }, info) => {
    const { session } = await state.observe<{ session: string }>();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSession(state, page, session);
    for (let n = 0; n < 3; n++) {
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "freeze",
      });
    }
    await page.reload();
    const span = page.locator(".otk-record-group").first();
    await expect(
      span.locator(
        ":scope > .otk-tree-node > .otk-tree-heading .otk-tree-node-slot svg",
      ),
    ).toHaveCount(1);
    await expect(span).toHaveAttribute("data-count", "3");
    await span.locator(".otk-record-group-toggle").first().click();
    const run = span.locator(".otk-record-group");
    await expect(run).toHaveCount(1);
    const toggle = run.locator(
      ":scope > .otk-tree-node > .otk-tree-heading .otk-tree-control",
    );
    await toggle.focus();
    await page.keyboard.press("ArrowRight");
    await expect(span.locator(".otk-message[data-role=context]")).toHaveCount(
      3,
    );
    await toggle.evaluate((element) => (element as HTMLElement).blur());
    for (
      const [theme, name] of [["otk-dark", "dark"], ["otk-light", "linen"], [
        "otk-light-stone",
        "stone",
      ]]
    ) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await geometry(span.locator(".otk-tree-node"));
      await page.screenshot({
        path: info.outputPath(`wp12-activity-${name}.png`),
        fullPage: true,
      });
    }
    await scaledGeometry(span.locator(".otk-tree-node"));
  });
});

test.describe("outgoing tree", () => {
  test.use({ profile: "contract-messages-v1-notices" });
  test("messages.tree-outgoing-records-mirror-the-same-junction", {
    tag: ["@messages", "@contracts", "@tree"],
  }, async ({ isolatedState: state, page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSession(state, page, "tstv1-otk");
    await scrollTranscript(page, false);
    const closed = page.locator(
      '.otk-record-group-toggle[aria-expanded="false"]',
    );
    await expect(closed.first()).toBeVisible();
    // Open the target's published ancestry, not whichever other groups
    // happen to be mounted. An unrelated user reveal can move this row away.
    const selector = '[data-message="context"] .otk-tree-node';
    await revealAcquired(page, selector);
    const outgoing = page.locator(selector);
    await expect(outgoing.first()).toHaveClass(/is-outgoing/);
    await outgoing.first().locator(".otk-tree-toggle").first().click();
    await geometry(outgoing);
  });
});

test.describe("virtual session tree", () => {
  test.use({ profile: "contract-sessions-hierarchy" });
  test("sessions.tree-virtual-guides-fill-the-row-and-meet-its-center", {
    tag: ["@sessions", "@contracts", "@tree"],
  }, async ({ isolatedState: state, page }) => {
    await openSession(state, page, "tstv1-otk");
    const row = page.locator('.otk-session-row[data-session="tstv1-nested"]')
      .locator("xpath=ancestor::section[@data-tree-node][1]");
    await expect(row).toBeVisible();
    const facts = await row.evaluate((element) => {
      const row = element.getBoundingClientRect();
      // Issue 2.96: TreeNode owns rails beside its heading label, not inside
      // the consumer's row frame.
      const heading = element.querySelector(":scope > .otk-tree-heading")!;
      return Array.from(heading.querySelectorAll(
        ":scope > .otk-tree-lanes > .otk-tree-lane, :scope > .otk-tree-junction",
      )).map(
        (cell) => {
          const box = cell.getBoundingClientRect();
          const connector = cell.querySelector(".otk-tree-connector");
          return {
            blank: cell.matches(".is-blank"),
            height: box.height,
            rowHeight: row.height,
            y: box.y,
            rowY: row.y,
            connector: connector?.getBoundingClientRect().y,
            center: row.y + row.height / 2,
          };
        },
      );
    });
    // The row keeps two ancestor rails and its junction, plus the explicit
    // blank lane that replaces the old unmeasured root spacer.
    expect(facts).toHaveLength(4);
    expect(facts[0].blank).toBe(true);
    expect(facts.filter((fact) => fact.connector !== undefined)).toHaveLength(
      1,
    );
    for (const fact of facts) {
      expect(Math.abs(fact.height - fact.rowHeight)).toBeLessThanOrEqual(1);
      expect(Math.abs(fact.y - fact.rowY)).toBeLessThanOrEqual(1);
      if (fact.connector !== undefined) {
        expect(Math.abs(fact.connector - fact.center)).toBeLessThanOrEqual(1);
      }
    }
  });
});
