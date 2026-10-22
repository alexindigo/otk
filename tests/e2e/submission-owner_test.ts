// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { ProjectRecord, TaskRecord } from "@otk/protocol";
import {
  browserFixture,
  openSession,
  sentFrames,
} from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { waitFor } from "../support/opencode.ts";

for (const path of ["normal", "shell", "slash", "palette"] as const) {
  Deno.test(`${path} submission promotes its phantom once and records successful actions through reload`, async () => {
    const f = await browserFixture(undefined, {
      async prepare(oc) {
        const directory = join(oc.directory, ".opencode/command");
        await Deno.mkdir(directory, { recursive: true });
        await Deno.writeTextFile(
          join(directory, "probe.md"),
          "---\ndescription: Submission owner probe\n---\nSUBMISSION-PROBE $ARGUMENTS",
        );
      },
    });
    let c: WsClient | undefined;
    try {
      const session = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: `Submit ${path}` },
      });
      const server = await f.sidecar(), b = await f.browser(server.url);
      c = new WsClient(server.url);
      await c.connect();
      await openSession(b, session.id);
      await b.poll(
        `!!document.querySelector('.otk-tab[data-kind=phantom] [data-tab="${session.id}"]')`,
      );
      // Wait for the navigation bookkeeping before measuring submission visits.
      await waitFor(
        () =>
          sentFrames(b).some(({ frame }) => frame.method === "sessions.seen"),
        Boolean,
      );
      const before = (await c.rpc<ProjectRecord[]>("projects.list", {})).find(
        (p) => p.directory === f.oc.directory,
      )!;
      const start = sentFrames(b).length;
      for (let turn = 0; turn < 2; turn++) {
        if (path === "palette") {
          await b.key("k", 2);
          await b.poll(
            "!!document.querySelector('input[name=command-search]')",
          );
          await b.fill("input[name=command-search]", "Submission owner probe");
          await b.poll(
            "!!document.querySelector('[data-command=\"server.command:probe\"]')",
          );
          await b.click('[data-command="server.command:probe"]');
          await b.poll("!document.querySelector('dialog[open]')");
        } else {
          if (path === "shell") {
            await b.click("textarea[name=prompt]");
            await b.key("!");
            await b.poll(
              "document.querySelector('.otk-prompt > label').textContent==='Shell'",
            );
          }
          await b.fill(
            "textarea[name=prompt]",
            path === "shell"
              ? `printf 'SUBMISSION-SHELL-${turn}'`
              : path === "slash"
              ? `/probe turn-${turn}`
              : `SUBMISSION-NORMAL-${turn}`,
          );
          // Clicking Send also exercises typed slash without choosing autocomplete.
          await b.click(".otk-prompt button[type=submit]");
          await b.poll(
            "document.querySelector('textarea[name=prompt]').value===''",
          );
        }
        if (path === "shell") {
          await b.poll(
            `[...document.querySelectorAll('[data-tool=bash]')].some(el=>el.dataset.toolStatus==='completed'&&el.textContent.includes('SUBMISSION-SHELL-${turn}'))`,
          );
        } else {
          await b.poll(
            `document.querySelectorAll('[data-role=assistant] .otk-text').length>=${
              turn + 1
            } && document.querySelector('[data-session="${session.id}"]')?.dataset.status==='idle'`,
          );
        }
        const tasks = await c.rpc<TaskRecord[]>("tasks.list", {
          directory: f.oc.directory,
        });
        assertEquals(
          tasks.length,
          1,
          `${path} submission left its session outside a task`,
        );
        assertEquals(tasks[0].sessions, [session.id]);
        await b.poll(
          `!!document.querySelector('.otk-tab[data-kind=task] [data-tab="${
            tasks[0].id
          }"][aria-selected=true]') && !document.querySelector('.otk-tab[data-kind=phantom] [data-tab="${session.id}"]')`,
        );
        const frames = sentFrames(b).slice(start).map(({ frame }) => frame);
        const method = path === "shell"
          ? "session.shell"
          : path === "normal"
          ? "session.prompt"
          : "session.command";
        assertEquals(
          frames.filter((frame) => frame.method === "tasks.create").length,
          1,
        );
        assertEquals(
          frames.filter((frame) => frame.method === method).length,
          turn + 1,
        );
        assertEquals(
          frames.filter((frame) => frame.method === "projects.visit").length,
          turn + 1,
        );
      }
      const after = (await c.rpc<ProjectRecord[]>("projects.list", {})).find(
        (p) => p.directory === f.oc.directory,
      )!;
      assertEquals(after.lastVisit > before.lastVisit, true);
      const task = (await c.rpc<TaskRecord[]>("tasks.list", {
        directory: f.oc.directory,
      }))[0];
      await b.reload();
      await b.poll(
        `!!document.querySelector('.otk-tab[data-kind=task] [data-tab="${task.id}"][aria-selected=true]') && !!document.querySelector('[data-crumb="${session.id}"][aria-current=page]') && !!document.querySelector('.otk-prompt')`,
      );
      const shots = Deno.env.get("OTK_SUBMISSION_SHOTS");
      if (shots) {
        await Deno.mkdir(shots, { recursive: true });
        for (
          const [name, theme] of [["dark", "otk-dark"], ["light", "otk-light"]]
        ) {
          await c.rpc("prefs.set", { key: "theme", value: theme });
          await b.poll(
            `document.documentElement.dataset.otkTheme===${
              JSON.stringify(theme)
            }`,
          );
          await b.screenshot(join(shots, `${path}-${name}.png`));
        }
      }
      assertEquals(b.errors, []);
    } finally {
      await c?.close();
      await f.stop();
    }
  });
}
