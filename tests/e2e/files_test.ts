// SPDX-License-Identifier: LGPL-3.0-only
// T2 V remainder: real native edits/LSP/files now live in behavior/messages/files.
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { legacyMessageScene } from "../support/legacy-message-scene.ts";
import { revealViewportElement } from "../support/message-viewport.ts";
for (const theme of ["otk-dark", "otk-light"]) {
  test(`R2/R3 real edit diffs, live styles/wrap, write highlights/line numbers/diagnostics and patch statuses (${theme})`, () =>
    legacyMessageScene(
      "contract-messages-recorded-files",
      theme,
      async ({ b, capture, set }) => {
        await set("collapseFileChanges", false);
        await b.evaluate("document.querySelector('.otk-messages').scrollTop=0");
        await revealViewportElement(
          b,
          ".otk-messages",
          "[data-tool=edit] .otk-diff",
        );
        await set("diffStyle", "split");
        await b.poll(
          "document.querySelector('[data-tool=edit] .otk-diff')?.dataset.diffStyle==='split'",
        );
        const geometry = await b.evaluate<
          { left: number; right: number; topA: number; topB: number }
        >("(()=>{const cells=document.querySelector('.otk-diff-split-row').children,a=cells[0].getBoundingClientRect(),b=cells[1].getBoundingClientRect();return{left:a.height,right:b.height,topA:a.top,topB:b.top}})()");
        assert(
          Math.abs(geometry.left - geometry.right) < .5 &&
            Math.abs(geometry.topA - geometry.topB) < .5,
        );
        await capture("edit-split");
        await set("diffStyle", "unified");
        await set("diffWrap", false);
        await b.poll(
          "document.querySelector('[data-tool=edit] .otk-diff')?.dataset.diffStyle==='unified'&&!document.querySelector('[data-tool=edit] .otk-diff').classList.contains('otk-diff-wrap')",
        );
        await capture("edit-unified");
        await revealViewportElement(
          b,
          ".otk-messages",
          "[data-tool=write] .otk-code",
        );
        await b.poll(
          "!!document.querySelector('[data-tool=write] .otk-token')&&!!document.querySelector('[data-tool=write] .otk-code-numbers')&&document.querySelector('[data-tool=write] .otk-diagnostics')?.textContent.includes('fixture diagnostic')",
        );
        await capture("write-diagnostics");
        await revealViewportElement(
          b,
          ".otk-messages",
          "[data-tool=patch] .otk-tool-toggle",
        );
        await b.poll(
          "document.querySelectorAll('[data-tool=patch] .otk-diff').length===4",
        );
        assertEquals(
          await b.evaluate(
            "[...document.querySelectorAll('[data-tool=patch] .otk-diff')].map(el=>el.dataset.fileStatus)",
          ),
          ["added", "modified", "deleted", "moved"],
        );
        await capture("patch-statuses");
      },
    ));
}
