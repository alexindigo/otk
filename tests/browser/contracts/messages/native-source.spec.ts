// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt as composer } from "../../pages/composer.ts";
import {
  openWorkLogs,
  prompt,
  revealAcquired,
  toolScript,
} from "../../pages/transcript.ts";

test.use({ profile: "transport-shell" });
test("messages.native-source-loads-exactly-when-its-fold-opens", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page }, info) => {
  test.setTimeout(120_000);
  // Hold or corrupt only Source reads, so loading and failure stay observable.
  await page.addInitScript(
    `window.sourceReads=[];window.sourceMode=sessionStorage.getItem("sourceMode")||"pass";window.releaseSource=()=>{};window.WebSocket=class extends WebSocket{send(value){const f=JSON.parse(value);if(f.t==="request"&&f.method==="source.get"){window.sourceReads.push(f.params.ref);if(window.sourceMode==="hold"){window.releaseSource=()=>super.send(value);return}if(window.sourceMode==="fail")return super.send(JSON.stringify({...f,params:{...f.params,ref:"v0:corrupted"}}))}return super.send(value)}}`,
  );
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Native source",
  });
  await openSession(state, page, session.id);
  const v2 = state.controller.info!.version.startsWith("2.");
  if (v2) {
    // A V2 shell is a native shell record.
    await composer(page).press("!");
    await composer(page).pressSequentially("echo native-source");
    await composer(page).press("Enter");
  } else {
    // V1 step boundaries are qualified native records.
    await toolScript(state, "bash", {
      command: "echo native-source",
      description: "Source fixture",
    });
    await prompt(page, "Run the source fixture");
    await expect(page.locator(".otk-message-flow")).toContainText(
      "Tool finished.",
    );
    await openWorkLogs(page);
  }
  const open = async (button: import("@playwright/test").Locator) => {
    if (await button.getAttribute("aria-expanded") !== "true") {
      await button.click();
    }
    await expect(button).toHaveAttribute("aria-expanded", "true");
  };
  const records = v2
    ? '[data-native-record="opencode-v2/shell"]'
    : '[data-native-record^="opencode-v1/step-"]';
  await revealAcquired(page, records);
  const record = page.locator(records).first();
  await record.locator("> .otk-tool-state > .otk-tool-toggle").click();
  const source = record.locator(".otk-native-source");
  const toggle = source.locator("> .otk-tool-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  // A closed fold has read nothing and holds no raw source.
  expect(await page.evaluate("window.sourceReads.length")).toBe(0);
  await expect(source.locator(".otk-native-preview")).toHaveCount(0);
  const shoot = async (name: string) => {
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await page.screenshot({
        path: info.outputPath(`source-${name}-${theme}.png`),
        fullPage: true,
      });
    }
  };
  await page.evaluate("window.sourceMode='hold'");
  await toggle.click();
  await expect(source.locator(".otk-tool-body")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect(source).toContainText("Loading source");
  await shoot("loading");
  await page.evaluate("window.releaseSource()");
  await expect(source.locator(".otk-native-preview")).toContainText(
    v2 ? "native-source" : '"type":"step-',
  );
  await expect(source).toContainText("bytes");
  await expect(source.locator(".otk-tool-body")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await shoot("loaded");
  expect(await page.evaluate("window.sourceReads.length")).toBe(1);
  // Reopening, remounting the record and switching themes reuse the one
  // result the transcript owner keeps for this reference.
  await toggle.click();
  await toggle.click();
  const recordToggle = record.locator("> .otk-tool-state > .otk-tool-toggle");
  await recordToggle.click();
  await open(recordToggle);
  await expect(source.locator(".otk-native-preview")).toBeVisible();
  expect(await page.evaluate("window.sourceReads.length")).toBe(1);
  await page.evaluate("sessionStorage.setItem('sourceMode','fail')");
  await page.reload();
  if (!v2) await openWorkLogs(page);
  await revealAcquired(page, records);
  const again = page.locator(records).first();
  const againToggle = again.locator("> .otk-tool-state > .otk-tool-toggle");
  await open(againToggle);
  const failed = again.locator(".otk-native-source");
  await open(failed.locator("> .otk-tool-toggle"));
  const status = failed.locator(".otk-feedback-status");
  await expect(status).toBeVisible();
  // The plugin says why and the next step fits opening a fold.
  await expect(status).toContainText(
    "This source reference is no longer valid",
  );
  await expect(status).toContainText(
    "Reload the conversation, then open Source again",
  );
  await expect(status).not.toContainText("Review the target and input");
  await expect(status.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(failed.locator(".otk-native-preview")).toHaveCount(0);
  // A failed result is kept too: a remount shows it without reading again.
  await againToggle.click();
  await open(againToggle);
  await expect(status).toBeVisible();
  await shoot("failed");
  expect(await page.evaluate("window.sourceReads.length")).toBe(1);
  await expect(status).not.toContainText("identical failures");
  // Retry is the only re-read; restored transport loads the exact source.
  await page.evaluate("window.sourceMode='pass'");
  await status.getByRole("button", { name: "Retry" }).click();
  await expect(failed.locator(".otk-native-preview")).toContainText(
    v2 ? "native-source" : '"type":"step-',
  );
  expect(await page.evaluate("window.sourceReads.length")).toBe(2);
});
