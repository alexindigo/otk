// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { InboxSnapshot } from "@otk/protocol";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import {
  inboxBrowserFixture,
  inboxClockScript,
} from "../support/inbox-browser.ts";
import { WsClient } from "../support/ws-client.ts";
import {
  openSession,
  waitForCollapsedPanels,
} from "../support/browser-fixture.ts";
import { waitFor } from "../support/opencode.ts";

const row = (directory: string) =>
  `[data-project=${JSON.stringify(directory)}]`;
async function visible(browser: Cdp, selector: string) {
  return await browser.evaluate<boolean>(
    `(()=>{const e=document.querySelector(${
      JSON.stringify(selector)
    });if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&getComputedStyle(e).visibility!=='hidden'})()`,
  );
}
Deno.test("inbox activity returns inactive projects and all three required lights remain on-screen across reload and the rail", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    browser = await Cdp.launch(root),
    client = new WsClient(f.url);
  try {
    await client.connect();
    await browser.goto(f.url);
    await browser.poll(
      "document.querySelectorAll('.otk-project-row').length===4",
    );
    // Select the other session before producing the unseen finish. Switching
    // projects later legitimately opens its first root, so it is not a direct
    // observation of opening only this other session.
    await openSession(browser, "other-finished");
    await browser.click(".otk-panel-collapse");
    await browser.poll("document.querySelector('.otk-right-panel').hidden");
    for (const entry of f.entries.slice(0, 3)) {
      const selector = row(entry.directory);
      await browser.click(`${selector} .otk-project-menu > button`);
      await browser.click(`${selector} .otk-menu-items button`);
      await browser.poll(
        `!document.querySelector(${JSON.stringify(selector)})`,
      );
    }
    await browser.poll(
      "document.querySelector('.otk-inactive-toggle').textContent.includes('(3)')",
    );
    f.update("otk", { status: "busy" });
    f.update("atmosphera", {
      attention: {
        permissions: 1,
        questions: 0,
        childPermissions: 0,
        childQuestions: 0,
      },
    });
    f.update("globnotes", { status: "busy" });
    f.update("globnotes", { status: "idle" });
    const expected = ["working", "blocked", "finished"];
    for (let i = 0; i < 3; i++) {
      await browser.poll(
        `document.querySelector(${
          JSON.stringify(row(f.entries[i].directory))
        })?.dataset.rollup===${JSON.stringify(expected[i])}`,
      );
    }
    const persisted = await client.rpc<InboxSnapshot>("inbox.get", {});
    assert(persisted.projects.every((p) => !p.inactive));
    await browser.click('[aria-label="Collapse projects"]');
    await browser.poll(
      "document.querySelector('.otk-project-inbox').getBoundingClientRect().width===48",
    );
    for (let reload = 0; reload < 2; reload++) {
      if (reload) await browser.reload();
      await waitForCollapsedPanels(browser);
      assertEquals(
        await browser.evaluate(
          "document.querySelector('.otk-right-panel').hidden",
        ),
        true,
      );
      for (let i = 0; i < 3; i++) {
        const selector = `${
          row(f.entries[i].directory)
        } .otk-status-light[data-state=${expected[i]}]`;
        await browser.poll(
          `!!document.querySelector(${JSON.stringify(selector)})`,
        );
        assert(await visible(browser, selector), selector);
      }
    }
    await browser.click('[aria-label="Expand projects"]');
    await browser.poll(
      "document.querySelector('.otk-project-inbox').getBoundingClientRect().width===248",
    );
    const unread = `${row(f.entries[2].directory)} .otk-project-name`;
    const alignment = await browser.evaluate<number[]>(
      `[...document.querySelectorAll('.otk-project-open')].map(e=>{const a=e.querySelector('.otk-status-light').getBoundingClientRect(),b=e.querySelector('.otk-project-name-line').getBoundingClientRect(),c=e.querySelector('time').getBoundingClientRect();return Math.max(Math.abs(a.y+a.height/2-b.y-b.height/2),Math.abs(a.y+a.height/2-c.y-c.height/2))})`,
    );
    assert(alignment.every((delta) => delta < .5), JSON.stringify(alignment));
    assertEquals(
      await browser.evaluate(
        `document.querySelector(${JSON.stringify(unread)}).dataset.unread`,
      ),
      "true",
    );
    await openSession(browser, "other-finished");
    assertEquals(
      await browser.evaluate(
        `document.querySelector(${JSON.stringify(unread)}).dataset.unread`,
      ),
      "true",
      "Opening another session must not clear the finish",
    );
    await openSession(browser, "globnotes");
    await browser.poll(
      `document.querySelector(${
        JSON.stringify(unread)
      })?.dataset.unread==='false'`,
    );
    assertEquals(browser.errors, []);
  } finally {
    await client.close();
    await browser.close();
    await f.app.stop();
  }
});

Deno.test("inbox mocked-clock ageing, reduced-colour underlines, visit resets on opening and acting, and inactive clock pause", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    browser = await Cdp.launch(root),
    client = new WsClient(f.url);
  try {
    await client.connect();
    await browser.send("Page.addScriptToEvaluateOnNewDocument", {
      source: inboxClockScript,
    });
    await browser.goto(f.url);
    await browser.poll(
      "document.querySelectorAll('.otk-project-row').length===4",
    );
    const entry = f.entries[0],
      selector = row(entry.directory),
      project = (await client.rpc<InboxSnapshot>("inbox.get", {})).projects
        .find((p) => p.directory === entry.directory)!;
    for (const [hours, level] of [[0, 0], [2, 1], [8, 2], [24, 3]]) {
      await browser.evaluate(
        `inboxNow=${project.lastVisit + hours * 3_600_000};inboxTick()`,
      );
      await browser.poll(
        `document.querySelector(${
          JSON.stringify(`${selector} .otk-project-name`)
        })?.classList.contains('otk-age-${level}')`,
      );
    }
    await client.rpc("prefs.set", { key: "reducedColors", value: true });
    await browser.poll(
      "document.documentElement.hasAttribute('data-otk-reduced-colors')",
    );
    assertEquals(
      await browser.evaluate(
        `getComputedStyle(document.querySelector(${
          JSON.stringify(`${selector} .otk-project-name`)
        })).textDecorationStyle`,
      ),
      "double",
    );
    await client.rpc("prefs.set", { key: "reducedColors", value: false });
    await browser.evaluate(
      "inboxNow=performance.timeOrigin+performance.now();inboxTick()",
    );
    await browser.click(`${selector} .otk-project-open`);
    await browser.poll(
      `document.querySelector(${
        JSON.stringify(`${selector} time`)
      })?.textContent==='now'`,
    );
    const opened =
      (await client.rpc<InboxSnapshot>("inbox.get", {})).projects.find((p) =>
        p.directory === entry.directory
      )!.lastVisit;
    assert(opened >= project.lastVisit);
    await openSession(browser, "otk");
    await browser.poll(
      `document.querySelector(${
        JSON.stringify(`${selector} time`)
      })?.textContent==='now'`,
    );
    const sessionInbox = await waitFor(
      () => client.rpc<InboxSnapshot>("inbox.get", {}),
      (value) => !!value.seen.otk,
    );
    const sessionVisit = sessionInbox.projects.find((p) =>
      p.directory === entry.directory
    )!.lastVisit;
    await browser.evaluate(`inboxNow=${sessionVisit + 3_600_000};inboxTick()`);
    await browser.poll(
      `document.querySelector(${
        JSON.stringify(`${selector} time`)
      })?.textContent==='1h'`,
    );
    await browser.type("textarea[name=prompt]", "Reset the project visit");
    await browser.key("Enter");
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value===''",
    );
    const acted =
      (await client.rpc<InboxSnapshot>("inbox.get", {})).projects.find((p) =>
        p.directory === entry.directory
      )!.lastVisit;
    assert(acted > opened);
    await browser.evaluate(
      "inboxNow=performance.timeOrigin+performance.now();inboxTick()",
    );
    await browser.poll(
      `document.querySelector(${
        JSON.stringify(`${selector} time`)
      })?.textContent==='now'`,
    );
    await browser.click(`${selector} .otk-project-menu > button`);
    await browser.click(`${selector} .otk-menu-items button`);
    await browser.poll("!!document.querySelector('.otk-inactive-toggle')");
    await browser.click(".otk-inactive-toggle");
    await browser.poll(`!!document.querySelector(${JSON.stringify(selector)})`);
    const paused = await browser.evaluate(
      `document.querySelector(${
        JSON.stringify(`${selector} time`)
      }).textContent`,
    );
    await browser.evaluate("inboxNow+=100*3_600_000;inboxTick()");
    assertEquals(
      await browser.evaluate(
        `document.querySelector(${
          JSON.stringify(`${selector} time`)
        }).textContent`,
      ),
      paused,
    );
    assertEquals(browser.errors, []);
  } finally {
    await client.close();
    await browser.close();
    await f.app.stop();
  }
});

Deno.test("inbox adds empty and scanned projects, persists layout bounds and keeps centre navigation guarded", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    browser = await Cdp.launch(root),
    client = new WsClient(f.url);
  try {
    await client.connect();
    await client.rpc("projects.templates", {
      templates: [join(root, "projects", "{project}")],
    });
    await browser.goto(f.url);
    await browser.poll("!!document.querySelector('.otk-add-project')");
    await browser.click(".otk-add-project");
    await browser.poll(
      "document.querySelectorAll('.otk-template-paths button').length===4",
    );
    await browser.click(".otk-template-paths button");
    await browser.poll(
      "document.querySelector('input[name=directory]').value.length>0",
    );
    assert(
      await browser.evaluate(
        "document.querySelector('input[name=directory]').value.length>0",
      ),
    );
    const empty = join(root, "empty-project");
    await Deno.mkdir(empty);
    await browser.fill("input[name=directory]", empty);
    await browser.click("dialog .otk-form button[type=submit]");
    await browser.poll(
      `location.hash.includes('empty-project') && !!document.querySelector(${
        JSON.stringify(row(empty))
      }) && !!document.querySelector('.otk-new-session')`,
    );
    assertEquals(
      (await client.rpc<InboxSnapshot>("inbox.get", {})).projects.find((p) =>
        p.directory === empty
      )?.added,
      true,
    );
    const resizer = ".otk-inbox-resizer";
    await browser.click(resizer);
    await browser.key("End");
    await browser.poll(
      "document.querySelector('.otk-project-inbox').getBoundingClientRect().width===360",
    );
    await browser.key("Home");
    await browser.poll(
      "document.querySelector('.otk-project-inbox').getBoundingClientRect().width===200",
    );
    await browser.reload();
    await browser.poll(
      "document.querySelector('.otk-project-inbox')?.getBoundingClientRect().width===200 && location.hash.includes('empty-project')",
    );
    await browser.send("Emulation.setDeviceMetricsOverride", {
      width: 720,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    assertEquals(
      await browser.evaluate(
        "getComputedStyle(document.querySelector('.otk-project-inbox')).position",
      ),
      "relative",
    );
    await openSession(browser, "otk");
    await browser.type("textarea[name=prompt]", "Keep this work");
    const target = `${row(f.entries[1].directory)} .otk-project-open`;
    await browser.click(target);
    await browser.poll("location.hash.endsWith('/atmosphera')");
    await openSession(browser, "otk");
    assert(
      await browser.evaluate(
        "location.hash.endsWith('/otk') && document.querySelector('textarea[name=prompt]').value==='Keep this work'",
      ),
    );
    await browser.click(target);
    await browser.poll(
      "location.hash.endsWith('/atmosphera') && !!document.querySelector('.otk-prompt') && document.querySelector('textarea[name=prompt]').value===''",
    );
    assertEquals(browser.errors, []);
  } finally {
    await client.close();
    await browser.close();
    await f.app.stop();
  }
});
Deno.test("inbox merges servers with duplicate-name machine labels and stable order through status changes", async () => {
  const root = await fixture(),
    a = await inboxBrowserFixture(join(root, "first")),
    b = await inboxBrowserFixture(join(root, "second"), [a.url]),
    browser = await Cdp.launch(root);
  try {
    await browser.goto(a.url);
    await browser.poll(
      "document.querySelectorAll('.otk-project-row').length===4",
    );
    await browser.click(".otk-settings-entry");
    await browser.type("input[name=url]", b.url);
    await browser.type("input[name=label]", "Build machine");
    await browser.click(
      ".otk-settings-content > .otk-form button[type=submit]",
    );
    await browser.poll(
      "document.querySelectorAll('.otk-project-row').length===8",
    );
    await browser.click(".otk-settings .otk-view-header button");
    await browser.poll("!document.querySelector('.otk-settings')");
    assertEquals(
      await browser.evaluate(
        "[...document.querySelectorAll('.otk-project-machine')].map(e=>e.textContent)",
      ),
      [...Array(4).fill("This server"), ...Array(4).fill("Build machine")],
    );
    const order = await browser.evaluate(
      "[...document.querySelectorAll('.otk-project-row')].map(e=>e.dataset.project)",
    );
    b.update("luch", { status: "busy" });
    await browser.poll(
      `document.querySelector(${
        JSON.stringify(row(b.entries[3].directory))
      })?.dataset.rollup==='working'`,
    );
    assertEquals(
      await browser.evaluate(
        "[...document.querySelectorAll('.otk-project-row')].map(e=>e.dataset.project)",
      ),
      order,
    );
    await browser.reload();
    await browser.poll(
      "document.querySelectorAll('.otk-project-row').length===8",
    );
    assertEquals(
      await browser.evaluate(
        "[...document.querySelectorAll('.otk-project-row')].map(e=>e.dataset.project)",
      ),
      order,
    );
    assertEquals(browser.errors, []);
  } finally {
    await browser.close();
    await b.app.stop();
    await a.app.stop();
  }
});
Deno.test("opening the already-selected session resets its visit without replacing the URL or draft", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    browser = await Cdp.launch(root),
    client = new WsClient(f.url);
  try {
    await client.connect();
    await browser.goto(f.url);
    await openSession(browser, "otk");
    const snapshot = await waitFor(
      () => client.rpc<InboxSnapshot>("inbox.get", {}),
      (value) => !!value.seen.otk,
    );
    const before = snapshot.projects.find((p) =>
      p.directory === f.entries[0].directory
    )!.lastVisit;
    await browser.type(
      "textarea[name=prompt]",
      "Keep this draft on the same session",
    );
    const hash = await browser.evaluate("location.hash");
    await browser.click('[data-session="otk"]');
    await waitFor(
      () => client.rpc<InboxSnapshot>("inbox.get", {}),
      (value) =>
        value.projects.find((p) => p.directory === f.entries[0].directory)!
          .lastVisit > before,
      3000,
    );
    assertEquals(await browser.evaluate("location.hash"), hash);
    assertEquals(
      await browser.evaluate(
        "document.querySelector('textarea[name=prompt]').value",
      ),
      "Keep this draft on the same session",
    );
    assertEquals(browser.errors, []);
  } finally {
    await client.close();
    await browser.close();
    await f.app.stop();
  }
});
