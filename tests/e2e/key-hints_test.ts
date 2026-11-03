// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assertEquals } from "@std/assert";
import { openSession } from "../support/browser-fixture.ts";
import { legacyMenusScene } from "../support/legacy-menus-scene.ts";
for (const theme of ["otk-dark", "otk-light"]) {
  test(`command hints follow mounted hidden bindings, saved overrides, unbinding and reset in ${theme}`, async () => {
    const f = await legacyMenusScene("contract-menus-hints");
    try {
      await f.rpc("prefs.set", { key: "theme", value: theme });
      await f.b.goto(f.url);
      await openSession(f.b, "tstv1-core");
      await f.b.fill("textarea[name=prompt]", "Fixed shortcut hint state");
      await f.b.click(".otk-keys-entry");
      await f.b.poll(
        '!!document.querySelector("[data-binding=\\"prompt.submit\\"] kbd")',
      );
      assertEquals(
        await f.b.evaluate(
          'document.querySelector("[data-binding=\\"prompt.submit\\"] kbd").textContent',
        ),
        "Enter",
      );
    } finally {
      await f.close();
    }
  });
}
test("Dialog and Editor omit surface key hints while retaining save, cancel and native focus return", async () => {
  const f = await legacyMenusScene("contract-menus-hints");
  try {
    const b = f.b;
    await b.goto(f.url);
    await openSession(b, "tstv1-core");
    await b.fill("textarea[name=prompt]", "Keep this prompt");
    for (const theme of ["otk-dark", "otk-light"]) {
      await f.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await b.click('[aria-label="Edit prompt"]');
      await b.poll('!!document.querySelector("dialog[open] textarea")');
      assertEquals(
        await b.evaluate(
          'document.querySelector("dialog[open] .otk-surface-title button").textContent.trim()',
        ),
        "Close",
      );
      assertEquals(
        await b.evaluate('document.querySelector(".otk-editor p").textContent'),
        "Save to keep changes",
      );
      await b.key("Escape");
      await b.poll('!document.querySelector("dialog[open]")');
    }
  } finally {
    await f.close();
  }
});
