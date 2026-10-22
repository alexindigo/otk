// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { McpFixture } from "../support/mcp.ts";
import { waitFor } from "../support/opencode.ts";
import { WsClient } from "../support/ws-client.ts";
import {
  assertErrorConsumer,
  reloadErrorConsumer,
} from "../support/error-consumer.ts";
test("P5 project, MCP and skill slash commands run with multiline arguments; builtins preserve dirty navigation", async () => {
  const mcp = new McpFixture(),
    f = await browserFixture(undefined, {
      config: {
        mcp: { fixture: { type: "remote", url: mcp.url, enabled: true } },
      },
      async prepare(oc) {
        await Deno.mkdir(join(oc.directory, ".opencode/command"), {
          recursive: true,
        });
        await Deno.writeTextFile(
          join(oc.directory, ".opencode/command/probe.md"),
          "---\ndescription: Fixture project command\n---\nCOMMAND-FIXTURE $ARGUMENTS",
        );
        await Deno.mkdir(join(oc.directory, ".opencode/skills/canary"), {
          recursive: true,
        });
        await Deno.writeTextFile(
          join(oc.directory, ".opencode/skills/canary/SKILL.md"),
          "---\nname: canary\ndescription: Fixture slash skill\n---\nSKILL-FIXTURE content",
        );
      },
    });
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Commands" },
      }),
      server = await f.sidecar(),
      browser = await f.browser(server.url);
    await openSession(browser, session.id);
    await browser.type("textarea[name=prompt]", "/pro");
    await browser.poll(
      "document.querySelector('.otk-autocomplete')?.textContent.includes('/probe')",
    );
    await browser.screenshot(join(f.oc.root, "p5-slash-commands.png"));
    await browser.key("Enter");
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value==='/probe '",
    );
    await browser.type(
      "textarea[name=prompt]",
      "inline args\ncontinued arguments",
    );
    await browser.key("Enter");
    await browser.poll(
      "document.querySelector('[data-role=user] .otk-text')?.textContent.includes('COMMAND-FIXTURE inline args') && document.querySelector('[data-role=user] .otk-text')?.textContent.includes('continued arguments') && document.querySelector('textarea[name=prompt]').value===''",
    );
    await browser.fill("textarea[name=prompt]", "/canary ");
    await browser.key("Enter");
    await browser.poll(
      "[...document.querySelectorAll('[data-role=user] .otk-text')].some(el=>el.textContent.includes('SKILL-FIXTURE content')) && document.querySelector('textarea[name=prompt]').value===''",
    );
    const catalog = await f.oc.request<{ name: string; source: string }[]>(
        "/command",
      ),
      command = catalog.find((command) => command.source === "mcp")!;
    await browser.fill("textarea[name=prompt]", `/${command.name} topic-value`);
    await browser.key("Enter");
    await browser.poll(
      "[...document.querySelectorAll('[data-role=user] .otk-text')].some(el=>el.textContent.includes('MCP prompt topic: topic-value')) && document.querySelector('textarea[name=prompt]').value===''",
    );
    await waitFor(
      () => f.fake.requests,
      (requests) =>
        requests.some((body) =>
          JSON.stringify(body.messages).includes(
            "MCP prompt topic: topic-value",
          )
        ),
    );
    assertEquals(
      mcp.requests.some((request) => request.method === "prompts/get"),
      true,
    );
    await browser.fill("textarea[name=prompt]", "/editor");
    await browser.poll(
      "document.querySelector('.otk-autocomplete')?.textContent.includes('/editor')",
    );
    await browser.key("Enter");
    await browser.poll("!!document.querySelector('dialog[open]')");
    await browser.key("Escape");
    await browser.poll("!document.querySelector('dialog[open]')");
    const before = await f.oc.request<{ id: string }[]>("/session");
    await browser.fill("textarea[name=prompt]", "/new unsent text");
    await browser.key("Enter");
    await browser.poll(
      `!location.hash.endsWith('/${session.id}') && document.querySelector('textarea[name=prompt]').value===''`,
    );
    await openSession(browser, session.id);
    await browser.poll(
      `location.hash.endsWith('/${session.id}') && document.querySelector('textarea[name=prompt]').value==='unsent text'`,
    );
    assertEquals(
      (await f.oc.request<{ id: string }[]>("/session")).length,
      before.length + 1,
      "The /new command creates exactly one session while keeping the original draft",
    );
    await browser.fill("textarea[name=prompt]", "/new");
    await browser.poll(
      "document.querySelector('.otk-autocomplete')?.textContent.includes('/new')",
    );
    await browser.key("Enter");
    await browser.poll(
      `!location.hash.endsWith('/${session.id}') && !!document.querySelector('.otk-prompt') && document.querySelector('textarea[name=prompt]').value===''`,
    );
  } finally {
    await f.stop();
    await mcp.stop();
  }
});
test("long slash admission clears the sent draft and keeps a new draft usable until the real turn completes", async () => {
  const f = await browserFixture(undefined, {
    async prepare(oc) {
      await Deno.mkdir(join(oc.directory, ".opencode/command"), {
        recursive: true,
      });
      await Deno.writeTextFile(
        join(oc.directory, ".opencode/command/probe.md"),
        "---\ndescription: Long fixture command\n---\nLONG-COMMAND $ARGUMENTS",
      );
    },
  });
  try {
    const reply = f.fake.queueHeld({
      chunks: ["Long slash ", "finished."],
      delay: 16000,
    });
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Long slash" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    await browser.fill("textarea[name=prompt]", "/probe multiline\narguments");
    await browser.key("Enter");
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value==='' && document.querySelector('[data-role=user] .otk-text')?.textContent.includes('LONG-COMMAND multiline')",
    );
    await browser.type("textarea[name=prompt]", "keep the next draft");
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value==='keep the next draft' && !document.querySelector('.otk-prompt button[type=submit]').disabled",
    );
    reply.release();
    await browser.poll(
      "document.querySelector('[data-role=assistant] .otk-text')?.textContent==='Long slash finished.' && !document.querySelector('.otk-message[data-role=assistant] .otk-streaming')",
      60000,
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('textarea[name=prompt]').value",
      ),
      "keep the next draft",
    );
    assertEquals(
      await browser.evaluate(
        "!!document.querySelector('.otk-prompt [role=alert]')",
      ),
      false,
    );
  } finally {
    await f.stop();
  }
});
test("deferred slash failure reaches the session consumer and reload while preserving the new draft", async () => {
  const f = await browserFixture();
  let client: WsClient | undefined;
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Slash failure" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    await browser.type("textarea[name=prompt]", "keep this draft");
    client = new WsClient(server.url);
    await client.connect();
    client.send({ t: "subscribe", sessionID: session.id });
    await client.rpc("session.command", {
      sessionID: session.id,
      command: "missing-otk-command",
      arguments: "",
    });
    await browser.poll(
      "document.querySelector('.otk-error-observation[data-source=event] .otk-error-observation-message')?.textContent.startsWith('Command not found:') && !!document.querySelector('.otk-error-observation[data-source=http]')",
    );
    const snapshot = await assertErrorConsumer(browser, client, session.id);
    assert(
      snapshot.errorState?.observations.some((item) =>
        item.source === "http" && item.status === 500 && item.ref
      ),
    );
    assert(
      snapshot.error?.startsWith('Command not found: "missing-otk-command".'),
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('textarea[name=prompt]').value",
      ),
      "keep this draft",
    );
    await reloadErrorConsumer(browser, client, session.id, snapshot);
    assertEquals(f.fake.requests.length, 0);
  } finally {
    await client?.close();
    await f.stop();
  }
});
