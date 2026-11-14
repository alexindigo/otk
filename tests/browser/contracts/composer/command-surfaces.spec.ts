// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/composer.ts";
import {
  compactionBoundary,
  expectCompactionSummary,
  openRecord,
} from "../../pages/transcript.ts";

test.use({ profile: "composer-commands" });
test(
  "composer.command-surfaces-compact-is-discoverable-through-both-generic-projections",
  {
    tag: ["@composer", "@menus", "@isolated"],
  },
  async ({ isolatedState: state, page }, info) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Command registry",
    });
    await openSession(state, page, session.id);
    await expect(page.locator(".otk-composer-model-name")).not.toHaveText("");
    await page.evaluate(() => document.fonts.ready);
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await prompt(page).fill("/compact");
      await expect(
        page.locator(".otk-autocomplete button").filter({
          hasText: "/compact",
        }),
      ).toBeVisible();
      await page.screenshot({ path: info.outputPath(`${theme}-slash.png`) });
      await prompt(page).press("Escape");
      await prompt(page).fill("Keep this draft");
      await page.keyboard.press("Control+k");
      const search = page.getByRole("textbox", { name: "Find a command" });
      await search.fill("compact");
      await expect(page.locator('[data-command="session.compact"]'))
        .toBeVisible();
      await page.screenshot({ path: info.outputPath(`${theme}-palette.png`) });
      await page.keyboard.press("Escape");
      await expect(prompt(page)).toHaveValue("Keep this draft");
    }
  },
);

test("composer.skills-picker-retains-native-identities-and-name-conflicts", {
  tag: ["@composer", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Skill picker",
  });
  await openSession(state, page, session.id);
  await expect(page.locator(".otk-composer-model-name")).toHaveText("scripted");
  for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await prompt(page).fill("/canary");
    await expect(
      page.locator(".otk-autocomplete button").filter({ hasText: "/canary" }),
    ).toHaveCount(0);
    await prompt(page).fill("/skills");
    await expect(page.locator(".otk-autocomplete")).not.toContainText(
      "/canary",
    );
    await prompt(page).press("Enter");
    const search = page.getByRole("combobox", { name: "Search skills" });
    await expect(search).toBeFocused();
    await expect(page.getByRole("listbox", { name: "Skills" })).toBeVisible();
    await expect(
      page.locator(".otk-skills-picker .otk-picker-option").filter({
        hasText: "canary",
      }),
    ).toBeVisible();
    const geometry = await page.locator(".otk-skills-picker").evaluate(
      (root) => {
        const rect = (selector: string) => {
          const box = root.querySelector(selector)!.getBoundingClientRect();
          return { x: box.x, y: box.y, right: box.right, bottom: box.bottom };
        };
        return {
          panel: rect(".otk-popover-panel"),
          heading: rect(".otk-picker-heading"),
          search: rect("input"),
          list: rect("[role=listbox]"),
        };
      },
    );
    expect(geometry.panel.x).toBeGreaterThanOrEqual(0);
    expect(geometry.panel.right).toBeLessThanOrEqual(1280);
    expect(geometry.panel.y).toBeGreaterThanOrEqual(0);
    expect(geometry.panel.bottom).toBeLessThanOrEqual(800);
    expect(geometry.heading.bottom).toBeLessThanOrEqual(geometry.search.y);
    expect(geometry.search.bottom).toBeLessThanOrEqual(geometry.list.y);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: info.outputPath(`${theme}-skills-open.png`),
    });
    await search.fill("probe");
    const probe = page.locator(".otk-skills-picker .otk-picker-option").filter({
      hasText: "probe",
    });
    if (state.controller.info!.version.startsWith("1.")) {
      await expect(probe).toBeDisabled();
      await expect(probe).toContainText(
        "Shadowed by the server command /probe in opencode 1.x",
      );
      await search.press("Enter");
      await expect(search).toBeVisible();
    } else {
      await expect(probe).toBeEnabled();
    }
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: info.outputPath(`${theme}-skills.png`) });
    await page.keyboard.press("Escape");
    await expect(prompt(page)).toBeFocused();
    expect(
      await page.locator(".otk-skill-anchor").evaluate((element) =>
        element.getBoundingClientRect().height
      ),
    )
      .toBe(0);
  }
  const v2 = state.controller.info!.version.startsWith("2.");
  await state.queue([v2 ? "Independent skill activated." : "Skill activated."]);
  await prompt(page).fill("/skills");
  await prompt(page).press("Enter");
  const search = page.getByRole("combobox", { name: "Search skills" });
  await search.fill(v2 ? "probe" : "canary");
  await search.press("Enter");
  // NT2: a V2 skill is a plugin record whose content sits in its closed body.
  if (v2) await openRecord(page, '[data-native-record="opencode-v2/skill"]');
  await expect(page.locator(".otk-messages")).toContainText(
    v2 ? "COLLIDING-SKILL content" : "SKILL-FIXTURE content",
  );
  await expect(page.locator("[data-role=assistant] .otk-text")).toContainText(
    v2 ? "Independent skill activated." : "Skill activated.",
  );
  await expect(prompt(page)).toHaveValue("");
});

test(
  "composer.native-compact-runs-once-with-the-effective-model-and-unsupported-never-prompts",
  {
    tag: ["@composer", "@isolated"],
  },
  async ({ isolatedState: state, page }) => {
    const frames = await wire(page);
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Slash execution",
      messages: [{ parts: [{ type: "text", text: "Context to summarize" }] }],
    });
    await openSession(state, page, session.id);
    await expect(page.locator(".otk-composer-model-name")).toHaveText(
      "scripted",
    );
    await state.queue(["## Objective\n\nA registry command summary."]);
    await prompt(page).fill("/compact");
    await prompt(page).press("Enter");
    // NT4: V1 compaction is a plugin boundary record; V2 keeps the divider.
    const compaction = compactionBoundary(state);
    await expect(page.locator(compaction.title)).toHaveText(
      compaction.completed,
    );
    await expectCompactionSummary(
      state,
      page,
      "A registry command summary.",
    );
    const compact = frames.sent.filter(({ frame }) =>
      frame.method === "session.compact"
    );
    expect(compact).toHaveLength(1);
    expect(compact[0].frame.params?.model).toEqual({
      provider: "fake",
      model: "scripted",
    });
    const before = frames.sent.length;
    await prompt(page).fill("/terminal");
    await prompt(page).press("Enter");
    await expect(page.locator(".otk-composer-dock [role=alert]")).toBeVisible();
    await expect(prompt(page)).toHaveValue("/terminal");
    expect(
      frames.sent.slice(before).filter(({ frame }) =>
        ["session.prompt", "session.command", "session.shell"].includes(
          frame.method ?? "",
        )
      ),
    ).toHaveLength(0);
  },
);
