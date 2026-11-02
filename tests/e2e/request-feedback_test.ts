// SPDX-License-Identifier: LGPL-3.0-only
// T2 visual remainder: native durations, retry, focus and background behavior moved.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { OperationFailure } from "@otk/protocol";
import { Cdp } from "../support/cdp.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { test } from "../support/resources.ts";
import { fixture } from "../support/config.ts";
import { WsClient } from "../support/ws-client.ts";

for (const kind of ["permission", "question"] as const) {
  test(`shared ${kind} notice survives takeover, keeps one pending/error sink and focuses the visible status`, async () => {
    const root = await fixture(),
      held = Promise.withResolvers<void>(),
      sessionID = "tstv1-core";
    const reply = async () => {
      await held.promise;
      throw new OperationFailure(
        "rejected",
        "request.params",
        new Error("private SQL /secret/path"),
      );
    };
    const f = await coreBackendFixture(
      root,
      kind === "permission"
        ? {
          permissions: {
            listPermissions: () =>
              Promise.resolve([{
                id: "permission-proof",
                sessionID,
                kind: "bash",
                title: "Run the proof",
                patterns: ["echo proof"],
                alwaysPatterns: ["echo *"],
                detail: { kind: "bash", command: "echo proof" },
                time: 1,
              }]),
            replyPermission: reply,
          },
        }
        : {
          questions: {
            listQuestions: () =>
              Promise.resolve([{
                id: "question-proof",
                sessionID,
                questions: [{
                  text: "Which result?",
                  options: [{ label: "One" }],
                  custom: true,
                  multiple: false,
                }],
              }]),
            answerQuestion: reply,
          },
        },
    );
    const browser = await Cdp.launch(root), probe = new WsClient(f.url);
    try {
      await probe.connect();
      await probe.rpc("prefs.set", { key: "animationsOff", value: true });
      await browser.goto(f.url + "/#/local/" + sessionID);
      const dock = `.otk-${kind}-dock`;
      await browser.poll(`!!document.querySelector('${dock}')`);
      if (kind === "question") {
        await browser.type(
          "textarea[name=question-answer]",
          "Keep my own answer",
        );
      }
      await browser.click(
        kind === "permission"
          ? ".otk-permission-actions button"
          : ".otk-question-submit",
      );
      await browser.poll(
        "!!document.querySelector('.otk-takeover-notice .is-pending')",
      );
      for (const theme of ["otk-dark", "otk-light"]) {
        await probe.rpc("prefs.set", { key: "theme", value: theme });
        await browser.poll(
          `document.documentElement.dataset.otkTheme==='${theme}'`,
        );
        const icon = await browser.evaluate<
          { width: number; height: number; gaps: number[]; text: string }
        >(`(()=>{const row=document.querySelector('.otk-operation-feedback'),slot=row.querySelector('.otk-composer-notice-icon'),svg=slot.querySelector('svg'),s=slot.getBoundingClientRect(),r=svg.getBoundingClientRect();return {width:r.width,height:r.height,gaps:[r.left-s.left,s.right-r.right,r.top-s.top,s.bottom-r.bottom],text:slot.textContent}})()`);
        assertEquals([icon.width, icon.height], [16, 16]);
        assertEquals(icon.text, "");
        assertEquals(icon.gaps.length, 4);
        assert(Math.max(...icon.gaps) - Math.min(...icon.gaps) <= 1);
        const layout = await browser.evaluate<
          {
            emptyTracks: number;
            footer: boolean;
            inset: number;
            expectedInset: number;
          }
        >(`(()=>{const dock=document.querySelector('${dock}'),surface=dock.querySelector('.otk-surface'),body=surface.querySelector('.otk-surface-body'),content=body.querySelector('.otk-question-answers,.otk-permission-summary'),s=getComputedStyle(surface),b=getComputedStyle(body),r=surface.getBoundingClientRect();return {emptyTracks:dock.querySelectorAll('.otk-field-feedback').length,footer:!!surface.querySelector('.otk-surface-actions'),inset:r.bottom-content.getBoundingClientRect().bottom,expectedInset:parseFloat(s.borderBottomWidth)+parseFloat(s.paddingBottom)+parseFloat(b.paddingBottom)}})()`);
        assertEquals(layout.emptyTracks, 0);
        if (kind === "question") {
          assertEquals(layout.footer, false);
          assert(Math.abs(layout.inset - layout.expectedInset) <= 1);
        }
        await browser.screenshot(join(root, `${kind}-pending-${theme}.png`));
      }
      held.resolve();
      await browser.poll(
        "!!document.querySelector('.otk-takeover-notice [role=alert]')",
      );
      for (const theme of ["otk-dark", "otk-light"]) {
        await probe.rpc("prefs.set", { key: "theme", value: theme });
        await browser.poll(
          `document.documentElement.dataset.otkTheme==='${theme}'`,
        );
        await browser.screenshot(join(root, `${kind}-error-${theme}.png`));
      }
    } finally {
      held.resolve();
      await browser.close();
      await probe.close();
      await f.app.stop();
    }
  });
}

test("a forty-second task remains pending through repeat submission and socket replacement and renders one selected perf task", async () => {
  const root = await fixture(),
    f = await coreBackendFixture(root),
    held = Promise.withResolvers<void>();
  const registry = f.app.requests.options.registry,
    prepare = registry.prepare.bind(registry);
  registry.prepare = (method, params) => {
    const value = prepare(method, params);
    return method === "tasks.create"
      ? {
        ...value,
        run: async (...args) => {
          await held.promise;
          return await value.run(...args);
        },
      }
      : value;
  };
  const browser = await Cdp.launch(root), probe = new WsClient(f.url);
  try {
    await probe.connect();
    await browser.goto(f.url + "/#/local/" + f.session.id);
    await browser.poll("!!document.querySelector('.otk-task-new')");
    await browser.click(".otk-task-new");
    await browser.type("input[name=taskName]", "perf");
    await browser.click(".otk-form button[type=submit]");
    await browser.poll(
      "document.querySelector('.otk-form')?.getAttribute('aria-busy')==='true'",
    );
    const bounds: number[][] = [];
    for (const theme of ["otk-dark", "otk-light"]) {
      await probe.rpc("prefs.set", { key: "theme", value: theme });
      await browser.poll(
        `document.documentElement.dataset.otkTheme==='${theme}'`,
      );
      bounds.push(
        await browser.evaluate(
          "(()=>{const r=document.querySelector('.otk-form').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()",
        ),
      );
      await browser.screenshot(join(root, `task-pending-${theme}.png`));
    }
    assertEquals(bounds[1], bounds[0]);
  } finally {
    held.resolve();
    await browser.close();
    await probe.close();
    await f.app.stop();
  }
});
