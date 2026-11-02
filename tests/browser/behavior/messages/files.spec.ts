// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { runNativeTool, showFileChanges } from "../../pages/transcript.ts";
import { readFile, stat } from "node:fs/promises";

test.use({ profile: "messages-files" });
test("messages.edit-write-patch-native-files-geometry", {
  tag: ["@messages", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  test.setTimeout(180_000);
  await state.controller.call("writeProjectFiles", {
    lease: state.lease.lease,
    files: {
      "edit.ts": "const oldValue: number = 1;\n",
      "modify.txt": "before\n",
      "delete.txt": "delete me\n",
      "move.txt": "move me\n",
    },
  });
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "File tools",
  });
  await openSession(state, page, session.id);
  await showFileChanges(state, page);
  const parts = [];
  parts.push(
    await runNativeTool(state, page, session.id, "edit", {
      filePath: state.directory + "/edit.ts",
      oldString: "oldValue",
      newString: "newValue_" + "x".repeat(200),
    }),
  );
  await expect(page.locator("[data-tool=edit] [data-line-kind=add]"))
    .toBeAttached();
  await expect(page.locator("[data-tool=edit] [data-line-kind=del]"))
    .toBeAttached();
  const diff = page.locator("[data-tool=edit] .otk-diff");
  await expect(diff).toHaveAttribute("aria-label", "Modified edit.ts");
  await page.locator(".otk-display-menu > button").click();
  await page.locator("select[name=diffStyle]").click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(diff).toHaveAttribute("data-diff-style", "split");
  await page.locator(".otk-display-menu > button").click();
  const geometry = await page.locator(".otk-diff-split-row").first().evaluate(
    (row) => {
      const a = row.children[0].getBoundingClientRect(),
        b = row.children[1].getBoundingClientRect();
      return { left: a.height, right: b.height, topA: a.top, topB: b.top };
    },
  );
  expect(
    Math.abs(geometry.left - geometry.right) < .5 &&
      Math.abs(geometry.topA - geometry.topB) < .5,
    JSON.stringify(geometry),
  ).toBe(true);
  await page.locator(".otk-display-menu > button").click();
  await page.locator("select[name=diffStyle]").click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(diff).toHaveAttribute("data-diff-style", "unified");
  await page.locator("input[name=diffWrap]").click();
  await expect(diff).not.toHaveClass(/otk-diff-wrap/);
  await page.locator(".otk-display-menu > button").click();
  await page.locator(".otk-display-menu > button").click();
  await page.locator("select[name=diffStyle]").click();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(page.locator("select[name=diffStyle]")).toHaveValue("auto");
  await page.locator(".otk-display-menu > button").click();
  const wideViewport = await page.locator(".otk-session-view").evaluate(
    (element) =>
      Math.ceil(innerWidth + 1280 - element.getBoundingClientRect().width),
  );
  await page.setViewportSize({ width: wideViewport, height: 800 });
  await expect(diff).toHaveAttribute("data-diff-style", "unified");
  await expect.poll(() =>
    page.locator(".otk-session-view").evaluate((element) =>
      element.getBoundingClientRect().width
    )
  ).toBeGreaterThanOrEqual(1280);
  expect(
    await diff.evaluate((element) =>
      element.getBoundingClientRect().width <
        parseFloat(
          getComputedStyle(element).getPropertyValue("--diff-split-min"),
        )
    ),
  ).toBe(true);
  await page.locator(".otk-session-view").evaluate((element) =>
    (element as HTMLElement).style.setProperty("--lane-width", "1600px")
  );
  await expect(diff).toHaveAttribute("data-diff-style", "split");
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(diff).toHaveAttribute("data-diff-style", "unified");
  await page.locator(".otk-session-view").evaluate((element) =>
    (element as HTMLElement).style.removeProperty("--lane-width")
  );
  parts.push(
    await runNativeTool(state, page, session.id, "write", {
      filePath: state.directory + "/write.ts",
      content: "const written: number = 2;\n",
    }),
  );
  await expect(page.locator("[data-tool=write] .otk-token").first())
    .toBeAttached();
  await expect(page.locator("[data-tool=write] .otk-code-numbers"))
    .toBeAttached();
  await expect(page.locator("[data-tool=write] .otk-diagnostics"))
    .toContainText("fixture diagnostic");
  const patch =
    "*** Begin Patch\n*** Add File: created.ts\n+const created: number = 3;\n*** Update File: modify.txt\n@@\n-before\n+after\n*** Delete File: delete.txt\n*** Update File: move.txt\n*** Move to: moved.txt\n@@\n-move me\n+moved\n*** End Patch";
  parts.push(
    await runNativeTool(state, page, session.id, "apply_patch", {
      patchText: patch,
    }, { providerID: "fake", modelID: "gpt-scripted" }),
  );
  await expect(page.locator("[data-tool=patch] .otk-diff")).toHaveCount(4);
  expect(
    await page.locator("[data-tool=patch] .otk-diff").evaluateAll((elements) =>
      elements.map((element) => (element as HTMLElement).dataset.fileStatus)
    ),
  ).toEqual(["added", "modified", "deleted", "moved"]);
  expect(
    await page.locator("[data-tool=patch] .otk-diff header .otk-path")
      .allTextContents(),
  ).toEqual([
    "created.ts",
    "modify.txt",
    "delete.txt",
    "move.txt",
    "moved.txt",
  ]);
  expect(await readFile(state.directory + "/modify.txt", "utf8")).toBe(
    "after\n",
  );
  expect(await readFile(state.directory + "/moved.txt", "utf8")).toBe(
    "moved\n",
  );
  expect(await readFile(state.directory + "/created.ts", "utf8")).toContain(
    "const created",
  );
  await expect(stat(state.directory + "/delete.txt")).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(stat(state.directory + "/move.txt")).rejects.toMatchObject({
    code: "ENOENT",
  });
  await info.attach("recorded-file-tools", {
    body: JSON.stringify(parts),
    contentType: "application/json",
  });
});
