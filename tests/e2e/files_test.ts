// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { recordTools, runTool } from "../support/rendering.ts";
import type { RawPart } from "@otk/harness-opencode1";
Deno.test("R2/R3 real edit diffs, live styles/wrap, write highlights/line numbers/diagnostics and patch statuses", async () => {
  const lsp = fromFileUrl(new URL("../support/fake-lsp.ts", import.meta.url));
  const f = await browserFixture({
    bash: "allow",
    read: "allow",
    edit: "allow",
  }, {
    config: {
      lsp: {
        typescript: { disabled: true },
        deno: { disabled: true },
        fixture: {
          command: [Deno.execPath(), "run", lsp],
          extensions: [".ts"],
        },
      },
    },
    prepare: async (oc) => {
      await Deno.writeTextFile(
        join(oc.directory, "edit.ts"),
        "const oldValue: number = 1;\n",
      );
      await Deno.writeTextFile(join(oc.directory, "modify.txt"), "before\n");
      await Deno.writeTextFile(join(oc.directory, "delete.txt"), "delete me\n");
      await Deno.writeTextFile(join(oc.directory, "move.txt"), "move me\n");
    },
  });
  try {
    const s = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "File tools" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, s.id);
    // This renderer suite exercises the expanded display mode; U6 covers default disclosure.
    await browser.click(".otk-display-menu > button");
    await browser.click("input[name=collapseFileChanges]");
    await browser.click(".otk-display-menu > button");
    const parts: RawPart[] = [];
    parts.push(
      await runTool(f, browser, s.id, {
        name: "edit",
        input: {
          filePath: join(f.oc.directory, "edit.ts"),
          oldString: "oldValue",
          newString: "newValue_" + "x".repeat(200),
        },
      }),
    );
    await browser.poll(
      "!!document.querySelector('[data-tool=edit] [data-line-kind=add]') && !!document.querySelector('[data-tool=edit] [data-line-kind=del]')",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('[data-tool=edit] .otk-diff').getAttribute('aria-label')",
      ),
      "Modified edit.ts",
    );
    await browser.click(".otk-display-menu > button");
    await browser.click("select[name=diffStyle]");
    await browser.key("ArrowDown");
    await browser.key("Enter");
    await browser.poll(
      "document.querySelector('[data-tool=edit] .otk-diff').dataset.diffStyle==='split'",
    );
    await browser.click(".otk-display-menu > button");
    const geometry = await browser.evaluate<
      { left: number; right: number; topA: number; topB: number }
    >("(()=>{const cells=document.querySelector('.otk-diff-split-row').children,a=cells[0].getBoundingClientRect(),b=cells[1].getBoundingClientRect();return {left:a.height,right:b.height,topA:a.top,topB:b.top}})()");
    assert(
      Math.abs(geometry.left - geometry.right) < .5 &&
        Math.abs(geometry.topA - geometry.topB) < .5,
    );
    await browser.screenshot(join(f.oc.root, "r2-edit-split.png"));
    await browser.click(".otk-display-menu > button");
    await browser.click("select[name=diffStyle]");
    await browser.key("ArrowDown");
    await browser.key("Enter");
    await browser.poll(
      "document.querySelector('[data-tool=edit] .otk-diff').dataset.diffStyle==='unified'",
    );
    await browser.click("input[name=diffWrap]");
    await browser.poll(
      "!document.querySelector('[data-tool=edit] .otk-diff').classList.contains('otk-diff-wrap')",
    );
    await browser.click(".otk-display-menu > button");
    await browser.screenshot(join(f.oc.root, "r2-edit-unified.png"));
    await browser.click(".otk-display-menu > button");
    await browser.click("select[name=diffStyle]");
    await browser.key("ArrowUp");
    await browser.key("ArrowUp");
    await browser.key("Enter");
    await browser.click(".otk-display-menu > button");
    // Auto diff style uses the actual transcript pane, whose available width
    // now excludes both side panels rather than only the project column.
    const wideViewport = await browser.evaluate<number>(
      "Math.ceil(innerWidth + 1280 - document.querySelector('.otk-session-view').getBoundingClientRect().width)",
    );
    await browser.send("Emulation.setDeviceMetricsOverride", {
      width: wideViewport,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await browser.poll(
      "document.querySelector('[data-tool=edit] .otk-diff').dataset.diffStyle==='split'",
    );
    await browser.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await browser.poll(
      "document.querySelector('[data-tool=edit] .otk-diff').dataset.diffStyle==='unified'",
    );
    parts.push(
      await runTool(f, browser, s.id, {
        name: "write",
        input: {
          filePath: join(f.oc.directory, "write.ts"),
          content: "const written: number = 2;\n",
        },
      }),
    );
    await browser.poll(
      "!!document.querySelector('[data-tool=write] .otk-token') && !!document.querySelector('[data-tool=write] .otk-code-numbers') && document.querySelector('[data-tool=write] .otk-diagnostics')?.textContent.includes('fixture diagnostic')",
    );
    const patch =
      "*** Begin Patch\n*** Add File: created.ts\n+const created: number = 3;\n*** Update File: modify.txt\n@@\n-before\n+after\n*** Delete File: delete.txt\n*** Update File: move.txt\n*** Move to: moved.txt\n@@\n-move me\n+moved\n*** End Patch";
    parts.push(
      await runTool(f, browser, s.id, {
        name: "apply_patch",
        input: { patchText: patch },
      }, { model: { providerID: "fake", modelID: "gpt-scripted" } }),
    );
    await browser.poll(
      "document.querySelectorAll('[data-tool=patch] .otk-diff').length===4",
    );
    assertEquals(
      await browser.evaluate(
        "[...document.querySelectorAll('[data-tool=patch] .otk-diff')].map(el=>el.dataset.fileStatus)",
      ),
      ["added", "modified", "deleted", "moved"],
    );
    assertEquals(
      await browser.evaluate(
        "[...document.querySelectorAll('[data-tool=patch] .otk-diff header .otk-path')].map(el=>el.textContent)",
      ),
      ["created.ts", "modify.txt", "delete.txt", "move.txt", "moved.txt"],
    );
    assertEquals(
      await Deno.readTextFile(join(f.oc.directory, "modify.txt")),
      "after\n",
    );
    assertEquals(
      await Deno.readTextFile(join(f.oc.directory, "moved.txt")),
      "moved\n",
    );
    assert(
      (await Deno.readTextFile(join(f.oc.directory, "created.ts"))).includes(
        "const created",
      ),
    );
    await assertRejects(
      () => Deno.stat(join(f.oc.directory, "delete.txt")),
      Deno.errors.NotFound,
    );
    await assertRejects(
      () => Deno.stat(join(f.oc.directory, "move.txt")),
      Deno.errors.NotFound,
    );
    await recordTools(f.oc.root, "recorded-file-tools", parts);
    await browser.screenshot(join(f.oc.root, "r3-write-patch.png"));
  } finally {
    await f.stop();
  }
});
