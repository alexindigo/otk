// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { messages, prompt, reply } from "../../pages/composer.ts";
import type { Page } from "@playwright/test";
import type { TestState } from "../../fixtures/test-state.ts";

const openPicker = async (page: Page, kind: string) => {
  await page.locator(`.otk-${kind}-picker > button`).click();
  const panel = page.locator(`.otk-${kind}-picker .otk-popover-panel`);
  await expect(panel).toBeVisible();
  await expect.poll(() =>
    panel.evaluate((element) => element.contains(document.activeElement))
  ).toBe(true);
};
const pick = async (page: Page, kind: string, key: string) => {
  await openPicker(page, kind);
  await page.locator(
    `.otk-${kind}-picker [data-picker-key=${
      JSON.stringify(key)
    }] .otk-picker-option`,
  ).click();
  await expect(prompt(page)).toBeFocused();
};
const queue = (state: TestState, text: string) =>
  state.controller.call("queueScript", {
    lease: state.lease.lease,
    target: "selected",
    chunks: [text],
  });
const requests = async (state: TestState) =>
  (await state.observe<
    { selectedRequests: Record<string, unknown>[]; requests: unknown[] }
  >()).selectedRequests;

test.describe("native picker choices", () => {
  test.use({ profile: "composer-pickers" });
  test("composer.pickers-native-selection-favourites-keys-slash-shell", {
    tag: ["@composer", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    test.setTimeout(120_000);
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Composer pickers",
    });
    const other = await state.native<{ id: string }>("/session", "POST", {
      title: "Other session",
    });
    const frames = await wire(page);
    await openSession(state, page, session.id);
    await expect(page.locator(".otk-prompt-context .otk-picker-groups"))
      .toHaveCount(0);
    await pick(page, "agent", "reviewer");
    await expect(page.locator(".otk-composer-agent")).toHaveText("Reviewer");
    await page.keyboard.press("Control+'");
    const search = page.locator(".otk-model-picker input[type=search]");
    await expect(search).toBeFocused();
    await search.pressSequentially("Scripted with variants");
    await expect(page.locator(".otk-model-picker .otk-picker-option"))
      .toHaveCount(1);
    await search.press("Enter");
    await expect(prompt(page)).toBeFocused();
    await openPicker(page, "variant");
    await expect(page.locator(".otk-variant-picker .otk-picker-name > span"))
      .toHaveText(["Default", "Low", "High"]);
    await page.locator('.otk-variant-picker [data-picker-key="high"]').click();
    await expect(prompt(page)).toBeFocused();
    await openPicker(page, "variant");
    await page.keyboard.press("Home");
    await expect(page.locator('.otk-variant-picker [data-picker-key=""]'))
      .toHaveClass(/is-highlighted/);
    await expect(page.locator('.otk-variant-picker [data-picker-key="high"]'))
      .toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page.locator(".otk-variant-picker > button > span"))
      .toHaveText("Default");
    await openPicker(page, "variant");
    for (const key of ["End", "ArrowUp", "ArrowDown"]) {
      await page.keyboard.press(key);
    }
    await expect(page.locator('.otk-variant-picker [data-picker-key="high"]'))
      .toHaveClass(/is-highlighted/);
    await page.keyboard.press("Home");
    await page.keyboard.down("ArrowDown");
    await page.keyboard.down("ArrowDown");
    await page.keyboard.up("ArrowDown");
    await expect(page.locator('.otk-variant-picker [data-picker-key="high"]'))
      .toHaveClass(/is-highlighted/);
    await page.keyboard.press("Enter");
    await openPicker(page, "model");
    await search.fill("Scripted with variants");
    await page.getByRole("button", {
      name: "Add Scripted with variants to favourites",
      exact: true,
    }).click();
    await expect(page.locator(".otk-model-picker h3").first()).toHaveText(
      "Favourites",
    );
    await expect(
      page.locator(".otk-model-picker .otk-picker-name small").first(),
    ).toHaveText("Second fixture provider");
    await page.keyboard.press("Escape");
    await expect(page.locator(".otk-prompt-context .otk-picker-groups"))
      .toHaveCount(0);
    const selected = {
      agent: "reviewer",
      model: { provider: "fake2", model: "scripted" },
      variant: "high",
    };
    await queue(state, "Selected provider replied.");
    await prompt(page).fill("PICKER-NORMAL selected model");
    await prompt(page).press("Enter");
    await reply(state, page, session.id, "Selected provider replied.");
    const normal = frames.sent.find(({ frame }) =>
      frame.method === "session.prompt"
    )!.frame.params!;
    expect({
      agent: normal.agent,
      model: normal.model,
      variant: normal.variant,
    }).toEqual(selected);
    const native = await messages(state, session.id);
    expect(native.find((row) => row.info.role === "user")!.info).toMatchObject({
      agent: "reviewer",
      model: { providerID: "fake2", modelID: "scripted", variant: "high" },
    });
    expect((await state.observe<{ requests: unknown[] }>()).requests)
      .toHaveLength(0);
    expect(
      (await requests(state)).some((request) =>
        JSON.stringify(request.messages).includes("PICKER-NORMAL") &&
        request.model === "scripted" && request.reasoning_effort === "high"
      ),
    ).toBe(true);
    await expect.poll(async () =>
      (await state.product("prefs.get", {}))["models.recent"][0]
    ).toEqual(selected.model);
    await page.reload();
    await expect(page.locator(".otk-composer-agent")).toHaveText("Reviewer");
    await expect(page.locator(".otk-variant-picker > button > span"))
      .toHaveText("High");
    await openSession(state, page, other.id);
    await openSession(state, page, session.id);
    await expect(page.locator(".otk-composer-model-name")).toHaveText(
      "Scripted with variants",
    );
    await openPicker(page, "model");
    await expect(
      page.locator(".otk-model-picker section").first().locator("h3"),
    ).toHaveText("Favourites");
    await expect(
      page.getByRole("button", {
        name: "Remove Scripted with variants from favourites",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator(".otk-model-picker [role=status]")).toHaveCount(
      0,
    );
    const reads = () =>
      frames.sent.filter(({ frame }) =>
        ["models.list", "catalogs.watch", "catalogs.refresh"].includes(
          String(frame.method),
        )
      ).length;
    const before = reads();
    await page.keyboard.press("Escape");
    await openPicker(page, "model");
    expect(reads()).toBe(before);
    await page.locator(".otk-model-picker .otk-picker-status button").click();
    await expect.poll(reads).toBeGreaterThan(before);
    await search.fill("Second fixture provider");
    await search.press("End");
    await expect(
      page.locator(
        `.otk-model-picker [data-picker-key='${
          JSON.stringify(["fake2", "scripted"])
        }']`,
      ),
    ).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await queue(state, "Slash selection replied.");
    await prompt(page).fill("/probe chosen");
    await prompt(page).press("Enter");
    await reply(state, page, session.id, "Slash selection replied.");
    const command = frames.sent.filter(({ frame }) =>
      frame.method === "session.command"
    ).at(-1)!.frame.params!;
    expect({
      agent: command.agent,
      model: command.model,
      variant: command.variant,
    }).toEqual(selected);
    expect(
      (await requests(state)).some((request) =>
        JSON.stringify(request.messages).includes("PICKER-COMMAND chosen") &&
        request.reasoning_effort === "high"
      ),
    ).toBe(true);
    await prompt(page).press("!");
    await expect(page.locator(".otk-prompt > label")).toHaveText("Shell");
    await expect(page.locator(".otk-variant-picker")).toHaveCount(0);
    expect(
      await page.locator(".otk-prompt-context > .otk-popover > button")
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("aria-label"))
        ),
    ).toEqual([
      "Agent: Reviewer",
      "Model: Second fixture provider Scripted with variants",
    ]);
    await prompt(page).pressSequentially("echo PICKER-SHELL");
    await prompt(page).press("Enter");
    await expect(page.locator("[data-tool=bash][data-tool-status=completed]"))
      .toContainText("PICKER-SHELL");
    const shell = frames.sent.filter(({ frame }) =>
      frame.method === "session.shell"
    ).at(-1)!.frame.params!;
    expect({ agent: shell.agent, model: shell.model }).toEqual({
      agent: selected.agent,
      model: selected.model,
    });
    expect(Object.hasOwn(shell, "variant")).toBe(false);
    // Native V2 shell is its own persisted input kind, not a synthetic user.
    const users = (await messages(state, session.id)).filter((row) =>
      ["user", "shell"].includes(row.info.role)
    );
    expect(users.length).toBeGreaterThanOrEqual(3);
    for (const row of users) {
      expect(row.info).toMatchObject({
        agent: "reviewer",
        model: { providerID: "fake2", modelID: "scripted" },
      });
    }
    await prompt(page).focus();
    await page.keyboard.press("Control+'");
    await expect(search).toBeFocused();
    await search.pressSequentially("Plain model");
    await expect(page.locator(".otk-model-picker .otk-picker-option"))
      .toHaveCount(1);
    await search.press("Enter");
    await expect(page.locator(".otk-variant-picker")).toHaveCount(0);
    await expect(page.locator(".otk-composer-model-name")).toHaveText(
      "Plain model",
    );
    await page.keyboard.press("Control+'");
    await search.pressSequentially("Scripted with variants");
    await expect(page.locator(".otk-model-picker .otk-picker-option"))
      .toHaveCount(1);
    await search.press("Enter");
    await expect(page.locator(".otk-variant-picker > button > span"))
      .toHaveText("Default");
    await page.keyboard.press("Alt+t");
    await expect(page.locator(".otk-variant-picker > button > span"))
      .toHaveText("Low");
    await page.keyboard.press("Control+k");
    await page.locator("input[name=command-search]").fill("Choose agent");
    await page.locator('[data-command="agent.choose"]').click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(page.locator(".otk-agent-picker .otk-popover-panel"))
      .toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".otk-agent-picker > button")).toBeFocused();
  });
});

test.describe("applied choices", () => {
  test.use({ profile: "composer-applied" });
  test("composer.applied-default-explicit-and-restored-native-selection", {
    tag: ["@composer", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Applied composer choices",
    });
    const frames = await wire(page);
    await openSession(state, page, session.id);
    await expect(page.locator(".otk-variant-picker > button")).toHaveAttribute(
      "aria-label",
      "Variant: High (agent default)",
    );
    await expect(page.locator(".otk-prompt button[type=submit]")).toHaveCount(
      0,
    );
    for (
      const [kind, label] of [["agent", "Reviewer (agent default)"], [
        "model",
        "Second fixture provider Scripted with variants (agent default)",
      ], ["variant", "High (agent default)"]]
    ) {
      await expect(page.locator(`.otk-${kind}-picker > button`)).toHaveClass(
        /is-applied/,
      );
      await expect(page.locator(`.otk-${kind}-picker > button`))
        .toHaveAttribute(
          "aria-label",
          `${kind[0].toUpperCase()}${kind.slice(1)}: ${label}`,
        );
    }
    await pick(page, "variant", "high");
    await expect(page.locator(".otk-variant-picker > button")).not.toHaveClass(
      /is-applied/,
    );
    await pick(page, "variant", "");
    await expect(page.locator(".otk-variant-picker > button")).toHaveClass(
      /is-applied/,
    );
    await openPicker(page, "variant");
    await expect(page.locator('.otk-variant-picker [data-picker-key=""]'))
      .toHaveAttribute("aria-selected", "true");
    await expect(page.locator('.otk-variant-picker [data-picker-key=""] small'))
      .toHaveText("High");
    await expect(page.locator('.otk-variant-picker [data-picker-key="high"]'))
      .toHaveAttribute("aria-selected", "false");
    await page.keyboard.press("Escape");
    await queue(state, "Applied high arrived.");
    await prompt(page).fill("P6-DEFAULT");
    await prompt(page).press("Enter");
    await reply(state, page, session.id, "Applied high arrived.");
    const sent = frames.sent.filter(({ frame }) =>
      frame.method === "session.prompt"
    ).at(-1)!.frame.params!;
    expect(Object.hasOwn(sent, "variant")).toBe(false);
    expect(sent.model).toEqual({ provider: "fake2", model: "scripted" });
    expect(sent.agent).toBe("reviewer");
    expect(
      (await messages(state, session.id)).find((row) =>
        row.info.role === "user"
      )!.info.model,
    ).toEqual({ providerID: "fake2", modelID: "scripted", variant: "high" });
    expect(
      (await requests(state)).some((request) =>
        JSON.stringify(request.messages).includes("P6-DEFAULT") &&
        request.reasoning_effort === "high"
      ),
    ).toBe(true);
    await expect(page.locator(".otk-variant-picker > button")).toHaveClass(
      /is-applied/,
    );
    await page.reload();
    await expect(page.locator(".otk-variant-picker > button")).toHaveAttribute(
      "aria-label",
      "Variant: High",
    );
    for (const kind of ["agent", "model", "variant"]) {
      await expect(page.locator(`.otk-${kind}-picker > button`)).not
        .toHaveClass(/is-applied/);
    }
    await pick(page, "variant", "low");
    await queue(state, "Explicit low arrived.");
    await prompt(page).fill("P6-EXPLICIT");
    await prompt(page).press("Enter");
    await reply(state, page, session.id, "Explicit low arrived.");
    expect(
      frames.sent.filter(({ frame }) => frame.method === "session.prompt").at(
        -1,
      )!.frame.params!.variant,
    ).toBe("low");
    expect(
      (await messages(state, session.id)).filter((row) =>
        row.info.role === "user"
      )[1].info.model,
    ).toEqual({ providerID: "fake2", modelID: "scripted", variant: "low" });
    expect(
      (await requests(state)).some((request) =>
        JSON.stringify(request.messages).includes("P6-EXPLICIT") &&
        request.reasoning_effort === "low"
      ),
    ).toBe(true);
    expect((await state.observe<{ requests: unknown[] }>()).requests)
      .toHaveLength(0);
  });
});

test.describe("history choices", () => {
  test.use({ profile: "composer-selection" });
  for (const variant of ["high", undefined]) {
    test(
      `composer.recall-chosen-model-${
        variant ?? "explicit-default"
      }-editor-send`,
      { tag: ["@composer", "@isolated"] },
      async ({ isolatedState: state, page }) => {
        const target = await state.native<{ id: string }>("/session", "POST", {
          title: "Recall with choices",
          messages: [{
            model: variant === undefined
              ? { providerID: "selected", modelID: "chosen" }
              : { providerID: "fake", modelID: "scripted" },
            variant: "high",
            parts: [{ type: "text", text: "context before recall" }],
          }],
        });
        await state.native<{ id: string }>("/session", "POST", {
          title: "History source",
          messages: [{
            parts: [{ type: "text", text: "recalled history content" }],
          }],
        });
        const frames = await wire(page);
        await openSession(state, page, target.id);
        await pick(page, "model", JSON.stringify(["selected", "chosen"]));
        await pick(page, "variant", variant ?? "");
        await prompt(page).press("ArrowUp");
        await expect(prompt(page)).toHaveValue("recalled history content");
        await expect(page.locator(".otk-composer-model-name")).toHaveText(
          "Chosen model",
        );
        await expect(page.locator(".otk-variant-picker > button > span"))
          .toHaveText(variant ? "High" : "Default");
        await page.getByRole("button", { name: "Edit prompt", exact: true })
          .click();
        await page.locator("textarea[name=editor]").fill(
          "edited recalled history content",
        );
        await page.locator(".otk-editor footer button").last().click();
        await expect(prompt(page)).toHaveValue(
          "edited recalled history content",
        );
        await expect(page.locator("dialog[open]")).toHaveCount(0);
        await queue(state, "Reply from chosen history model");
        await page.locator(".otk-prompt button[type=submit]").click();
        await reply(state, page, target.id, "Reply from chosen history model");
        const frame = frames.sent.filter(({ frame }) =>
          frame.method === "session.prompt"
        ).at(-1)!.frame.params!;
        expect(frame.model).toEqual({ provider: "selected", model: "chosen" });
        expect(frame.variant).toBe(variant);
        const user = (await messages(state, target.id)).find((row) =>
          row.info.role === "user" &&
          row.parts.some((part) =>
            part.text === "edited recalled history content"
          )
        )!;
        expect(user.info.model).toEqual({
          providerID: "selected",
          modelID: "chosen",
          ...(variant ? { variant } : {}),
        });
        expect(
          (await requests(state)).some((request) =>
            JSON.stringify(request).includes("edited recalled history content")
          ),
        ).toBe(true);
      },
    );
  }
});
