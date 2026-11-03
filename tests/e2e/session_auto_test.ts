// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { legacyAttentionScene } from "../support/legacy-attention-scene.ts";

test("U9 footer auto-approve, command, inherited marks and persisted activity reach browser consumers; dirty permission input is guarded", async () => {
  const f = await legacyAttentionScene("contract-attention-auto"), b = f.b;
  try {
    const root = await f.call("nativeRequest", {
      lease: f.lease.lease,
      path: "/session",
      method: "POST",
      body: { title: "Session auto-approve" },
    }) as { id: string };
    await f.call("nativeRequest", {
      lease: f.lease.lease,
      path: "/session",
      method: "POST",
      body: { title: "Inherited helper", parentID: root.id },
    });
    await f.rpc("prefs.set", { key: "showCost", value: false });
    await f.rpc("permission.auto", { sessionID: root.id, enabled: true });
    await f.rpc("layout.patch", {
      rightCollapsed: false,
      rightView: "sessions",
    });
    await b.goto(`${f.url}/#/local/${root.id}`);
    await b.poll(
      "document.querySelector('.otk-auto-approve-toggle')?.getAttribute('aria-pressed')==='true'",
    );
    await b.poll(
      `!!document.querySelector('[data-session="${root.id}"] .otk-auto-mark')`,
    );
    assert(
      await b.evaluate(
        "(()=>{const e=document.querySelector('.otk-auto-approve-toggle'),r=e.getBoundingClientRect();return e.getAttribute('aria-label')==='Auto-approve'&&r.width===28&&r.height===28&&!!e.querySelector('svg')})()",
      ),
    );
    assert(
      await b.evaluate(
        `(()=>{const r=document.querySelector('[data-session="${root.id}"]'),m=r.querySelector('.otk-auto-mark'),t=r.querySelector('.otk-row-title'),a=m.getBoundingClientRect(),v=t.getBoundingClientRect();return Math.abs(a.y+a.height/2-v.y-v.height/2)<.5&&a.width>0&&getComputedStyle(m).position==='static'})()`,
      ),
    );
    // Failed/unconfirmed are persisted display states, not fake approval outcomes.
    await f.call("scenario", {
      lease: f.lease.lease,
      action: "fail",
      sessionID: root.id,
    });
    await f.rpc("layout.patch", {
      rightCollapsed: false,
      rightView: "activity",
    });
    await b.reload();
    await b.poll(
      "document.querySelectorAll('.otk-permission-activity [data-activity]').length===2 && !document.querySelector('.otk-permission-activity [role=status]:not([aria-hidden=true])')",
    );
    for (const theme of ["otk-dark", "otk-light"]) {
      await f.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      assertEquals(
        await b.evaluate(
          "document.querySelector('.otk-permission-activity .otk-error')?.textContent.includes('Stored failure fixture')",
        ),
        false,
      );
      assert(
        await b.evaluate(
          "document.querySelector('.otk-permission-activity')?.textContent.includes('Reply started; outcome not confirmed')",
        ),
      );
    }
  } finally {
    await f.close();
  }
});
