// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assertEquals } from "@std/assert";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import {
  legacyMenusScene,
  visualDismiss,
  visualMenu,
  visualMenuRoot,
} from "../support/legacy-menus-scene.ts";
const areas = [
  ".otk-inbox-scroll",
  ".otk-panel-content",
  ".otk-messages",
  ".otk-prompt-actions",
];

test("C3 session menus omit current-place no-ops while background Open and task promotion still act", async () => {
  const f = await legacyMenusScene();
  try {
    await f.b.goto(f.url);
    await openSession(f.b, "tstv1-otk");
    for (const theme of ["otk-dark", "otk-light"]) {
      await f.rpc("prefs.set", { key: "theme", value: theme });
      await f.b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await visualMenu(f.b, ".otk-user-bubble");
      assertEquals(
        await f.b.evaluate(
          `[...document.querySelectorAll('${visualMenuRoot} button')].map(e=>e.textContent)`,
        ),
        ["Copy prompt", "Pin as task", "Copy session title", "Close session"],
      );
      await visualDismiss(f.b);
    }
  } finally {
    await f.close();
  }
});
for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
  test(`C3 areas: empty regions, inner groups and shared control commands reach their consumers (${theme})`, async () => {
    const f = await legacyMenusScene();
    try {
      await f.rpc("prefs.set", { key: "theme", value: theme });
      await f.b.goto(f.url);
      await openSession(f.b, "tstv1-otk");
      await f.b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      for (const selector of areas) {
        await visualMenu(f.b, selector, true);
        await visualDismiss(f.b);
      }
      for (
        const selector of [
          '[data-project-sessions~="tstv1-otk"] .otk-project-open',
          ".otk-user-bubble",
        ]
      ) {
        await visualMenu(f.b, selector);
        await visualDismiss(f.b);
      }
    } finally {
      await f.close();
    }
  });
}
test("C3 stock areas: picker and approval commands, Activity panel and Dark/Linen menu geometry", async () => {
  const f = await browserFixture({ bash: "allow" });
  let client: WsClient | undefined;
  try {
    const created = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Area menu visual state" },
    });
    const server = await f.sidecar(), b = await f.browser(server.url);
    client = new WsClient(server.url);
    await client.connect();
    await openSession(b, created.id);
    await b.poll(
      `document.querySelector('.otk-composer-model-name')?.textContent==='scripted'`,
    );
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      for (const selector of areas) {
        await visualMenu(b, selector, true);
        await visualDismiss(b);
      }
    }
  } finally {
    await client?.close();
    await f.stop();
  }
});
