// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
test.use({ profile: "contract-messages-public-ui" });

for (const scenario of ["lifetime", "source"] as const) {
  test(`messages.lazy-preview-${scenario}`, {
    tag: ["@messages", "@contracts"],
  }, async ({ isolatedState: state, page }) => {
    await page.addInitScript(() => {
      const counts: Record<string, number> = {};
      Object.assign(window, { previewEncodes: counts });
      const encode = TextEncoder.prototype.encode;
      TextEncoder.prototype.encode = function (text) {
        if (text?.startsWith("OTK_LAZY_PREVIEW_")) {
          const key = text.slice(17).split(":", 1)[0];
          counts[key] = (counts[key] ?? 0) + 1;
        }
        return encode.call(this, text);
      };
    });
    const url = new URL(state.url);
    url.searchParams.set("lazy-preview", "");
    await page.goto(url.href);
    const row = (name: string) =>
      page.locator(`[data-native-record="${name}"]`);
    const toggle = (name: string) =>
      row(name).getByRole("button", {
        name: `Unsupported part: ${name}`,
        exact: true,
      });
    const counts = () =>
      page.evaluate(() =>
        (window as unknown as { previewEncodes: Record<string, number> })
          .previewEncodes
      );
    await expect(toggle("legacy")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(await counts()).toEqual({});
    // WP16 still discloses the record's exact clock even without source bytes.
    // Opening that outer record must not invent a Source fold or encode a preview.
    await toggle("absent").click();
    await expect(row("absent").locator("[data-record-time]")).toBeVisible();
    await expect(row("absent").locator(".otk-native-source")).toHaveCount(0);
    expect(await counts()).toEqual({});
    if (scenario === "source") {
      await toggle("explicit").click();
      await expect(row("explicit").locator("pre")).toHaveText(
        "OTK_LAZY_PREVIEW_explicit:",
      );
      await expect(row("explicit")).toContainText(
        "90000 bytes - Preview truncated",
      );
      expect(await counts()).toEqual({ explicit: 1 });
      await toggle("empty").click();
      await expect(row("empty").locator("pre")).toHaveJSProperty(
        "textContent",
        "",
      );
      await expect(row("empty")).toContainText("7 bytes - Preview truncated");
      await page.locator("[data-source-preview]").click();
      await expect(page.locator("[data-copied-preview]")).toHaveJSProperty(
        "textContent",
        "  exact <source>**payload**</source>\n",
      );
      expect(await counts()).toEqual({ explicit: 1 });
      return;
    }
    await page.locator("[data-update-preview]").click();
    await expect(page.locator("[data-preview-generation]")).toHaveText("1");
    expect(await counts()).toEqual({});
    await page.locator("[data-mount-preview]").click();
    await expect(row("legacy")).toHaveCount(0);
    await page.locator("[data-mount-preview]").click();
    await expect(toggle("legacy")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(await counts()).toEqual({});
    await toggle("legacy").click();
    const prefix = "OTK_LAZY_PREVIEW_legacy1:";
    const expected = prefix +
      "\u20ac".repeat(Math.floor((16384 - prefix.length) / 3));
    await expect(row("legacy").locator("pre")).toHaveJSProperty(
      "textContent",
      expected,
    );
    await expect(row("legacy")).toContainText(
      `${prefix.length + 60000} bytes - Preview truncated`,
    );
    expect(await counts()).toEqual({ legacy1: 1 });
    await toggle("legacy").click();
    await expect(row("legacy").locator("pre")).toHaveCount(0);
    expect(await counts()).toEqual({ legacy1: 1 });
    await page.locator("[data-mount-preview]").click();
    await expect(row("legacy")).toHaveCount(0);
    await page.locator("[data-mount-preview]").click();
    await expect(toggle("legacy")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(await counts()).toEqual({ legacy1: 1 });
    await page.locator("[data-update-preview]").click();
    await expect(page.locator("[data-preview-generation]")).toHaveText("2");
    expect(await counts()).toEqual({ legacy1: 1 });
    await toggle("legacy").click();
    await expect(row("legacy").locator("pre")).toContainText(
      "OTK_LAZY_PREVIEW_legacy2:",
    );
    expect(await counts()).toEqual({ legacy1: 1, legacy2: 1 });
    await toggle("legacy").click();
    await toggle("legacy").click();
    await expect(row("legacy").locator("pre")).toBeVisible();
    expect(await counts()).toEqual({ legacy1: 1, legacy2: 2 });
  });
}

test("messages.public-ui-external-tools-callbacks-isolation", {
  tag: ["@messages", "@contracts", "@composer"],
}, async ({ isolatedState: state, page }) => {
  await page.goto(state.url);
  // Decision 6: all evidence states render, including grey for no evidence.
  const lights = page.locator("[data-visual-gallery] .otk-status-light");
  await expect(lights).toHaveCount(5);
  expect(
    await lights.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-state"))
    ),
  ).toEqual(["blocked", "working", "finished", "none", "working"]);
  await expect(lights.nth(3)).toHaveAttribute(
    "aria-label",
    "No known activity",
  );
  await expect(page.locator("#registered .otk-tool-toggle")).toHaveCount(2);
  await expect(page.locator("#registered [data-external-tool]")).toHaveCount(0);
  await page.locator("#registered > .otk-tool-line .otk-tool-toggle").click();
  await page.locator("#registered .otk-message .otk-tool-toggle").click();
  await expect(page.locator("#registered [data-external-tool]")).toHaveCount(2);
  await expect(page.locator("[data-library-code] .otk-token").first())
    .toBeAttached();
  await expect(page.locator("[data-library-code] code")).toHaveJSProperty(
    "textContent",
    "const externalResult: number = 7;",
  );
  const token = page.locator("[data-library-code] .otk-token").first(),
    dark = await token.evaluate((e) => getComputedStyle(e).color);
  await page.locator("[data-light]").click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-otk-theme",
    "otk-light",
  );
  await expect.poll(() => token.evaluate((e) => getComputedStyle(e).color)).not
    .toBe(dark);
  await page.locator("[data-dark]").click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-otk-theme",
    "otk-dark",
  );
  await expect.poll(() => token.evaluate((e) => getComputedStyle(e).color))
    .toBe(dark);
  await expect(page.locator("#isolated [data-external-tool]")).toHaveCount(0);
  await expect(page.locator("#isolated .otk-tool-toggle")).toContainText(
    "external-probe Initial result",
  );
  await expect(page.locator("#isolated .otk-tool-verb")).toHaveText(
    "external-probe",
  );
  await expect(page.locator("#isolated .otk-tool-brief")).toHaveText(
    "Initial result",
  );
  await page.locator("#isolated .otk-tool-toggle").click();
  await expect(page.locator("#isolated .otk-tool-body")).toBeVisible();
  await expect(page.locator("#isolated .otk-tool-output")).toHaveText(
    "Reusable output",
  );
  await expect(page.locator("#isolated .otk-tool-body .otk-tool-summary"))
    .toHaveCount(0);
  await page.locator("[data-update]").click();
  await expect(page.locator("#registered .otk-tool-toggle").first())
    .toContainText("Inspect");
  await expect(page.locator("#registered .otk-tool-toggle").first())
    .toContainText("external target");
  await expect(page.locator("#registered .otk-tool-body").first())
    .toBeVisible();
  await expect.poll(() =>
    page.locator("[data-external-tool] .otk-tool-summary").evaluateAll((rows) =>
      rows.every((e) => e.textContent!.includes("Updated result"))
    )
  ).toBe(true);
  await page.locator("[data-open]").first().click();
  await expect(page.locator("#opened")).toHaveText("child-probe");
  await expect(page.locator("[data-external-part]")).toHaveText(
    "Injected part: agent",
  );
  await expect(page.locator("[data-typed-part]")).toHaveText(
    "Feature part: Updated result",
  );
  await expect(page.locator("#registered")).toContainText(
    "Unsupported part: future.card",
  );
  await page.locator("[data-inject]").click();
  await expect(page.locator("textarea[name=prompt]")).toHaveValue(
    "Injected draft",
  );
  await expect(page.locator(".otk-prompt-context > span").first()).toHaveText(
    "External-Agent",
  );
  await page.locator("textarea[name=prompt]").click();
  await expect(page.locator("textarea[name=prompt]")).toBeFocused();
  expect(
    await page.locator("textarea[name=prompt]").evaluate((e) =>
      e.closest(".otk-composer") === null
    ),
  ).toBe(true);
  await expect(page.locator("textarea[name=prompt]")).toHaveCSS(
    "outline-style",
    "solid",
  );
  await page.locator(".otk-prompt button[type=submit]").click();
  await expect(page.locator("textarea[name=prompt]")).toHaveValue("");
  await expect.poll(() =>
    page.locator("#submitted").textContent().then((s) => JSON.parse(s!))
  ).toEqual([{ kind: "text", text: "Injected draft" }, {
    kind: "text",
    text: "external transform",
  }]);
  await expect(page.locator("[data-external-dock]")).toHaveCount(0);
  await page.locator("[data-capability]").click();
  await page.locator("[data-external-dock]").click();
  await expect(page.locator("[data-external-dock]")).toHaveText(
    "Injected dock 1",
  );
  await page.locator("[data-external-takeover]").click();
  await expect(page.locator("#opened")).toHaveText("typed external reply");
  await page.locator("[data-open-dialog]").click();
  await expect(page.locator("[data-external-dialog]")).toContainText(
    "Feature-owned dialog",
  );
  await page.locator("[data-close-dialog]").click();
  await expect(page.locator("[data-external-dialog]")).toHaveCount(0);
  await page.locator(".otk-display-menu > button").click();
  await expect(
    page.locator(".otk-display-menu label").filter({
      hasText: "Consumer compact layout",
    }),
  ).toBeAttached();
  await page.locator('input[name="consumer.compact"]').click();
  await expect(page.locator("[data-consumer-preference]")).toHaveText("true");
  await expect(page.locator('input[name="consumer.compact"]')).toBeChecked();
});
