// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assertEquals } from "@std/assert";
import { legacyAttentionScene } from "../support/legacy-attention-scene.ts";

for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
  test(`U9 r2 browser-open automatic permission stays quiet through toast OS takeover and attention consumers; reply and accessible policy reach the end (${theme})`, async () => {
    const f = await legacyAttentionScene("contract-attention-auto"), b = f.b;
    try {
      const session = await f.call("nativeRequest", {
        lease: f.lease.lease,
        path: "/session",
        method: "POST",
        body: { title: "Quiet automatic session" },
      }) as { id: string };
      await f.rpc("prefs.set", { key: "theme", value: theme });
      await f.rpc("permission.auto", { sessionID: session.id, enabled: true });
      await b.goto(`${f.url}/#/local/${session.id}`);
      await b.poll(
        `document.documentElement.dataset.otkTheme==='${theme}' && document.querySelector('.otk-auto-approve-toggle')?.getAttribute('aria-pressed')==='true'`,
      );
      await f.call("scenario", { lease: f.lease.lease, action: "hold" });
      await f.call("queueScript", {
        lease: f.lease.lease,
        chunks: [],
        tool: {
          name: "bash",
          input: {
            command: "printf quiet-auto > quiet-auto.txt; printf quiet-auto",
            description: "Quiet automatic approval",
          },
        },
      });
      await f.call("queueScript", {
        lease: f.lease.lease,
        chunks: ["Quiet automatic reply completed"],
      });
      await f.rpc("session.prompt", {
        sessionID: session.id,
        mode: "normal",
        parts: [{ kind: "text", text: "Fixed quiet automatic state" }],
      });
      await b.poll(
        "document.querySelector('.otk-auto-approving')?.textContent==='Auto-approving\u2026' && !document.querySelector('.otk-permission-dock') && document.querySelector('.otk-composer')?.hidden===false",
      );
      assertEquals(
        await b.evaluate(
          "!!document.querySelector('.otk-status-light[data-state=blocked]')",
        ),
        false,
      );
      await f.call("scenario", { lease: f.lease.lease, action: "release" });
      await b.poll(
        "[...document.querySelectorAll('[data-role=assistant] .otk-text')].some(e=>e.textContent==='Quiet automatic reply completed')",
      );
      await b.click('[data-panel-view="activity"]');
      await b.poll(
        "document.querySelector('.otk-permission-activity')?.textContent.includes('quiet-auto.txt')",
      );
    } finally {
      await f.close();
    }
  });
}
