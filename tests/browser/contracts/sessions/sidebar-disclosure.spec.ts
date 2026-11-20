// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { wire } from "../../fixtures/wire.ts";
import { activity } from "../../pages/sessions.ts";

test.describe("sidebar disclosure intent", () => {
  test.use({ profile: "contract-sessions-worktrees" });
  test("projects.disclosure-mouse-immediate-held-save-keyboard-and-reload", {
    tag: ["@projects", "@contracts"],
  }, async ({ isolatedState: state, page }, info) => {
    const { root, entries } = await state.observe<
      { root: string; entries: { directory: string }[] }
    >();
    const directory = entries[0].directory;
    const row = (path: string) =>
      page.locator(`.otk-project-row[data-project=${JSON.stringify(path)}]`);
    const frames = await wire(page);
    await page.goto(state.url);
    const parent = row(directory).locator(
      "xpath=ancestor::section[contains(@class,'otk-tree-node')][1]",
    );
    const toggle = parent.locator(
      ":scope > .otk-tree-heading .otk-tree-toggle",
    );
    const before = page.url();
    frames.hold((frame, request) =>
      frame.t === "prefs" || request?.method === "layout.project"
    );
    const pointer = await toggle.locator("svg").evaluate((svg) => {
      const box = svg.getBoundingClientRect();
      return document.elementFromPoint(
        box.x + box.width / 2,
        box.y + box.height / 2,
      )?.closest("button")?.className;
    });
    expect(pointer).toBe("otk-tree-toggle");
    await toggle.locator("svg").click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(row(root + "/worktrees/feature-two")).toHaveCount(0);
    await expect(row(root + "/worktrees/feature-one")).toHaveCount(0);
    await expect(parent.locator(".otk-archived-toggle")).toHaveCount(0);
    await expect(row(directory)).toHaveAttribute("data-rollup", "working");
    expect(page.url()).toBe(before);
    await expect.poll(() => frames.held.length).toBeGreaterThan(0);
    await toggle.press("ArrowRight");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(row(root + "/worktrees/feature-two")).toBeVisible();
    // An old acknowledgement and preference frame cannot replace the newer choice.
    frames.release();
    await expect.poll(async () =>
      (await state.product("prefs.get", {})).shellLayout.projectCollapsed
        ?.[JSON.stringify(["local", directory])]
    ).toBe(false);
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await activity(state, "tstv1-worktree-1", "hold");
    await toggle.click();
    await expect(row(root + "/worktrees/feature-two")).toHaveCount(0);
    await expect(row(root + "/worktrees/feature-one")).toHaveCount(0);
    await expect(row(directory)).not.toHaveAttribute("data-rollup", "none");
    await toggle.click();
    await expect(row(root + "/worktrees/feature-one")).toBeVisible();
    await expect(row(root + "/worktrees/feature-two")).toBeVisible();
    await info.attach("sidebar-dispatch", {
      body: JSON.stringify({
        pointer,
        requests: frames.sent.filter((r) =>
          r.frame.method === "layout.project"
        ),
        held: frames.received.filter((f) => f.t === "prefs"),
      }),
      contentType: "application/json",
    });
  });

  test("projects.disclosure-refusal-is-local-and-retries-captured-intent", {
    tag: ["@projects", "@contracts"],
  }, async ({ isolatedState: state, page }, info) => {
    const { entries } = await state.observe<
      { entries: { directory: string }[] }
    >();
    let refuse = true;
    let saves = 0;
    const refusals = new Set<string>();
    await page.routeWebSocket("**/ws", (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((message) => {
        const frame = JSON.parse(message.toString());
        if (frame.t === "request" && frame.method === "layout.project") {
          saves++;
          if (refuse) {
            refusals.add(frame.ref.key);
            frame.params.collapsed = "refused";
          }
        }
        server.send(JSON.stringify(frame));
      });
      server.onMessage((message) => {
        const frame = JSON.parse(message.toString());
        if (refusals.has(frame.ref?.key)) {
          const failure = frame.t === "request.rejected"
            ? frame.error
            : frame.t === "request.result" && !frame.outcome.ok
            ? frame.outcome.error
            : undefined;
          // Supply a producer-authored public reason on the real refusal envelope.
          if (failure) {
            failure.facts = {
              ...failure.facts,
              reason: "The project layout is not valid.",
            };
          }
        }
        socket.send(JSON.stringify(frame));
      });
    });
    await page.goto(state.url);
    const parent = page.locator(
      `.otk-project-row[data-project=${JSON.stringify(entries[0].directory)}]`,
    ).locator("xpath=ancestor::section[contains(@class,'otk-tree-node')][1]");
    const toggle = parent.locator(
      ":scope > .otk-tree-heading .otk-tree-toggle",
    );
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const feedback = parent.locator(
      ":scope > .otk-tree-feedback .otk-project-disclosure-error",
    );
    await expect(feedback).toBeVisible();
    await expect(feedback).toContainText("The project layout is not valid.");
    const geometry = await parent.evaluate((node) => {
      const toggle = node.querySelector(
        ":scope > .otk-tree-heading .otk-tree-toggle",
      )!.getBoundingClientRect();
      const row = node.querySelector(
        ":scope > .otk-tree-heading .otk-project-row",
      )!.getBoundingClientRect();
      const lamp = node.querySelector(
        ":scope > .otk-tree-heading .otk-status-light",
      )!.getBoundingClientRect();
      return {
        delta: Math.abs(
          toggle.y + toggle.height / 2 - lamp.y - lamp.height / 2,
        ),
        height: row.height,
      };
    });
    expect(geometry.delta).toBeLessThanOrEqual(1);
    expect(geometry.height).toBe(32);
    await expect(
      page.locator(".otk-inbox-footer .otk-feedback-status[role=alert]"),
    ).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath("wp15-save-refusal.png"),
      fullPage: true,
    });
    refuse = false;
    await feedback.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(feedback).toHaveCount(0);
    await expect.poll(async () =>
      (await state.product("prefs.get", {})).shellLayout.projectCollapsed
        ?.[JSON.stringify(["local", entries[0].directory])]
    ).toBe(true);
    expect(saves).toBe(2);
  });
});

test.describe("sidebar row-level presentation", () => {
  test.use({ profile: "contract-sessions-removed" });
  test("projects.sidebar-meta-and-project-only-artwork-three-themes", {
    tag: ["@projects", "@contracts"],
  }, async ({ isolatedState: state, page }, info) => {
    const { root, entries } = await state.observe<
      { root: string; entries: { directory: string }[] }
    >();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(state.url);
    await page.locator(".otk-archived-toggle").click();
    await page.locator(".otk-inactive-toggle").click();
    const parent = page.locator(
      `.otk-project-row[data-project=${JSON.stringify(entries[0].directory)}]`,
    );
    await expect(parent.locator(".otk-project-avatar")).toHaveCount(1);
    await expect(parent.locator(".otk-project-name")).toHaveText(
      "Fixture project",
    );
    for (const name of ["feature-one", "feature-two", "archived-tree"]) {
      await expect(
        page.locator(
          `.otk-project-row[data-project=${
            JSON.stringify(root + "/worktrees/" + name)
          }] .otk-project-avatar`,
        ),
      ).toHaveCount(0);
      await expect(
        page.locator(
          `.otk-project-row[data-project=${
            JSON.stringify(root + "/worktrees/" + name)
          }] .otk-project-name`,
        ),
      ).toHaveText(name);
    }
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
      const values = await page.locator(
        ".otk-archived-toggle, .otk-inactive-toggle, .otk-discovered-toggle",
      ).evaluateAll((headers) =>
        headers.map((header) => {
          const meta = header.querySelector(".otk-chrome-meta")!;
          const visit = document.querySelector(".otk-project-visit")!;
          const label = header.querySelector(".otk-control-label")!;
          const m = meta.getBoundingClientRect(),
            l = label.getBoundingClientRect();
          const style = getComputedStyle(meta),
            reference = getComputedStyle(visit);
          return {
            text: meta.textContent,
            font: style.fontSize,
            color: style.color,
            referenceFont: reference.fontSize,
            referenceColor: reference.color,
            centerDelta: Math.abs(m.y + m.height / 2 - l.y - l.height / 2),
          };
        })
      );
      expect(values.length).toBeGreaterThanOrEqual(2);
      for (const value of values) {
        expect(value.text).toMatch(/^\d+$/);
        expect(value.font).toBe(value.referenceFont);
        expect(value.color).toBe(value.referenceColor);
        expect(value.centerDelta).toBeLessThanOrEqual(1);
      }
      await page.screenshot({
        path: info.outputPath(`wp15-sidebar-${name}.png`),
        fullPage: true,
      });
    }
  });
});

test.describe("sidebar branch topology cases", () => {
  test.use({ profile: "contract-sessions-sidebar" });
  test(
    "projects.sidebar-empty-required-archive-only-missing-root-mixed-large",
    {
      tag: ["@projects", "@contracts"],
    },
    async ({ isolatedState: state, page }) => {
      const { root } = await state.observe<{ root: string }>();
      await page.goto(state.url);
      const row = (path: string) =>
        page.locator(`.otk-project-row[data-project=${JSON.stringify(path)}]`);
      const branch = (mode: string) =>
        row(`${root}/sidebar/${mode}`).locator(
          "xpath=ancestor::section[contains(@class,'otk-tree-node')][1]",
        );
      const toggle = (mode: string) =>
        branch(mode).locator(":scope > .otk-tree-heading .otk-tree-toggle");
      await expect(row(`${root}/sidebar/empty`)).toBeVisible();
      await expect(toggle("empty")).toHaveCount(0);
      await toggle("all-required").click();
      for (let n = 0; n < 2; n++) {
        await expect(
          row(`${root}/sidebar/all-required-child-${n}`),
        ).toHaveCount(0);
      }
      await expect(row(`${root}/sidebar/all-required`)).not.toHaveAttribute(
        "data-rollup",
        "none",
      );
      await toggle("all-required").click();
      for (let n = 0; n < 2; n++) {
        await expect(row(`${root}/sidebar/all-required-child-${n}`))
          .toBeVisible();
      }
      await expect(branch("archive-only").locator(".otk-archived-toggle"))
        .toBeVisible();
      await toggle("archive-only").click();
      await expect(branch("archive-only").locator(".otk-archived-toggle"))
        .toHaveCount(0);
      await toggle("archive-only").click();
      await branch("archive-only").locator(".otk-archived-toggle").click();
      await expect(row(`${root}/sidebar/archive-only-child-0`)).toBeVisible();
      await expect(row(`${root}/sidebar/missing-root-child-0`)).toBeAttached();
      await expect(
        row(`${root}/sidebar/missing-root-child-0`).locator(
          ".otk-project-avatar",
        ),
      ).toHaveCount(0);
      await toggle("large").click();
      await expect(row(`${root}/sidebar/large-child-0`)).toHaveCount(0);
      await toggle("large").press("ArrowRight");
      await expect(row(`${root}/sidebar/large-child-39`)).toBeAttached();
      await page.locator(".otk-inactive-toggle").click();
      await expect(row(`${root}/sidebar/mixed-child-1`)).toBeAttached();
      await expect(
        row(`${root}/sidebar/mixed-child-1`).locator(".otk-project-avatar"),
      ).toHaveCount(0);
    },
  );
});

test.describe("discovered disclosure", () => {
  test.use({ profile: "contract-sessions-catalog" });
  test("projects.discovered-immediate-intent-and-shared-count-meta", {
    tag: ["@projects", "@contracts"],
  }, async ({ isolatedState: state, page }) => {
    const frames = await wire(page);
    await page.goto(state.url);
    const header = page.locator(".otk-discovered-toggle");
    await expect(header).toHaveAttribute("aria-expanded", "true");
    const text = await header.locator(".otk-chrome-meta").textContent();
    expect(text).toMatch(/^\d+$/);
    await expect(header).toHaveAccessibleName(`Discovered projects, ${text}`);
    frames.hold((frame, request) =>
      frame.t === "prefs" || request?.method === "layout.patch"
    );
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(
      page.locator(
        ".otk-discovered-projects .otk-project-row[data-rollup=none]",
      ),
    ).toHaveCount(0);
    frames.release();
    await expect.poll(async () =>
      (await state.product("prefs.get", {})).shellLayout.discoveredCollapsed
    ).toBe(true);
    await page.reload();
    await expect(header).toHaveAttribute("aria-expanded", "false");
  });
});
