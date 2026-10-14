// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { PermissionRequest, QuestionRequest } from "@otk/protocol";
import { fixture } from "../support/config.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { Cdp } from "../support/cdp.ts";
import { openSession, sentFrames } from "../support/browser-fixture.ts";

Deno.test("core-only welcome loads a session without optional RPCs and preserves a draft while unavailable prompt features stay inactive", async () => {
  const root = await fixture();
  const { app, session, url } = await coreBackendFixture(root);
  let browser: Cdp | undefined;
  try {
    browser = await Cdp.launch(root);
    await browser.goto(url);
    await openSession(browser, session.id);
    await browser.poll(
      "document.querySelector('.otk-messages')?.textContent.includes('Core transcript')",
    );
    await browser.type("textarea[name=prompt]", "Keep my draft");
    await browser.poll(
      "document.querySelector('.otk-prompt button[type=submit]').disabled",
    );
    await browser.key("Enter");
    await browser.key("Escape");
    await browser.key("Escape");
    assertEquals(
      await browser.evaluate(
        "document.querySelector('textarea[name=prompt]').value",
      ),
      "Keep my draft",
    );
    await browser.fill("textarea[name=prompt]", "");
    await browser.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "!",
      code: "Digit1",
      text: "!",
      modifiers: 8,
      windowsVirtualKeyCode: 49,
    });
    await browser.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "!",
      code: "Digit1",
      modifiers: 8,
      windowsVirtualKeyCode: 49,
    });
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value === '!'",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('.otk-prompt label').textContent",
      ),
      "Prompt",
    );
    assertEquals(
      sentFrames(browser).flatMap(({ frame }) =>
        frame.t === "rpc" ? [frame.method] : []
      ).filter((method) =>
        !["session.get", "session.messages", "prefs.get", "frecency.list"]
          .includes(String(method))
      ),
      [],
    );
    assertEquals(browser.errors, []);
    console.info("Capability consumer evidence:", root);
  } finally {
    await browser?.close();
    await app.stop();
  }
});

Deno.test("transport reconnecting retains advertised features and unsent permission/question input", async () => {
  const root = await fixture();
  const permission: PermissionRequest = {
    id: "permission",
    sessionID: "core",
    kind: "bash",
    title: "Run probe",
    patterns: ["probe"],
    alwaysPatterns: ["*"],
    detail: { kind: "bash", command: "probe" },
    time: 1,
  };
  const question: QuestionRequest = {
    id: "question",
    sessionID: "core",
    questions: [{
      text: "Keep an unsent answer",
      options: [],
      multiple: false,
      custom: true,
    }],
  };
  const { app, session, url } = await coreBackendFixture(root, {
    permissions: {
      listPermissions: () => Promise.resolve([permission]),
      replyPermission: () => Promise.resolve(),
    },
    questions: {
      listQuestions: () => Promise.resolve([question]),
      answerQuestion: () => Promise.resolve(),
    },
  });
  let browser: Cdp | undefined, stopped = false;
  try {
    browser = await Cdp.launch(root);
    await browser.goto(url);
    await openSession(browser, session.id);
    await browser.click(".otk-permission-actions button:nth-child(3)");
    await browser.type("textarea[name=rejection]", "Keep permission feedback");
    await browser.click(".otk-question-options button:last-child");
    await browser.type(
      "textarea[name=question-answer]",
      "Keep question answer",
    );
    await app.stop();
    stopped = true;
    await browser.poll(
      "document.querySelector('.otk-sidebar')?.textContent.includes('reconnecting')",
    );
    assertEquals(
      await browser.evaluate(`({
      permission: document.querySelector('textarea[name=rejection]')?.value,
      question: document.querySelector('textarea[name=question-answer]')?.value,
    })`),
      {
        permission: "Keep permission feedback",
        question: "Keep question answer",
      },
    );
    assertEquals(browser.errors, []);
  } finally {
    if (browser) {
      await Deno.writeTextFile(
        join(root, "capability-reconnect.html"),
        await browser.evaluate<string>("document.documentElement.outerHTML"),
      );
      await Deno.writeTextFile(
        join(root, "capability-reconnect-frames.json"),
        JSON.stringify(
          browser.events.filter((event) =>
            event.method.startsWith("Network.webSocket")
          ),
          null,
          2,
        ),
      );
      await browser.close();
    }
    if (!stopped) await app.stop();
    console.info("Capability reconnect evidence:", root);
  }
});
