// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { fixture } from "../support/config.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { Cdp } from "../support/cdp.ts";
import { openSession } from "../support/browser-fixture.ts";
import { focusNotifications } from "../support/notification-browser.ts";
import { test } from "../support/resources.ts";

test("a consumed digest preserves the real toast action and favicon count; tombstoning retracts them", async () => {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    b = await Cdp.launch(root);
  const selected = f.entries[0],
    background = {
      ...selected,
      id: "tstv1-digest-note",
      title: "Digest notification target",
    };
  f.add(background);
  const row = `[data-session="${background.id}"]`,
    toast = `.otk-toast[data-note="local/${background.id}"]`;
  const badge = () =>
    b.evaluate<{ dot: boolean; count: number }>(
      `(()=>{const icon=document.querySelector('link[rel=icon]'),svg=new DOMParser().parseFromString(decodeURIComponent(icon.href.split(',')[1]),'image/svg+xml'),dot=!!svg.querySelector('circle');return {dot,count:dot?Number(svg.querySelector('text:last-child').textContent):0}})()`,
    );
  let revision = 0;
  const digest = (deleted: { at: number; how: "provider" } | null) => {
    const next = ++revision;
    f.app.index.applyDigest({
      id: background.id,
      revision: next,
      summary: {
        state: "ready",
        revision: next,
        messageCount: 1,
        total: {
          calls: 1,
          cost: .75,
          tokens: {
            input: 9,
            output: 1,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          contextPeak: 9,
        },
      },
      turns: { upsert: {}, remove: [] },
      deleted,
    });
  };
  const finish = async () => {
    f.update(background.id, { status: "busy" });
    await b.poll(`document.querySelector('${row}')?.dataset.status==='busy'`);
    f.update(background.id, { status: "idle" });
    await b.poll(
      `!!document.querySelector('${toast} .otk-toast-actions button') && document.querySelector('link[rel=icon]')?.title==='1 session needs attention'`,
    );
  };
  try {
    await b.goto(f.url);
    await focusNotifications(b);
    await openSession(b, selected.id);
    await finish();
    assertEquals(await badge(), { dot: true, count: 1 });
    digest(null);
    // Observe the downstream row amount before judging the notification delivery.
    await b.poll(
      `document.querySelector('${row} .otk-session-cost')?.textContent==='$0.75'`,
    );
    assertEquals(await badge(), { dot: true, count: 1 });
    await b.click(`${toast} .otk-toast-actions button`);
    await b.poll(
      `location.hash.endsWith('/${background.id}') && !document.querySelector('${toast}') && document.querySelector('link[rel=icon]')?.title==='OTK'`,
    );
    await openSession(b, selected.id);
    await finish();
    digest({ at: 3, how: "provider" });
    await b.poll(
      `document.querySelector('${row}')?.classList.contains('is-deleted') && !document.querySelector('${toast}') && document.querySelector('link[rel=icon]')?.title==='OTK'`,
    );
    assertEquals(await badge(), { dot: false, count: 0 });
    assertEquals(b.errors, []);
  } finally {
    await b.close();
    await f.app.stop();
  }
});
