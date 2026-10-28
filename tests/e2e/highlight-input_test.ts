// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { AssistantMessage } from "@otk/protocol";
import { test } from "../support/resources.ts";
import { fixture } from "../support/config.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { Cdp } from "../support/cdp.ts";

test("equal code input across content replacements preserves tokens and admits no highlight work", async () => {
  const root = await fixture(), f = await coreBackendFixture(root);
  const message = (
    marker: string,
    source = "const stableValue: number = 7;",
  ): AssistantMessage => ({
    id: "reply",
    sessionID: f.session.id,
    role: "assistant",
    agent: "build",
    model: { provider: "test", model: "test" },
    time: { created: 1, completed: 2 },
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    interrupted: false,
    parts: [{
      id: "text",
      kind: "text",
      synthetic: false,
      blocks: [
        { b: "code", lang: "ts", text: source },
        { b: "paragraph", inline: [{ i: "text", text: marker }] },
      ],
    }],
  });
  f.app.backend.core.listMessages = () =>
    Promise.resolve([message("Baseline")]);
  const b = await Cdp.launch(root);
  try {
    await b.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(()=>{
      const Native=Worker;globalThis.codeWork={sent:0,received:0};
      globalThis.Worker=class extends Native{constructor(...args){super(...args);this.addEventListener('message',()=>codeWork.received++)}postMessage(...args){codeWork.sent++;return super.postMessage(...args)}};
    })()`,
    });
    await b.goto(`${f.url}/#/local/${f.session.id}`);
    await b.poll(
      "[...document.querySelectorAll('.otk-token')].some(n=>n.textContent==='stableValue')",
    );
    await b.evaluate("new Promise(resolve=>setTimeout(resolve,200))");
    const before = await b.evaluate("codeWork");
    await b.evaluate(
      "globalThis.codeNode=document.querySelector('.otk-code');globalThis.codeTokens=[...codeNode.querySelectorAll('.otk-token')]",
    );
    for (let n = 0; n < 3; n++) {
      f.app.connections.content(f.session.id, {
        op: "message.upsert",
        message: message(`Replacement ${n}`),
      });
      await b.poll(`document.body.textContent.includes('Replacement ${n}')`);
      await b.evaluate("new Promise(resolve=>setTimeout(resolve,200))");
      assertEquals(
        await b.evaluate("codeWork"),
        before,
        "Identical code values cannot admit a new capture or cache-disposal message",
      );
      assertEquals(
        await b.evaluate(
          "codeNode===document.querySelector('.otk-code')&&codeTokens.every((n,i)=>n===codeNode.querySelectorAll('.otk-token')[i])",
        ),
        true,
      );
    }
    f.app.connections.content(f.session.id, {
      op: "message.upsert",
      message: message("Changed source", "const changedValue: number = 8;"),
    });
    await b.poll(
      "[...document.querySelectorAll('.otk-token')].some(n=>n.textContent==='changedValue')",
    );
    assert(
      await b.evaluate<boolean>(
        `codeWork.sent>${(before as { sent: number }).sent}`,
      ),
    );
    assertEquals(b.errors, []);
  } finally {
    await b.close();
    await f.app.stop();
  }
});
