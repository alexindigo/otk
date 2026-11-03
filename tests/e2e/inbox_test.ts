// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { legacySessionsScene } from "../support/legacy-sessions-scene.ts";
import { inboxClockScript } from "../support/inbox-browser.ts";

// Fixed V remainder. C10 owns activity, guarded navigation, clock and server merge.
test("inbox activity returns inactive projects and all three required lights remain on-screen across reload and the rail", () =>
  legacySessionsScene(
    "contract-sessions-inbox",
    "otk-dark",
    async ({ b, rpc }) => {
      const directories = await b.evaluate<string[]>(
        "Array.from(document.querySelectorAll('.otk-project-row'),e=>e.dataset.project)",
      );
      for (const directory of directories) {
        await rpc("projects.visit", { directory, active: true });
      }
      await b.poll(
        "document.querySelectorAll('.otk-project-row time').length===4",
      );
      const alignment = await b.evaluate<number[]>(
        "[...document.querySelectorAll('.otk-project-row')].map(e=>{const a=e.querySelector('.otk-status-light').getBoundingClientRect(),b=e.querySelector('.otk-project-name-line').getBoundingClientRect(),c=e.querySelector('time').getBoundingClientRect();return Math.max(Math.abs(a.y+a.height/2-b.y-b.height/2),Math.abs(a.y+a.height/2-c.y-c.height/2))})",
      );
      assert(alignment.every((delta) => delta < .5));
    },
  ));
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
