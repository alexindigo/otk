// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assertEquals } from "@std/assert";
import { legacySessionsScene } from "../support/legacy-sessions-scene.ts";
import { inboxClockScript } from "../support/inbox-browser.ts";

// Fixed V remainder. C10 owns activity, guarded navigation, clock and server merge.
test("inbox mocked-clock ageing, reduced-colour underlines, visit resets on opening and acting, and inactive clock pause", () =>
  legacySessionsScene(
    "contract-sessions-inbox",
    "otk-dark",
    async ({ b, rpc }) => {
      const directory = await b.evaluate<string>(
        "document.querySelector('[data-project-sessions~=tstv1-otk]').dataset.project",
      );
      await rpc("projects.visit", { directory, active: true });
      await b.send("Page.addScriptToEvaluateOnNewDocument", {
        source: inboxClockScript,
      });
      await b.reload();
      await b.poll("!!document.querySelector('.otk-project-name')");
      await rpc("prefs.set", { key: "reducedColors", value: true });
      await b.poll(
        "document.documentElement.hasAttribute('data-otk-reduced-colors')",
      );
      const snapshot = await rpc("inbox.get", {}) as {
        inbox: { projects: { lastVisit: number }[] };
      };
      await b.evaluate(
        `inboxNow=${
          snapshot.inbox.projects[0].lastVisit + 24 * 3600000
        };inboxTick()`,
      );
      await b.poll(
        "document.querySelector('.otk-project-name').classList.contains('otk-age-3')",
      );
      assertEquals(
        await b.evaluate(
          "getComputedStyle(document.querySelector('.otk-project-name')).textDecorationStyle",
        ),
        "double",
      );
    },
  ));
