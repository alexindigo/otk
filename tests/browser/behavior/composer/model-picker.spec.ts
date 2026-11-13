// SPDX-License-Identifier: LGPL-3.0-only
// Native picker behavior, shared row semantics and retained action focus.
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { wire } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/composer.ts";

test.use({ profile: "composer-pickers" });
test("composer.catalog-demand-warms-the-selected-native-working-folder", {
  tag: ["@composer", "@load", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const directory = `${state.directory}/nested`;
  await state.controller.call("writeProjectFiles", {
    lease: state.lease.lease,
    files: { "nested/pk2-folder.txt": "Nested folder" },
  });
  const session = await state.product("session.create", {
    directory,
    title: "Nested catalog demand",
  });
  const frames = await wire(page);
  await page.goto(`${state.url}/#/local/${session.id}`);
  await expect(prompt(page)).toBeVisible();
  await expect.poll(() =>
    [
      ...new Set(
        frames.received.filter((frame) =>
          frame.t === "catalog.chunk" && frame.directory === directory &&
          frame.last &&
          ["agents", "commands", "models", "skills"].includes(
            String(frame.kind),
          )
        ).map((frame) => frame.kind),
      ),
    ].sort()
  ).toEqual(["agents", "commands", "models", "skills"]);
  expect(
    frames.sent.some(({ frame }) =>
      frame.method === "catalogs.demand" &&
      frame.params?.directory === directory && frame.params?.intent === "warm"
    ),
  ).toBe(true);
  const picker = page.locator(".otk-model-picker");
  await picker.locator(":scope > button").click();
  await expect(picker.locator("[role=option]").first()).toBeVisible();
});
test(
  "composer.catalog-demand-warms-current-choices-and-discovers-files-on-mention",
  {
    tag: ["@composer", "@load", "@isolated"],
  },
  async ({ isolatedState: state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Catalog demand",
    });
    await state.controller.call("writeProjectFiles", {
      lease: state.lease.lease,
      files: { "pk2-demand.txt": "Mention-only discovery" },
    });
    const frames = await wire(page);
    await page.goto(`${state.url}/#/local/${session.id}`);
    await expect(prompt(page)).toBeVisible();
    const completeKinds = () =>
      [
        ...new Set(
          frames.received.filter((frame) =>
            frame.t === "catalog.chunk" && frame.last
          ).map((frame) => frame.kind),
        ),
      ].sort();
    // Pending-question authority has an independent consumer on V1. It is not
    // choice warm-up and must not be suppressed with unused optional catalogs.
    await expect.poll(() =>
      completeKinds().filter((kind) =>
        ["agents", "commands", "models", "skills"].includes(String(kind))
      )
    ).toEqual([
      "agents",
      "commands",
      "models",
      "skills",
    ]);
    for (const kind of ["files", "resources", "resourceTemplates", "config"]) {
      expect(completeKinds()).not.toContain(kind);
    }
    const demands = () =>
      frames.sent.filter(({ frame }) =>
        frame.t === "request" && frame.method === "catalogs.demand"
      ).map(({ frame }) => frame.params);
    expect(demands()).toEqual([{
      directory: state.directory,
      kinds: ["models", "agents", "commands", "skills"],
      intent: "warm",
    }]);
    await prompt(page).fill("@pk2-demand");
    await expect(page.locator(".otk-autocomplete")).toContainText(
      "pk2-demand.txt",
    );
    expect(demands()).toContainEqual({
      directory: state.directory,
      kinds: ["files"],
      intent: "consumer",
    });
    expect(completeKinds()).toContain("files");
    const resources = frames.received.some((frame) =>
      frame.t === "welcome" &&
      (frame.sidecar as { harness: { capabilities?: string[] } }).harness
        .capabilities?.includes("resources")
    );
    if (resources) {
      expect(demands()).toContainEqual({
        directory: state.directory,
        kinds: ["resources"],
        intent: "consumer",
      });
    } else expect(completeKinds()).not.toContain("resources");
    expect(completeKinds()).not.toContain("resourceTemplates");
    await prompt(page).fill("");
    const before = demands().length;
    const picker = page.locator(".otk-model-picker");
    await picker.locator(":scope > button").click();
    await expect(picker.locator("[role=option]").first()).toBeVisible();
    expect(demands()).toHaveLength(before);
    await picker.locator(".otk-picker-status button").click();
    await expect.poll(() =>
      frames.sent.filter(({ frame }) => frame.method === "catalogs.refresh")
        .map(({ frame }) => frame.params)
    ).toEqual([{ directory: state.directory, kinds: ["models"] }]);
    await expect(picker.locator("[role=status]")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await prompt(page).fill("/skills");
    await prompt(page).press("Enter");
    await expect(page.getByRole("combobox", { name: "Search skills" }))
      .toBeVisible();
    await page.locator(".otk-skills-picker .otk-picker-status button").click();
    await expect.poll(() =>
      frames.sent.filter(({ frame }) => frame.method === "catalogs.refresh")
        .map(({ frame }) => frame.params)
    ).toEqual([
      { directory: state.directory, kinds: ["models"] },
      { directory: state.directory, kinds: ["skills"] },
    ]);
    await expect(page.locator(".otk-skills-picker [role=status]")).toHaveCount(
      0,
    );
    expect(frames.sent.filter(({ frame }) => frame.method === "catalogs.watch"))
      .toHaveLength(1);
  },
);
test("composer.model-picker-warm-before-open-and-independent-candidate", {
  tag: ["@composer", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  test.setTimeout(120000);
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "INV-P picker observations",
  });
  const frames = await wire(page), start = performance.now();
  await page.goto(`${state.url}/#/local/${session.id}`);
  await expect(prompt(page)).toBeVisible();
  const promptVisibleMs = performance.now() - start;
  await expect.poll(() =>
    frames.received.some((frame) =>
      frame.t === "catalog.chunk" && frame.kind === "models" && frame.last
    )
  ).toBe(true);
  const modelsBeforeOpenMs = performance.now() - start;
  const requestCount = () =>
    frames.sent.filter(({ frame }) =>
      frame.t === "request" &&
      /^(catalogs\.|models\.list)/.test(String(frame.method))
    ).length;
  const before = requestCount(), picker = page.locator(".otk-model-picker");
  await picker.locator(":scope > button").click();
  const rows = picker.locator("[role=option]");
  await expect(rows.first()).toBeVisible();
  await expect(picker.locator(".otk-picker-status button")).toHaveText(
    "Refresh",
  );
  expect(await picker.locator("h3").allTextContents()).not.toContain("Refresh");
  const selected = picker.locator("[role=option][aria-selected=true]");
  await expect(selected).toHaveCount(1);
  const committed = await selected.getAttribute("data-picker-key");
  // Choose a different identity, not an element index coupled to provider order.
  const otherKey = await rows.evaluateAll(
    (elements, current) =>
      elements.find((el) => el.getAttribute("data-picker-key") !== current)
        ?.getAttribute("data-picker-key"),
    committed,
  );
  expect(otherKey).toBeTruthy();
  const other = picker.locator(`[data-picker-key=${JSON.stringify(otherKey)}]`);
  await other.hover();
  await expect(other).toHaveClass(/is-highlighted/);
  await expect(selected).toHaveAttribute("data-picker-key", committed!);
  await expect(picker.locator("[role=option].is-highlighted")).toHaveCount(1);
  expect(requestCount()).toBe(before);
  const geometry = await picker.evaluate((root) => {
    const fact = (el: Element) => {
      const style = getComputedStyle(el), rect = el.getBoundingClientRect();
      return {
        text: el.textContent?.trim(),
        role: el.getAttribute("role"),
        classes: el.className,
        color: style.color,
        background: style.backgroundColor,
        weight: style.fontWeight,
        size: style.fontSize,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    };
    return {
      headings: Array.from(root.querySelectorAll("h3"), fact),
      selected: Array.from(root.querySelectorAll(".is-selected"), fact),
      highlighted: Array.from(root.querySelectorAll(".is-highlighted"), fact),
      refresh: fact(root.querySelector(".otk-picker-status button")!),
    };
  });
  await info.attach("inv-p-observations", {
    body: JSON.stringify(
      {
        nativeVersion: info.project.name,
        promptVisibleMs,
        modelsBeforeOpenMs,
        catalogRequests: frames.sent.filter(({ frame }) =>
          /^(catalogs\.|models\.list)/.test(String(frame.method))
        ).map(({ frame, time }) => ({
          method: frame.method,
          ms: time - start,
        })),
        geometry,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  await page.screenshot({
    path: info.outputPath("inv-p-picker.png"),
    fullPage: true,
  });
  await page.keyboard.press("End");
  await expect(selected).toHaveAttribute("data-picker-key", committed!);
  await expect(picker.locator("[role=option].is-highlighted")).toHaveCount(1);
  const search = picker.locator("input[type=search]");
  const active = async () => {
    const id = await search.getAttribute("aria-activedescendant");
    const row = page.locator(`[id=${JSON.stringify(id)}]`);
    await expect(row).toBeVisible();
    await expect(row).toHaveClass(/is-highlighted/);
    return row;
  };
  await search.press("Home");
  await active();
  await search.press("End");
  const end = await active();
  await expect(end).toHaveAttribute("aria-setsize", /\d+/);
  const group = end.locator("..");
  await expect(group).toHaveAttribute("role", "group");
  await expect(group).toHaveAttribute("aria-label", /.+/);
  // An action keeps its keyed row and focus when favourite regrouping moves it.
  const action = end.locator(".otk-picker-action");
  await action.focus();
  const label = await action.getAttribute("aria-label");
  await action.press("Enter");
  await expect(action).toBeFocused();
  await expect(action).not.toHaveAttribute("aria-label", label!);
  await expect(picker.locator("[aria-selected=true]")).toHaveAttribute(
    "data-picker-key",
    committed!,
  );
  // Rapid query replacement retires older reveal requests, including no matches.
  await search.fill("missing-picker-fixture");
  await expect(picker.locator(".otk-picker-empty")).toHaveText("No matches.");
  await search.fill("Scripted");
  await active();
  await search.fill("");
  await active();
  await page.keyboard.press("Escape");
  await picker.locator(":scope > button").click();
  expect(requestCount()).toBe(before);
});
