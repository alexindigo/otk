// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import {
  browserFixture,
  openSession,
  sentFrames,
} from "../support/browser-fixture.ts";
import { waitFor } from "../support/opencode.ts";

test("new-session slash and palette pointer/keyboard invocations resolve their directory while initial project loads are pending", async () => {
  const f = await browserFixture();
  try {
    const seed = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "New-session readiness" },
    });
    const server = await f.sidecar(), b = await f.browser(server.url);
    await b.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
      window.holdCreationLoads = false;
      window.holdCreationDirectory = false;
      window.heldCreationLoads = [];
      window.creationLoadReplies = new Set();
      window.creationGetSessions = new Set();
      window.WebSocket = class extends WebSocket {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', event => {
            const frame = JSON.parse(event.data);
            if (window.holdCreationLoads && (
              frame.t === 'index.patch' || frame.t === 'index.snapshot' ||
              frame.t === 'rpc.result' && window.creationLoadReplies.has(frame.id)
            )) {
              event.stopImmediatePropagation();
              window.heldCreationLoads.push(() => this.dispatchEvent(new MessageEvent('message', {data:event.data})));
            }
          });
        }
        send(data) {
          const frame = JSON.parse(data);
          if (window.holdCreationLoads && frame.t === 'rpc') {
            if (frame.method === 'question.list') window.creationLoadReplies.add(frame.id);
            if (frame.method === 'session.get' && (window.holdCreationDirectory || !window.creationGetSessions.has(frame.params.sessionID))) {
              window.creationGetSessions.add(frame.params.sessionID);
              window.creationLoadReplies.add(frame.id);
            }
          }
          super.send(data);
        }
      };
      window.releaseCreationLoads = () => {
        window.holdCreationLoads = false;
        for (const deliver of window.heldCreationLoads.splice(0)) deliver();
        window.creationLoadReplies.clear();
        window.creationGetSessions.clear();
      };
    `,
    });
    await b.reload();
    await openSession(b, seed.id);
    for (const mode of ["slash", "palette pointer", "palette keyboard"]) {
      await b.poll(
        "!!document.querySelector('.otk-project-tabs .otk-new-session:not(:disabled)')",
      );
      const before = sentFrames(b).filter(({ frame }) =>
        frame.method === "session.create"
      ).length;
      const previous = await b.evaluate<string>("location.hash");
      await b.evaluate("window.holdCreationLoads = true");
      await b.click(".otk-project-tabs .otk-new-session");
      await b.poll(
        `location.hash!==${
          JSON.stringify(previous)
        } && !!document.querySelector('.otk-prompt') && window.heldCreationLoads.length>=2`,
      );
      const pending = await b.evaluate<string>("location.hash");
      const pendingID = pending.split("/").at(-1)!;
      assertEquals(
        await b.evaluate("!!document.querySelector('.otk-project-tabs')"),
        false,
        "The new session's project presentation is still pending",
      );
      if (mode === "slash") {
        await b.fill("textarea[name=prompt]", "/new");
        await b.poll(
          "document.querySelector('.otk-autocomplete')?.textContent.includes('/new')",
        );
        await b.key("Enter");
      } else {
        await b.key("k", 2);
        await b.poll(
          "!!document.querySelector('dialog[aria-label=Commands][open]')",
        );
        await b.fill("input[name=command-search]", "New session");
        await b.poll(
          "!!document.querySelector('[data-command=\"session.new\"]:not(:disabled)')",
        );
        if (mode === "palette pointer") {
          await b.click('[data-command="session.new"]');
        } else await b.key("Enter");
      }
      await b.poll(
        `location.hash!==${
          JSON.stringify(pending)
        } && !!document.querySelector('.otk-prompt')`,
      );
      const creates = sentFrames(b).filter(({ frame }) =>
        frame.method === "session.create"
      );
      assertEquals(creates.length, before + 2, mode);
      assertEquals(
        creates.at(-1)!.frame.params,
        { directory: f.oc.directory },
        mode,
      );
      assert(
        sentFrames(b).filter(({ frame }) =>
          frame.method === "session.get" &&
          (frame.params as { sessionID?: string }).sessionID === pendingID
        ).length >= 2,
        "The command can resolve a directory independently of the held initial load",
      );
      assertEquals(
        await b.evaluate(
          "window.holdCreationLoads && window.heldCreationLoads.length>=2",
        ),
        true,
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('.otk-prompt [role=alert]')?.textContent || ''",
        ),
        "",
      );
      await b.evaluate("window.releaseCreationLoads()");
      await b.poll(
        "!!document.querySelector('.otk-project-tabs .otk-new-session:not(:disabled)')",
      );
      assertEquals(b.errors, []);
    }
    assertEquals((await f.oc.request<unknown[]>("/session")).length, 7);
    // Resolving a directory is asynchronous; a later navigation must still win.
    const before = sentFrames(b).filter(({ frame }) =>
      frame.method === "session.create"
    ).length;
    const previous = await b.evaluate<string>("location.hash");
    await b.evaluate("window.holdCreationLoads = true");
    await b.click(".otk-project-tabs .otk-new-session");
    await b.poll(
      `location.hash!==${
        JSON.stringify(previous)
      } && !!document.querySelector('.otk-prompt') && window.heldCreationLoads.length>=2`,
    );
    await b.fill("textarea[name=prompt]", "/new");
    await b.poll(
      "document.querySelector('.otk-autocomplete')?.textContent.includes('/new')",
    );
    const gets = () =>
      sentFrames(b).filter(({ frame }) => frame.method === "session.get")
        .length;
    const previousGets = gets();
    const held = await b.evaluate<number>("window.heldCreationLoads.length");
    await b.evaluate("window.holdCreationDirectory = true");
    await b.key("Enter");
    await waitFor(gets, (count) => count > previousGets);
    await b.poll(`window.heldCreationLoads.length>${held}`);
    await b.goto(`${server.url}/#/local/${seed.id}`);
    await b.poll(
      `location.hash.endsWith('/${seed.id}') && !!document.querySelector('.otk-prompt')`,
    );
    await b.type("textarea[name=prompt]", "Keep the newer session draft");
    await b.evaluate(
      "window.holdCreationDirectory = false; window.releaseCreationLoads()",
    );
    await b.poll(
      `location.hash.endsWith('/${seed.id}') && !!document.querySelector('.otk-project-tabs .otk-new-session:not(:disabled)') && document.querySelector('textarea[name=prompt]')?.value==='Keep the newer session draft'`,
    );
    assertEquals(
      sentFrames(b).filter(({ frame }) => frame.method === "session.create")
        .length,
      before + 1,
    );
    assertEquals((await f.oc.request<unknown[]>("/session")).length, 8);
    assertEquals(b.errors, []);
  } finally {
    await f.stop();
  }
});
