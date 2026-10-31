// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  browserFixture,
  openSession,
  sentFrames,
  waitForReply,
} from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { test } from "../support/resources.ts";
import type { TaskRecord } from "@otk/protocol";

test("two cold browsers borrow directory choices, filter and cycle locally, and receive keyed task and file updates", async () => {
  const f = await browserFixture(undefined, {
    config: {
      agent: {
        catalog_review: { mode: "primary", description: "Catalog review" },
      },
    },
    async prepare(oc) {
      await Deno.writeTextFile(
        join(oc.directory, ".gitignore"),
        ".opencode/\n",
      );
      await Deno.mkdir(join(oc.directory, "catalog"));
      for (let i = 0; i < 230; i++) {
        await Deno.writeTextFile(
          join(oc.directory, `catalog/candidate-${i}.txt`),
          `Candidate ${i} provider content`,
        );
      }
    },
  });
  let client: WsClient | undefined;
  try {
    const session = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Directory-owned choices" },
    });
    const sibling = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Shared directory" },
    });
    const server = await f.sidecar({ digest: { publishrows: 8 } });
    client = new WsClient(server.url);
    await client.connect();
    const a = await f.browser(server.url), b = await f.browser(server.url);
    await openSession(a, session.id);
    await openSession(b, session.id);
    for (const browser of [a, b]) {
      await browser.fill("textarea[name=prompt]", "@candidate-229");
      await browser.poll(
        "document.querySelector('.otk-autocomplete')?.textContent.includes('candidate-229.txt')",
      );
      await browser.fill("textarea[name=prompt]", "");
      await browser.poll("!document.querySelector('.otk-autocomplete')");
    }
    const choices = (browser: typeof a) =>
      sentFrames(browser).filter(({ frame }) =>
        typeof frame.method === "string" &&
        /^(?:catalogs\.|agents\.list|models\.list|commands\.list|resources\.list|find\.files|frecency\.list)/
          .test(frame.method)
      );
    const before = choices(a).length;
    for (let i = 0; i < 100; i++) {
      await a.fill("textarea[name=prompt]", `@candidate-${i % 10}`);
    }
    await a.fill("textarea[name=prompt]", "");
    await a.poll("!document.querySelector('.otk-autocomplete')");
    await a.click("textarea[name=prompt]");
    for (let i = 0; i < 100; i++) await a.key("Tab");
    await a.fill("textarea[name=prompt]", "@candidate-229");
    await a.poll(
      "document.querySelector('.otk-autocomplete')?.textContent.includes('candidate-229.txt')",
    );
    assertEquals(
      choices(a).length,
      before,
      "Typing and cycling must borrow ready choices",
    );
    assertEquals(
      sentFrames(a).filter(({ frame }) =>
        [
          "find.files",
          "agents.list",
          "models.list",
          "commands.list",
          "resources.list",
        ].includes(String(frame.method))
      ).length,
      0,
    );
    await a.key("Enter");
    await a.poll(
      "document.querySelector('.otk-prompt-chip')?.textContent.includes('candidate-229.txt')",
    );
    f.fake.queue({
      chunks: ["The complete catalog file reached the provider."],
    });
    await a.key("Enter");
    await waitForReply(
      a,
      session.id,
      "The complete catalog file reached the provider.",
    );
    assertEquals(
      f.fake.requests.some((request) =>
        JSON.stringify(request.messages).includes(
          "Candidate 229 provider content",
        )
      ),
      true,
    );
    // Sending already promotes this session atomically; edit that real task
    // rather than trying to assign its member to a second task.
    const tasks = await client.rpc<TaskRecord[]>("tasks.list", {
      directory: f.oc.directory,
    });
    const task = tasks.find((task) => task.sessions.includes(session.id))!;
    await client.rpc("tasks.rename", {
      id: task.id,
      name: "Shared keyed task",
    });
    await client.rpc("tasks.addSession", {
      id: task.id,
      sessionID: sibling.id,
    });
    for (const browser of [a, b]) {
      await browser.poll(
        "document.querySelector('.otk-task-list')?.textContent.includes('Shared keyed task')",
      );
    }
    await Deno.writeTextFile(
      join(f.oc.directory, "catalog/after-watch.txt"),
      "Watch update",
    );
    for (const browser of [a, b]) {
      await browser.fill("textarea[name=prompt]", "@after-watch");
      await browser.poll(
        "document.querySelector('.otk-autocomplete')?.textContent.includes('after-watch.txt')",
      );
    }
    assertEquals(choices(a).length, before);
    await a.fill("textarea[name=prompt]", "");
    await a.poll("!document.querySelector('.otk-autocomplete')");
    await a.click(".otk-agent-picker .otk-popover-trigger");
    await a.poll(
      "document.querySelector('.otk-agent-picker .otk-popover-trigger')?.getAttribute('aria-expanded')==='true' && document.querySelector('.otk-agent-picker .otk-picker-status button')?.textContent==='Refresh'",
    );
    assertEquals(
      choices(a).length,
      before,
      "Opening a ready picker does not refresh it",
    );
    await a.click(".otk-agent-picker .otk-picker-status button");
    await a.poll(
      "document.querySelector('.otk-agent-picker .otk-picker-status button')?.textContent==='Refresh' && !document.querySelector('.otk-agent-picker [role=status]')",
    );
    assertEquals(
      sentFrames(a).filter(({ frame }) => frame.method === "catalogs.refresh")
        .length,
      1,
    );
    const shots = Deno.env.get("OTK_C4_SCREENSHOTS");
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await a.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      if (shots) {
        await a.screenshot(join(shots, `${theme}-catalog-updates.png`));
      }
    }
    assertEquals(
      client.frames.filter((frame) => frame.t === "inbox.snapshot").length,
      1,
    );
    await a.reload();
    await a.poll(
      "document.querySelector('.otk-task-list')?.textContent.includes('Shared keyed task') && !!document.querySelector('textarea[name=prompt]')",
    );
  } finally {
    await client?.close();
    await f.stop();
  }
});
