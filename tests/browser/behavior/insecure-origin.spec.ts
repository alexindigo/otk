// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../fixtures/evidence.ts";
import { isolatedTest as test } from "../fixtures/isolated.ts";
import { prompt } from "../pages/composer.ts";
import { pick, rightClick } from "../pages/menus.ts";
import { expandTool, toolScript } from "../pages/transcript.ts";

// A real HTTP origin, not localhost and not an emulated missing API. Resolution
// stays within the owned test guest; no listener is exposed to the Internet.
test.use({
  launchOptions: {
    args: [
      "--host-resolver-rules=MAP insecure.otk.test 127.0.0.1",
      "--no-proxy-server",
    ],
  },
});

for (const scenario of ["carriage-return", "backward-selection"] as const) {
  test(`browser.insecure-copy-preserves-${scenario}`, {
    tag: ["@messages", "@composer", "@insecure"],
  }, async ({ isolatedState: state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Exact copy",
    });
    const origin = new URL(state.url);
    origin.hostname = "insecure.otk.test";
    await page.goto(`${origin.origin}/#/local/${session.id}`);
    expect(await page.evaluate(() => globalThis.isSecureContext)).toBe(false);
    await expect(prompt(page)).toBeVisible();
    const source = scenario === "carriage-return"
      ? "progress 10%\rprogress 90%"
      : "Selection direction";
    // Reply Copy's exact Markdown source belongs to UX3. A tool output action
    // supplies raw text unchanged to the clipboard owner, without blocksText.
    if (scenario === "carriage-return") {
      await toolScript(state, "bash", {
        command: "printf 'progress 10%%\\rprogress 90%%'",
        description: "Raw carriage-return output",
      });
    } else {
      await state.queue([source]);
    }
    await prompt(page).fill("Reply with the source");
    await page.locator(".otk-prompt button[type=submit]").click();
    if (scenario === "carriage-return") {
      await page.getByRole("button", { name: "Allow once", exact: true })
        .click();
    }
    const copy = page.getByRole("button", { name: "Copy reply", exact: true });
    await expect(copy).toBeVisible();
    await page.evaluate(() => {
      const probe = document.createElement("p");
      probe.id = "direction-probe";
      probe.textContent = "Keep this backward selection";
      document.body.append(probe);
      const text = probe.firstChild!;
      getSelection()!.setBaseAndExtent(text, 20, text, 5);
    });
    if (scenario === "carriage-return") {
      await expandTool(page, "[data-tool=bash]");
      await rightClick(page, "[data-tool=bash] .otk-tool-toggle");
      await pick(page, "Copy output");
    } else {
      await copy.click();
    }
    if (scenario === "backward-selection") {
      expect(
        await page.evaluate(() => {
          const selection = getSelection()!;
          return {
            anchor: selection.anchorOffset,
            focus: selection.focusOffset,
            text: selection.toString(),
          };
        }),
      ).toEqual({ anchor: 20, focus: 5, text: "this backward s" });
    } else {
      // Read ClipboardEvent data before native field normalization can alter CR.
      await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.id = "raw-paste-probe";
        probe.contentEditable = "true";
        probe.addEventListener("paste", (event) => {
          probe.dataset.pasted = JSON.stringify(
            event.clipboardData!.getData("text/plain"),
          );
          event.preventDefault();
        });
        document.body.append(probe);
        probe.focus();
      });
      await page.keyboard.press("Control+v");
      await expect(page.locator("#raw-paste-probe")).toHaveAttribute(
        "data-pasted",
        JSON.stringify(source),
      );
    }
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}

for (const kind of ["link", "image"] as const) {
  test(`browser.insecure-${kind}-copy-failure-has-address-recovery`, {
    tag: ["@messages", "@composer", "@insecure"],
  }, async ({ isolatedState: state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Address recovery",
    });
    const origin = new URL(state.url);
    origin.hostname = "insecure.otk.test";
    await page.goto(`${origin.origin}/#/local/${session.id}`);
    await expect(prompt(page)).toBeVisible();
    await page.evaluate(() => {
      const host = document.createElement("p");
      host.id = "address-probe";
      const link = document.createElement("a");
      link.href = "https://example.test/report";
      link.textContent = "Open report";
      const image = document.createElement("img");
      image.src =
        'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="orange"/></svg>';
      image.alt = "Report image";
      host.append(link, image);
      (document.querySelector(".otk-welcome") ||
        document.querySelector(".otk-messages"))!.prepend(host);
      document.execCommand = () => false;
    });
    await rightClick(
      page,
      kind === "link" ? "#address-probe a" : "#address-probe img",
    );
    await pick(page, `Copy ${kind} address`);
    await expect(page.getByRole("alert")).toContainText(
      kind === "link" ? "browser's link menu" : "Open image",
    );
    await expect(page.getByRole("alert")).not.toContainText(
      "Select the source text",
    );
  });
}

test("browser.insecure-origin-renders-opens-sends-and-copies", {
  tag: ["@messages", "@composer", "@insecure"],
}, async ({ isolatedState: state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Plain HTTP session",
  });
  const origin = new URL(state.url);
  origin.hostname = "insecure.otk.test";
  await page.goto(`${origin.origin}/#/local/${session.id}`);
  expect(await page.evaluate(() => globalThis.isSecureContext)).toBe(false);
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");
  await expect(prompt(page)).toBeVisible();
  await expect(page.getByRole("region", { name: "Transcript", exact: true }))
    .toHaveAttribute("aria-busy", "false");
  await state.queue(["Plain HTTP reply"]);
  await prompt(page).fill("Plain HTTP prompt");
  await page.locator(".otk-prompt button[type=submit]").click();
  await expect(page.locator("[data-role=assistant]")).toContainText(
    "Plain HTTP reply",
  );
  await expect(page.getByRole("button", { name: "Copy reply", exact: true }))
    .toBeVisible();
  await expect(prompt(page)).toHaveValue("");
  // Observe the native copy event without replacing execCommand or its result.
  await page.evaluate(() => {
    document.addEventListener("copy", () => {
      document.documentElement.dataset.copyEvent = "observed";
    });
  });
  await page.getByRole("button", { name: "Copy reply", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-copy-event",
    "observed",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  // A plain native field observes actual clipboard bytes, not a mocked write.
  await page.evaluate(() => {
    const probe = document.createElement("textarea");
    probe.id = "clipboard-probe";
    document.body.append(probe);
  });
  await page.locator("#clipboard-probe").focus();
  await page.keyboard.press("Control+v");
  await expect(page.locator("#clipboard-probe")).toHaveValue(
    "Plain HTTP reply",
  );
  await page.locator("#clipboard-probe").evaluate((element) =>
    element.remove()
  );
  // A refusal must reach the existing FP1 presentation, never silently succeed.
  await page.evaluate(() => {
    document.execCommand = () => false;
  });
  await page.getByRole("button", { name: "Copy reply", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Copy");
  await expect(page.getByRole("alert")).toContainText("clipboard");
  await expect(page.getByRole("alert")).toContainText("Ctrl+C");
});
