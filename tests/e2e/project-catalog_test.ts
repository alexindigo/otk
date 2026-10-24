// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { InboxSnapshot } from "@otk/protocol";
import { fixture } from "../support/config.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { Cdp } from "../support/cdp.ts";
import { WsClient } from "../support/ws-client.ts";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { waitFor } from "../support/opencode.ts";

for (const theme of ["otk-dark", "otk-light"]) {
  test(`project catalog sections, discovery lights, viewing, creation and persisted collapse in ${theme}`, async () => {
    const root = await fixture(),
      f = await inboxBrowserFixture(root),
      client = new WsClient(f.url),
      b = await Cdp.launch(root);
    const projects = join(root, "projects"),
      empty = join(projects, "empty"),
      worktree = join(projects, "linked"),
      metadata = join(projects, "otk", ".git", "worktrees", "linked");
    const row = (directory: string) =>
      `.otk-project-row[data-project=${JSON.stringify(directory)}]`;
    const find = (directory: string) =>
      `document.querySelector(${JSON.stringify(row(directory))})`;
    const snap = () => client.rpc<InboxSnapshot>("inbox.get", {});
    try {
      await Deno.mkdir(empty);
      const finishedDirectory = join(projects, "finished-discovery");
      await Deno.mkdir(finishedDirectory);
      f.add({
        ...f.entries[0],
        id: "discovered-finish",
        directory: finishedDirectory,
        title: "Unseen discovery",
      });
      await Deno.mkdir(worktree);
      await Deno.mkdir(metadata, { recursive: true });
      await Deno.writeTextFile(join(metadata, "commondir"), "../..\n");
      await Deno.writeTextFile(
        join(metadata, "gitdir"),
        join(worktree, ".git") + "\n",
      );
      await Deno.writeTextFile(join(worktree, ".git"), `gitdir: ${metadata}\n`);
      await client.connect();
      await client.rpc("projects.visit", {
        directory: f.entries[0].directory,
        active: true,
      });
      await client.rpc("projects.visit", {
        directory: f.entries[3].directory,
        active: true,
      });
      await client.rpc("projects.inactive", {
        directory: f.entries[3].directory,
        inactive: true,
      });
      await client.rpc("projects.templates", {
        templates: [join(projects, "{project}")],
      });
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.goto(f.url);
      await b.poll(
        "document.querySelector('.otk-discovered-toggle')?.textContent.includes('(4)')",
      );
      assertEquals(await b.evaluate(`!!${find(worktree)}`), false);
      assertEquals(
        await b.evaluate(
          `${find(empty)}.querySelectorAll('.otk-status-light').length`,
        ),
        0,
      );
      assertEquals(
        await b.evaluate(
          `${
            find(f.entries[1].directory)
          }.querySelector('.otk-status-light').dataset.state`,
        ),
        "idle",
      );
      assertEquals(
        await b.evaluate(
          "[...document.querySelectorAll('.otk-inbox-scroll > *')].map(e=>e.className).filter(x=>x.includes('toggle'))",
        ),
        ["otk-discovered-toggle", "otk-inactive-toggle"],
      );
      const starts = await b.evaluate<number[]>(
        "[...document.querySelectorAll('.otk-project-name-line')].map(e=>e.getBoundingClientRect().left)",
      );
      assert(
        Math.max(...starts) - Math.min(...starts) < .5,
        "Discovery and tracked names must share the same structural leading edge",
      );
      if (Deno.env.get("OTK_PROJECT_CATALOG_SHOTS")) {
        await b.screenshot(join(root, `catalog-${theme}.png`));
        console.info("CATALOG SCREENSHOTS", root);
      }
      // Opening both an indexed session and a session-free directory is viewing.
      await openSession(b, "atmosphera");
      await b.click(`${row(empty)} .otk-project-open`);
      assertEquals(
        (await snap()).projects.map((p) => p.directory).includes(empty),
        false,
      );
      assertEquals(
        (await snap()).projects.map((p) => p.directory).includes(
          f.entries[1].directory,
        ),
        false,
      );
      await b.click(".otk-discovered-toggle");
      await waitFor(snap, (inbox) => !!inbox);
      await b.poll(
        "document.querySelector('.otk-discovered-toggle')?.getAttribute('aria-expanded')==='false'",
      );
      f.update("atmosphera", { status: "busy" });
      f.update("globnotes", {
        attention: {
          permissions: 1,
          questions: 0,
          childPermissions: 0,
          childQuestions: 0,
        },
      });
      f.update("discovered-finish", { status: "busy" });
      f.update("discovered-finish", { status: "idle" });
      for (const id of ["atmosphera", "globnotes", "discovered-finish"]) {
        const directory = f.entries.find((e) => e.id === id)!.directory;
        await b.poll(`!!${find(directory)}`);
        assert(
          await b.evaluate(
            `(()=>{const r=${
              find(directory)
            }.getBoundingClientRect();return r.height>0&&r.top>=0&&r.bottom<=innerHeight})()`,
          ),
        );
      }
      await b.reload();
      await b.poll(
        "document.querySelector('.otk-discovered-toggle')?.getAttribute('aria-expanded')==='false'",
      );
      assertEquals(await b.evaluate(`!!${find(empty)}`), false);
      await b.poll(
        `${find(f.entries[1].directory)}?.dataset.rollup==='working'`,
      );
      await b.poll(
        `${find(f.entries[2].directory)}?.dataset.rollup==='blocked'`,
      );
      await b.poll(`${find(finishedDirectory)}?.dataset.rollup==='finished'`);
      await b.poll(
        "!document.querySelector('.otk-error') && !document.querySelector('.otk-toast')",
      );
      if (Deno.env.get("OTK_PROJECT_CATALOG_SHOTS")) {
        await b.screenshot(join(root, `catalog-collapsed-${theme}.png`));
      }
      // Existing phantom ownership remains available in a discovered project.
      await openSession(b, "atmosphera");
      await b.poll("!!document.querySelector('[data-kind=phantom]')");
      f.update("atmosphera", { status: "idle" });
      await b.click(".otk-discovered-toggle");
      await b.poll(`!!${find(empty)}`);
      const lightPositions = () =>
        b.evaluate<number[]>(
          "[...document.querySelectorAll('.otk-project-row[data-inactive=false] .otk-status-light')].map(e=>{const r=e.getBoundingClientRect();return r.y+r.height/2})",
        );
      const columnLights = await lightPositions();
      await b.click('[aria-label="Collapse projects"]');
      await b.poll(
        "document.querySelector('.otk-project-inbox').dataset.collapsed==='true'",
      );
      assertEquals(
        await lightPositions(),
        columnLights,
        "Discovery section geometry must survive the rail transition",
      );
      assertEquals(
        await b.evaluate(
          `${find(empty)}.querySelectorAll('.otk-status-light').length`,
        ),
        0,
      );
      if (Deno.env.get("OTK_PROJECT_CATALOG_SHOTS")) {
        await b.screenshot(join(root, `catalog-rail-${theme}.png`));
      }
      await b.click('[aria-label="Expand projects"]');
      await b.poll(
        "document.querySelector('.otk-project-inbox').dataset.collapsed==='false'",
      );
      // The shared captured project context offers New session, never Mark active.
      await b.click(`${row(empty)} .otk-project-menu > button`);
      await b.poll("!!document.querySelector('[role=menuitem]')");
      assertEquals(
        await b.evaluate(
          "[...document.querySelectorAll('[role=menuitem]')].map(e=>e.textContent.trim())",
        ),
        ["New session"],
      );
      if (Deno.env.get("OTK_PROJECT_CATALOG_SHOTS")) {
        await b.screenshot(join(root, `catalog-menu-${theme}.png`));
      }
      await b.click("[role=menuitem]");
      await b.poll(`${find(empty)}?.dataset.source==='tracked'`);
      assert(
        f.entries.some((e) => e.directory === empty),
        "Creation did not reach the backend",
      );
      // A successful ordinary prompt uses the same action owner as shell,
      // command, permission and question replies.
      await openSession(b, "atmosphera");
      await b.type("textarea[name=prompt]", "Track this interaction");
      await b.key("Enter");
      await b.poll(
        `${find(f.entries[1].directory)}?.dataset.source==='tracked'`,
      );
      assertEquals(b.errors, []);
    } finally {
      await client.close();
      await b.close();
      await f.app.stop();
    }
  });
}

test("idle discovered catalog renders without creating a native opencode instance", async () => {
  const f = await browserFixture({}, { env: { OPENCODE_PRINT_LOGS: "1" } });
  try {
    const directories = [f.oc.directory, join(f.oc.root, "another-project")];
    await Deno.mkdir(directories[1]);
    for (const directory of directories) {
      await f.oc.request("/session", {
        method: "POST",
        directory,
        body: { title: "Idle discovery" },
      });
    }
    await f.oc.restart();
    const logStart = f.oc.log.length;
    const server = await f.sidecar(), b = await f.browser(server.url);
    await b.poll(
      "document.querySelectorAll('.otk-discovered-projects .otk-project-row').length===2",
    );
    assertEquals(
      await b.evaluate(
        "[...document.querySelectorAll('.otk-discovered-projects .otk-status-light')].map(e=>e.dataset.state)",
      ),
      ["idle", "idle"],
    );
    const created = f.oc.log.slice(logStart).split("\n").filter((line) =>
      line.includes("creating instance")
    );
    console.info("CATALOG IDLE NATIVE INSTANCES", created.length);
    assertEquals(created, [], "Rendering idle discovery woke native instances");
  } finally {
    await f.stop();
  }
});
