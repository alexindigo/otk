// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert } from "@std/assert";
import {
  browserFixture,
  openSession,
  waitForReply,
} from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { revealViewportElement } from "../support/message-viewport.ts";
import {
  legacyMenusScene,
  visualDismiss,
  visualMenu,
} from "../support/legacy-menus-scene.ts";

test("C2 session targets: tabs, chips, rows, task actions and project menu have captured effects", async () => {
  const f = await legacyMenusScene();
  try {
    const b = f.b;
    await f.rpc("projects.visit", {
      directory: f.lease.directory,
      active: true,
    });
    await b.goto(f.url);
    await openSession(b, "tstv1-otk");
    const task = await f.rpc("tasks.create", {
      directory: f.lease.directory,
      name: "Visual task",
    }) as { id: string };
    await b.poll(`!!document.querySelector('[data-tab="${task.id}"]')`);
    for (const theme of ["otk-dark", "otk-light"]) {
      await f.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      for (
        const selector of [
          '[data-tab="tstv1-otk"]',
          '[data-crumb="tstv1-otk"]',
          '[data-session="tstv1-otk"]',
          `[data-tab="${task.id}"]`,
          '[data-project-sessions~="tstv1-otk"] .otk-project-open',
        ]
      ) {
        await visualMenu(b, selector);
        await visualDismiss(b);
      }
    }
  } finally {
    await f.close();
  }
});
for (const theme of ["otk-dark", "otk-light"]) {
  test(`C2 project dots share the row projection and report failures without rejected event handlers (${theme})`, async () => {
    const f = await legacyMenusScene("contract-menus-context");
    try {
      const b = f.b;
      await b.goto(f.url);
      await b.click("#mount-project-probe");
      await b.poll(
        '!!document.querySelector("#project-probe .otk-project-open")',
      );
      await b.click(theme === "otk-dark" ? "#dark" : "#light");
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await b.evaluate(
        'document.querySelector("#project-probe .otk-project-menu button").focus()',
      );
      await b.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        text: "\r",
        unmodifiedText: "\r",
      });
      await b.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
      const dots =
        ':popover-open [role=menu][aria-label="Project menu for probe"]';
      await b.poll(`!!document.querySelector('${dots} button')`);
      await b.click(`${dots} button`);
      await b.poll(
        '!!document.querySelector("#project-probe .otk-project-error")',
      );
      assert(
        await b.evaluate(
          `(()=>{const row=document.querySelector('#project-probe [data-project]').getBoundingClientRect(),action=document.querySelector('#project-probe .otk-project-open').getBoundingClientRect(),r=document.querySelector('#project-probe .otk-project-error').getBoundingClientRect();return r.top>=action.bottom&&r.bottom<=row.bottom&&r.left>=action.left&&r.right<=row.right})()`,
        ),
      );
    } finally {
      await f.close();
    }
  });
}
test("C2 content targets: prompt, whole reply, nested code/diff and feature-contributed tool sources", async () => {
  const f = await legacyMenusScene("contract-menus-content");
  try {
    const b = f.b;
    await b.goto(f.url);
    await openSession(b, "tstv1-otk");
    for (const theme of ["otk-dark", "otk-light"]) {
      await f.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      for (
        const selector of [
          ".otk-user-bubble",
          '[data-message="reply"] .otk-text p',
          '[data-message="reply"] .otk-code',
          "[data-tool=bash] .otk-tool-toggle",
          "[data-tool=patch] .otk-tool-toggle",
        ]
      ) {
        await revealViewportElement(b, ".otk-messages", selector);
        await visualMenu(b, selector);
        await visualDismiss(b);
      }
      await revealViewportElement(
        b,
        ".otk-messages",
        "[data-tool=edit] .otk-tool-toggle",
      );
      if (
        !await b.evaluate(
          'document.querySelector("[data-tool=edit] .otk-tool-toggle").getAttribute("aria-expanded")==="true"',
        )
      ) await b.click("[data-tool=edit] .otk-tool-toggle");
      for (
        const selector of [
          ".otk-diff .otk-diff-text",
          "[data-tool=edit] .otk-diff-content:nth-of-type(2) .otk-diff-text",
        ]
      ) {
        await revealViewportElement(b, ".otk-messages", selector);
        await visualMenu(b, selector);
        await visualDismiss(b);
      }
    }
  } finally {
    await f.close();
  }
});
test("C2 stock capabilities: targeted auto-approve and reply usage menu reach their real consumers", async () => {
  const f = await browserFixture({ bash: "allow" });
  let client: WsClient | undefined;
  try {
    const first = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Visual reply" },
    });
    const other = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Visual background" },
    });
    const server = await f.sidecar(), b = await f.browser(server.url);
    client = new WsClient(server.url);
    await client.connect();
    await openSession(b, first.id);
    f.fake.queue({ chunks: ["Usage menu reply."] });
    await b.type("textarea[name=prompt]", "Visual usage state");
    await b.key("Enter");
    await waitForReply(b, first.id, "Usage menu reply.");
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      for (const enabled of [false, true]) {
        await client.rpc("permission.auto", { sessionID: other.id, enabled });
        await visualMenu(b, `[data-session="${other.id}"]`);
        await visualDismiss(b);
      }
      await visualMenu(b, "[data-role=assistant] .otk-text p");
      await b.click('[data-context-command="reply.usage"]');
      await b.poll('!!document.querySelector(".otk-usage-breakdown tbody tr")');
      await b.key("Escape");
    }
  } finally {
    await client?.close();
    await f.stop();
  }
});
