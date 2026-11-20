// SPDX-License-Identifier: LGPL-3.0-only
import { expect, type Locator } from "@playwright/test";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";

async function geometry(nodes: Locator) {
  const facts = await nodes.evaluateAll((nodes) =>
    nodes.map((node) => {
      const rail = node.querySelector(
        ":scope > .otk-tree-heading > .otk-tree-own",
      )!;
      const box = rail.querySelector(".otk-tree-toggle");
      const connector = rail.querySelector(".otk-tree-connector")!;
      const upper = rail.querySelector(".otk-tree-upper")!;
      const lower = rail.querySelector(".otk-tree-lower")!;
      const r = rail.getBoundingClientRect(), b = box?.getBoundingClientRect();
      const heading = rail.parentElement!.getBoundingClientRect();
      const c = connector.getBoundingClientRect(),
        u = upper.getBoundingClientRect();
      const content = node.querySelector(
        ":scope > .otk-tree-heading > .otk-tree-label",
      )!.firstElementChild!.getBoundingClientRect();
      const style = getComputedStyle(lower);
      const continuation = node.querySelector(
        ":scope > .otk-tree-body > .otk-tree-continuation",
      );
      const incoming = node.querySelector(
        ":scope > .otk-tree-heading > .otk-tree-incoming",
      );
      const incomingBox = incoming?.getBoundingClientRect();
      const parent = node.parentElement?.closest(".otk-tree-node");
      const parentRail = parent?.querySelector(
        ":scope > .otk-tree-heading > .otk-tree-own",
      )?.getBoundingClientRect();
      const svg = box?.querySelector("svg");
      const parentHeading = parent?.querySelector(":scope > .otk-tree-heading")
        ?.getBoundingClientRect();
      const firstChild = parent?.querySelector(
        ":scope > .otk-tree-body > .otk-tree-children .otk-tree-node",
      );
      const label = node.querySelector(
        ":scope > .otk-tree-heading > .otk-tree-label",
      )!.getBoundingClientRect();
      return {
        connected: node.classList.contains("is-connected"),
        last: node.classList.contains("is-last"),
        outgoing: node.classList.contains("is-outgoing"),
        box: b ? [b.x + b.width / 2, b.y + b.height / 2] : undefined,
        boxSize: b ? [b.width, b.height] : undefined,
        stroke: svg
          ? getComputedStyle(svg.querySelector("rect")!).stroke
          : undefined,
        boxColor: svg ? getComputedStyle(svg).color : undefined,
        muted: getComputedStyle(node).getPropertyValue("--otk-fg-3").trim(),
        junction: [r.x + r.width / 2, r.y + r.height / 2],
        contentCenter: content.y + content.height / 2,
        rowCenter: heading.y + heading.height / 2,
        connector: [c.x, c.right, c.y],
        labelEdge: node.classList.contains("is-outgoing")
          ? label.right
          : label.left,
        parentBottom: firstChild === node ? parentHeading?.bottom : undefined,
        upper: u.bottom,
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
          ? getComputedStyle(continuation, "::before").backgroundImage
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
      expect(fact.boxSize).toEqual([10, 10]);
      expect(fact.stroke).not.toBe("none");
      expect(fact.stroke).toBe(fact.boxColor);
      if (fact.lower !== "none") expect(fact.lower).toContain(fact.boxColor!);
    }
    expect(fact.dots).toBe("1px 2px");
    expect(fact.horizontalDots).toBe("2px 1px");
    if (!fact.connected) continue;
    expect(Math.abs(fact.connector[2] - fact.junction[1])).toBeLessThanOrEqual(
      1,
    );
    expect(Math.abs(fact.upper - fact.junction[1])).toBeLessThanOrEqual(1);
    expect(fact.incomingLower === "none").toBe(fact.last);
    if (fact.parentAxis !== undefined) {
      expect(
        Math.abs(fact.incoming![0] - fact.parentAxis),
        JSON.stringify(fact),
      ).toBeLessThanOrEqual(
        1,
      );
    }
    if (fact.parentBottom !== undefined) {
      expect(Math.abs(fact.incoming![1] - fact.parentBottom))
        .toBeLessThanOrEqual(1);
    }
    expect(Math.abs(fact.connector[fact.outgoing ? 0 : 1] - fact.labelEdge))
      .toBeLessThanOrEqual(1);
    if (fact.last) expect(fact.tail).toBe("none");
  }
  return facts;
}

test.describe("work tree", () => {
  test.use({ profile: "contract-messages-disclosures" });
  test("messages.tree-junction-geometry-keyboard-and-lazy-body", {
    tag: ["@messages", "@contracts", "@tree"],
  }, async ({ isolatedState: state, page }, info) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSession(state, page, "tstv1-otk");
    const root = page.locator(".otk-work-log > .otk-tree-node");
    const toggle = root.locator(":scope > .otk-tree-heading .otk-tree-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.focus();
    await page.keyboard.press("ArrowRight");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const tool = page.locator(".otk-tool-toggle");
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
    const box = await toggle.boundingBox(),
      lamp = await row(directory).locator(".otk-status-light").boundingBox();
    expect(box!.x + box!.width).toBeLessThan(lamp!.x);
    await toggle.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(row(root + "/worktrees/feature-two")).toHaveCount(0);
    await expect(row(root + "/worktrees/feature-one")).toBeVisible();
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
        const connector = element.querySelector(".otk-project-connector")!
          .getBoundingClientRect();
        const marker = element.querySelector(".otk-project-marker")!
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
    await expect(span).toHaveAttribute("data-count", "3");
    await span.locator(".otk-record-group-toggle").first().click();
    const run = span.locator(".otk-record-group");
    await expect(run).toHaveCount(1);
    const toggle = run.locator(
      ":scope > .otk-tree-node > .otk-tree-heading .otk-tree-toggle",
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
  });
});

test.describe("outgoing tree", () => {
  test.use({ profile: "contract-messages-v1-notices" });
  test("messages.tree-outgoing-records-mirror-the-same-junction", {
    tag: ["@messages", "@contracts", "@tree"],
  }, async ({ isolatedState: state, page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openSession(state, page, "tstv1-otk");
    const closed = page.locator(
      '.otk-record-group-toggle[aria-expanded="false"]',
    );
    while (await closed.count()) await closed.first().click();
    const outgoing = page.locator('[data-message="context"] .otk-tree-node');
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
    const row = page.locator('[data-session="tstv1-nested"]');
    await expect(row).toBeVisible();
    const facts = await row.evaluate((element) => {
      const row = element.getBoundingClientRect();
      return Array.from(element.querySelectorAll(".otk-tree-junction")).map(
        (cell) => {
          const box = cell.getBoundingClientRect();
          const connector = cell.querySelector(".otk-tree-connector");
          return {
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
    expect(facts).toHaveLength(2);
    for (const fact of facts) {
      expect(Math.abs(fact.height - fact.rowHeight)).toBeLessThanOrEqual(1);
      expect(Math.abs(fact.y - fact.rowY)).toBeLessThanOrEqual(1);
      if (fact.connector !== undefined) {
        expect(Math.abs(fact.connector - fact.center)).toBeLessThanOrEqual(1);
      }
    }
  });
});
