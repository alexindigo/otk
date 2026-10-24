// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { test } from "../support/resources.ts";
import { fixture } from "../support/config.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { Cdp } from "../support/cdp.ts";
import { WsClient } from "../support/ws-client.ts";
import { waitFor } from "../support/opencode.ts";
import type { PermissionReply, PromptInput } from "@otk/protocol";

test("command hints follow mounted hidden bindings, saved overrides, unbinding and reset", async () => {
  const root = await fixture(), sends: PromptInput[] = [];
  let aborts = 0;
  const f = await coreBackendFixture(root, {
    prompt: {
      prompt: (input) => {
        sends.push(input);
        return Promise.resolve();
      },
      abort: () => {
        aborts++;
        return Promise.resolve();
      },
    },
  });
  const b = await Cdp.launch(root), c = new WsClient(f.url);
  const button = ".otk-prompt button[type=submit]";
  const defaultTitle =
    "Send (Enter); Shift+Enter for newline; Esc twice to interrupt";
  const reboundTitle =
    "Send (Ctrl+Enter); Alt+Enter for newline; Ctrl+q twice to interrupt";
  const title = () =>
    b.evaluate<string>(`document.querySelector('${button}').title`);
  try {
    await c.connect();
    await b.goto(`${f.url}/#/local/core`);
    await b.poll("!!document.querySelector('.otk-prompt textarea')");
    await b.click(".otk-keys-entry");
    await b.poll(
      "document.querySelector('[data-binding=\"prompt.submit\"] kbd')?.textContent==='Enter'",
    );
    assertEquals(await title(), defaultTitle);
    await b.key("Escape");
    await c.rpc("prefs.set", {
      key: "keymap",
      value: {
        "prompt.submit": "Ctrl+Enter",
        "prompt.newline": "Alt+Enter",
        "session.interrupt": "Ctrl+q",
        "palette.open": "Ctrl+j",
      },
    });
    // Observe authoritative delivery before judging the dependent hint.
    await b.click(".otk-keys-entry");
    await b.poll(
      "document.querySelector('[data-binding=\"prompt.submit\"] kbd')?.textContent==='Ctrl+Enter'",
    );
    assertEquals(await title(), reboundTitle);
    assertEquals(
      await b.evaluate(
        "document.querySelector('.otk-sidebar-commands button:first-child').title",
      ),
      "Search commands (Ctrl+j)",
    );
    await b.key("Escape");
    await b.reload();
    await b.poll("!!document.querySelector('.otk-prompt textarea')");
    await b.click(".otk-keys-entry");
    await b.poll(
      "document.querySelector('[data-binding=\"prompt.submit\"] kbd')?.textContent==='Ctrl+Enter'",
    );
    assertEquals(await title(), reboundTitle);
    await b.key("Escape");
    await b.fill("textarea[name=prompt]", "First line");
    await b.key("Enter", 1);
    await b.poll(
      "document.querySelector('textarea[name=prompt]').value.endsWith('\\n')",
    );
    assertEquals(sends.length, 0);
    await b.key("Enter", 2);
    await b.poll("document.querySelector('textarea[name=prompt]').value===''");
    assertEquals(sends.length, 1);
    assertEquals(sends[0].parts, [{ kind: "text", text: "First line\n" }]);
    f.app.index.upsert({ ...f.app.index.get("core")!, status: "busy" });
    await b.poll(
      "document.querySelector('[data-session=core]')?.dataset.status==='busy'",
    );
    await b.key("q", 2);
    await b.poll(
      `document.querySelector('${button}').title==='Ctrl+q again to interrupt'`,
    );
    assertEquals(aborts, 0);
    await b.key("q", 2);
    await b.poll(
      `document.querySelector('${button}').title===${
        JSON.stringify(reboundTitle)
      }`,
    );
    await waitFor(() => Promise.resolve(aborts), (count) => count === 1);
    assertEquals(aborts, 1);
    await c.rpc("prefs.set", {
      key: "keymap",
      value: {
        "prompt.submit": "",
        "prompt.newline": "",
        "session.interrupt": "",
      },
    });
    await b.click(".otk-keys-entry");
    await b.poll(
      "document.querySelector('[data-binding=\"prompt.submit\"] kbd')?.textContent==='Unbound'",
    );
    assertEquals(await title(), "Send");
    await b.key("Escape");
    await c.rpc("prefs.set", { key: "keymap", value: {} });
    await b.click(".otk-keys-entry");
    await b.poll(
      "document.querySelector('[data-binding=\"prompt.submit\"] kbd')?.textContent==='Enter'",
    );
    assertEquals(await title(), defaultTitle);
    await b.key("Escape");
    assertEquals(b.errors, []);
  } finally {
    await b.close();
    await c.close();
    await f.app.stop();
  }
});

test("Dialog and Editor omit surface key hints while retaining save, cancel and native focus return", async () => {
  const workspace = await fixture(), root = join(workspace, "key-hints");
  await Deno.mkdir(root);
  const f = await coreBackendFixture(root, {
    prompt: { prompt: () => Promise.resolve(), abort: () => Promise.resolve() },
  });
  const b = await Cdp.launch(workspace), c = new WsClient(f.url);
  const failures: unknown[] = [], shots = Deno.env.get("OTK_KEY_HINT_SHOTS");
  const capture = async (name: string) => {
    if (!shots) return;
    await Deno.mkdir(shots, { recursive: true });
    await b.evaluate(
      "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
    );
    await b.screenshot(join(shots, `${name}.png`));
    await b.evaluate(
      "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
    );
    await b.screenshot(join(shots, `${name}-stable.png`));
  };
  try {
    await c.connect();
    await c.rpc("prefs.set", { key: "animationsOff", value: true });
    await b.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await b.goto(`${f.url}/#/local/core`);
    await b.poll("!!document.querySelector('.otk-prompt textarea')");
    for (const theme of ["otk-dark", "otk-light"]) {
      await c.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await b.fill("textarea[name=prompt]", "Keep this prompt");
      await b.click('[aria-label="Edit prompt"]');
      await b.poll(
        "!!document.querySelector('dialog[open] .otk-editor textarea')",
      );
      await capture(`${theme}-editor`);
      try {
        assertEquals(
          await b.evaluate(
            "document.querySelector('dialog[open] .otk-surface-title button').textContent.trim()",
          ),
          "Close",
        );
      } catch (error) {
        failures.push(error);
      }
      try {
        assertEquals(
          await b.evaluate(
            "document.querySelector('.otk-editor p').textContent",
          ),
          "Save to keep changes",
        );
      } catch (error) {
        failures.push(error);
      }
      await b.fill("textarea[name=editor]", "Saved prompt");
      await b.click(".otk-editor footer button:last-child");
      await b.poll(
        "!document.querySelector('dialog[open]') && document.querySelector('textarea[name=prompt]').value==='Saved prompt' && document.activeElement===document.querySelector('[aria-label=\"Edit prompt\"]')",
      );
      await b.click(".otk-keys-entry");
      await b.poll(
        "!!document.querySelector('[data-binding=\"session.interrupt\"]')",
      );
      await capture(`${theme}-keys`);
      await b.key("Escape");
      await b.poll("!document.querySelector('dialog[open]')");
      await b.click('[aria-label="Edit prompt"]');
      await b.fill("textarea[name=editor]", "Cancel this edit");
      await b.key("Escape");
      await b.poll(
        "!document.querySelector('dialog[open]') && document.querySelector('textarea[name=prompt]').value==='Saved prompt' && document.activeElement===document.querySelector('[aria-label=\"Edit prompt\"]')",
      );
    }
    assertEquals(b.errors, []);
    if (failures.length) {
      throw new AggregateError(failures, "Static surface key hints remain");
    }
  } finally {
    await b.close();
    await c.close();
    await f.app.stop();
  }
});

test("fixed permission keys and question Escape hints match their focused widget behavior", async () => {
  const failures: unknown[] = [];
  for (const kind of ["permission", "question"]) {
    const root = await fixture(),
      replies: PermissionReply[] = [],
      answers: unknown[] = [];
    const f = await coreBackendFixture(
      root,
      kind === "permission"
        ? {
          permissions: {
            listPermissions: () =>
              Promise.resolve([{
                id: "permission",
                sessionID: "core",
                kind: "bash",
                title: "Probe",
                time: 1,
                detail: { kind: "bash", command: "true" },
                patterns: ["true"],
                alwaysPatterns: ["true"],
              }]),
            replyPermission: (input) => {
              replies.push(input);
              return Promise.resolve();
            },
          },
        }
        : {
          questions: {
            listQuestions: () =>
              Promise.resolve([{
                id: "question",
                sessionID: "core",
                questions: [{
                  header: "Choice",
                  text: "Choose one",
                  multiple: false,
                  custom: true,
                  options: [{ label: "Option", description: "A choice" }],
                }],
              }]),
            answerQuestion: (_id, value) => {
              answers.push(value);
              return Promise.resolve();
            },
          },
        },
    );
    const b = await Cdp.launch(root);
    try {
      await b.goto(`${f.url}/#/local/core`);
      if (kind === "permission") {
        await b.poll("!!document.querySelector('.otk-permission-actions')");
        assertEquals(
          await b.evaluate(
            "[...document.querySelectorAll('.otk-permission-actions button')].map(b=>b.title)",
          ),
          [
            "Allow once (1 when focused)",
            "Review future grant (2 when focused)",
            "Reject (3 when focused)",
          ],
        );
        await b.click(".otk-permission-actions input");
        await b.key("1");
        await b.evaluate(
          "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
        );
        assertEquals(replies, []);
        await b.evaluate(
          "document.querySelector('.otk-permission-actions button:nth-child(2)').focus()",
        );
        await b.key("2");
        await b.poll("!!document.querySelector('.otk-permission-confirm')");
        await b.key("Escape");
        await b.poll("!document.querySelector('.otk-permission-confirm')");
        await b.key("3");
        await b.poll("!!document.querySelector('.otk-permission-reject')");
        await b.key("Escape");
        await b.poll("!document.querySelector('.otk-permission-reject')");
        await b.key("1");
        await waitFor(
          () => Promise.resolve(replies.length),
          (count) => count === 1,
        );
        assertEquals(replies.map((r) => r.reply), ["once"]);
      } else {
        await b.poll("!!document.querySelector('.otk-question-actions')");
        try {
          assertEquals(
            await b.evaluate(
              "document.querySelector('.otk-question-actions button:nth-child(2)').title",
            ),
            "Skip question (Esc with question controls focused)",
          );
        } catch (error) {
          failures.push(error);
        }
        await b.fill("textarea[name=question-answer]", "Keep my answer");
        await b.key("Escape");
        await b.poll(
          "document.activeElement===document.querySelector('.otk-question-actions .otk-primary')",
        );
        assertEquals(answers.length, 0);
        assertEquals(
          await b.evaluate(
            "document.querySelector('textarea[name=question-answer]').value",
          ),
          "Keep my answer",
        );
        await b.key("Escape");
        await waitFor(
          () => Promise.resolve(answers.length),
          (count) => count === 1,
        );
        assertEquals(answers, [undefined]);
      }
      assertEquals(b.errors, []);
    } finally {
      await b.close();
      await f.app.stop();
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, "Widget hints omit their focus scope");
  }
});
