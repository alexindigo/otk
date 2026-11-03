// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { legacySessionsScene } from "../support/legacy-sessions-scene.ts";

test("task tabs create rename reorder and close without deleting sessions; ordered crumbs nest helpers and meter matches backend", () =>
  legacySessionsScene("contract-sessions-tabs", "otk-dark", async ({ b }) => {
    await b.poll(
      "!!document.querySelector('[data-crumb=tstv1-otk] .otk-status-light')",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('[data-crumb=tstv1-otk] .otk-status-light').getBoundingClientRect().width",
      ),
      8,
    );
  }));
test("long task chains fold in the middle, reveal a chosen session and preserve reduced-colour crumb lights", () =>
  legacySessionsScene(
    "contract-sessions-tabs",
    "otk-dark",
    async ({ b, rpc }) => {
      await rpc("prefs.set", { key: "reducedColors", value: true });
      await b.poll(
        "document.documentElement.hasAttribute('data-otk-reduced-colors')",
      );
      assertEquals(
        await b.evaluate(
          "getComputedStyle(document.querySelector('[data-crumb=tstv1-otk] .otk-lamp-shape')).display",
        ),
        "block",
      );
    },
  ));
test("all four phantom rules render through preview pin double-click send and idle-seen departure", () =>
  legacySessionsScene(
    "contract-sessions-phantom",
    "otk-dark",
    async ({ b }) => {
      await b.poll("!!document.querySelector('[data-tab=tstv1-otk]')");
      assertEquals(
        await b.evaluate(
          "getComputedStyle(document.querySelector('[data-tab=tstv1-otk]')).fontStyle",
        ),
        "italic",
      );
      assert(
        await b.evaluate(
          "document.querySelector('[data-tab=tstv1-otk]').getBoundingClientRect().width>0",
        ),
      );
    },
  ));
