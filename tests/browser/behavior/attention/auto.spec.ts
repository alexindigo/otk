// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { notificationTest as hiddenTest } from "../../fixtures/notifications.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import {
  file,
  prompt,
  reply,
  scenario,
  seed,
  tool,
} from "../../pages/attention.ts";
import {
  hideNotifications,
  instrumentNotifications,
  notes,
} from "../../pages/notifications.ts";

test.use({ profile: "contract-attention-auto" });
hiddenTest(
  "attention.automatic-held-permission-is-quiet-and-real-reply-updates-only-own-family",
  { tag: ["@attention", "@isolated"] },
  async ({ isolatedState: state, page, notificationPages }) => {
    const root = await seed(state, "Quiet automatic session"),
      other = await seed(state, "Manual observer");
    const observer = await notificationPages.open();
    await instrumentNotifications(observer);
    await observer.context().grantPermissions(["notifications"], {
      origin: state.url,
    });
    const a = await wire(page), b = await wire(observer);
    await openSession(state, page, root.id);
    await openSession(state, observer, other.id);
    await state.product("prefs.set", { key: "notify.os", value: true });
    await page.locator(".otk-auto-approve-toggle").click();
    await expect(page.locator(".otk-auto-approve-toggle")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(observer.locator(".otk-auto-mark")).toHaveCount(0);
    const ax = async () => {
      await expect(
        page.getByRole("tab", { name: "Quiet automatic session", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("navigation", { name: "Task sessions" }).getByRole(
          "button",
          {
            name: "Quiet automatic session",
            exact: true,
          },
        ),
      ).toBeVisible();
    };
    await ax();
    for (const target of [page, observer]) {
      await target.evaluate(`(() => {
    globalThis.autoAttentionEvidence=[];
    const inspect=()=>{for(const e of document.querySelectorAll('.otk-permission-dock,.otk-toast,.otk-status-light[data-state=blocked]'))if(e.matches('.otk-permission-dock,.otk-status-light[data-state=blocked]')||e.textContent.includes('Permission needed'))autoAttentionEvidence.push(e.textContent)};
    new MutationObserver(inspect).observe(document.body,{subtree:true,childList:true,characterData:true});inspect();
  })()`);
    }
    const restore = await hideNotifications(observer);
    await scenario(state, "hold");
    await tool(state, "bash", {
      command: "printf quiet-auto > quiet-auto.txt; printf quiet-auto",
      description: "Quiet automatic approval",
    });
    await state.queue(["Quiet automatic reply completed"]);
    await prompt(page, "Run quiet automatic command");
    await expect.poll(async () =>
      (await state.observe<{ replying: boolean }>()).replying
    ).toBe(true);
    await expect(page.locator(".otk-auto-approving")).toHaveText(
      "Auto-approving\u2026",
    );
    await expect(page.locator(".otk-permission-dock")).toHaveCount(0);
    await expect(page.locator(".otk-composer")).toBeVisible();
    await expect(page.locator(".otk-status-light[data-state=blocked]"))
      .toHaveCount(0);
    await scenario(state, "release");
    await reply(page, root.id, "Quiet automatic reply completed");
    await file(state, "quiet-auto.txt", "quiet-auto");
    for (const target of [page, observer]) {
      expect(await target.evaluate("autoAttentionEvidence")).toEqual([]);
    }
    for (const frames of [a, b]) {
      expect(
        frames.sent.filter(({ frame }) => frame.method === "permission.reply"),
      ).toEqual([]);
    }
    expect(
      await notes(
        observer,
        "notes.filter(n=>n.title==='Permission needed').length",
      ),
    ).toBe(0);
    const history = await state.product("permission.activity", {
      sessionID: root.id,
    });
    expect(history.entries.map((r) => [r.source, r.outcome])).toEqual([[
      "auto",
      "confirmed",
    ]]);
    await ax();
    await page.locator('[data-panel-view="activity"]').click();
    const activity = page.locator(".otk-permission-activity");
    await expect(activity).toContainText("quiet-auto.txt");
    await expect(activity.locator("[role=status]:not([aria-hidden=true])"))
      .toHaveCount(0);
    const reads = () =>
      a.sent.filter(({ frame }) => frame.method === "permission.activity")
        .length;
    const before = reads();
    await state.product("permission.auto", {
      sessionID: other.id,
      enabled: true,
    });
    await expect(observer.locator(".otk-auto-approve-toggle")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(reads()).toBe(before);
    await tool(state, "bash", {
      command: "printf other-auto > other-auto.txt",
      description: "Unrelated activity",
    });
    await state.queue(["Other complete"]);
    await state.product("session.prompt", {
      sessionID: other.id,
      mode: "normal",
      parts: [{ kind: "text", text: "Run unrelated automatic command" }],
    });
    await file(state, "other-auto.txt", "other-auto");
    await expect.poll(async () =>
      !(await state.native<Record<string, unknown>>("/session/status"))[
        other.nativeID
      ]
    ).toBe(true);
    const otherHistory = await state.product("permission.activity", {
      sessionID: other.id,
    });
    expect(otherHistory.entries[0].outcome).toBe("confirmed");
    expect(reads()).toBe(before);
    await restore();
  },
);
test(
  "attention.auto-policy-broadcast-inheritance-reload-dirty-guard-offline-disable-and-journal",
  { tag: ["@attention", "@isolated"] },
  async ({ isolatedState: state, page, browser }) => {
    test.setTimeout(120_000);
    const root = await seed(state, "Session auto-approve"),
      child = await seed(state, "Inherited helper", root.id),
      other = await seed(state, "Manual session");
    const second = await (await state.newContext(browser)).newPage();
    const frames = await wire(page);
    await state.product("prefs.set", { key: "showCost", value: false });
    await openSession(state, page, root.id);
    await openSession(state, second, root.id);
    const toggle = page.locator(".otk-auto-approve-toggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(second.locator(".otk-auto-approve-toggle")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    for (const id of [root.id, child.id]) {
      await expect(page.locator(`[data-session="${id}"] .otk-auto-mark`))
        .toHaveCount(0);
    }
    await expect(page.locator(`[data-tab="${root.id}"] .otk-auto-mark`))
      .toHaveCount(0);
    await expect(page.locator(`[data-session="${other.id}"] .otk-auto-mark`))
      .toHaveCount(0);
    await openSession(state, second, other.id);
    await expect(second.locator(".otk-auto-approve-toggle")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await tool(state, "bash", {
      command: "printf browser-auto > browser-auto.txt; printf browser-auto",
      description: "Browser auto reply",
    });
    await state.queue(["Automatic browser reply finished"]);
    await prompt(page, "Run the automatically approved command");
    await reply(page, root.id, "Automatic browser reply finished");
    await file(state, "browser-auto.txt", "browser-auto");
    await page.locator('[data-panel-view="activity"]').click();
    const activity = page.locator(".otk-permission-activity"),
      rows = activity.locator("[data-activity]");
    await expect(activity).toContainText("browser-auto.txt");
    await expect(activity).toContainText("Allowed");
    await expect(activity).toContainText("Auto");
    await expect(activity.locator("[role=status]:not([aria-hidden=true])"))
      .toHaveCount(0);
    expect(
      frames.sent.filter(({ frame }) => frame.method === "permission.activity"),
    ).toHaveLength(1);
    await expect(page.locator(`[data-crumb="${child.id}"]`)).toHaveCount(0);
    await page.locator('[data-panel-view="sessions"]').click();
    await page.locator(`[data-session="${child.id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${child.id}$`));
    await page.locator('[data-panel-view="activity"]').click();
    await expect(activity).toContainText(
      "Permission replies will appear here.",
    );
    await expect(rows).toHaveCount(0);
    await expect(page.locator(".otk-subagent-bar")).toBeVisible();
    await expect(page.getByRole("region", { name: "Transcript", exact: true }))
      .toHaveAttribute("aria-busy", "false");
    await page.locator(`[data-crumb="${root.id}"]`).click();
    await expect(activity).toContainText("browser-auto.txt");
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(activity).toContainText("browser-auto.txt");
    await page.keyboard.press("Control+Shift+A");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(
      frames.sent.some(({ frame }) =>
        frame.method === "permission.auto" && frame.params?.enabled === false
      ),
    ).toBe(true);
    await tool(state, "bash", {
      command: "printf guarded-auto > guarded-auto.txt; printf guarded-auto",
      description: "Guard unsaved permission work",
    });
    await state.queue(["Guarded auto reply finished"]);
    await prompt(page, "Wait for manual input first");
    const dirty = page.locator(".otk-rejection-reason");
    await dirty.fill("Keep my unsaved permission feedback");
    const palette = async () => {
      await page.keyboard.press("Control+k");
      await page.locator("input[name=command-search]").fill(
        "Toggle session auto-approve",
      );
      await expect(page.locator('[data-command="permission.auto"]'))
        .toBeVisible();
    };
    await palette();
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.locator('[data-command="permission.auto"]').click();
    await expect(page.locator("dialog")).toHaveCount(0);
    await expect(dirty).toHaveValue("Keep my unsaved permission feedback");
    await file(state, "guarded-auto.txt", null);
    await palette();
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator('[data-command="permission.auto"]').click();
    await expect(page.locator("dialog")).toHaveCount(0);
    await expect(page.locator(".otk-permission-dock")).toHaveCount(0);
    await file(state, "guarded-auto.txt", "guarded-auto");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(rows).toHaveCount(2);
    await expect(page.locator("[data-role=assistant] .otk-text").last())
      .toHaveText("Guarded auto reply finished");
    await expect.poll(async () =>
      !(await state.native<Record<string, unknown>>("/session/status"))[
        root.nativeID
      ]
    ).toBe(true);
    await expect(activity.locator("[role=status]:not([aria-hidden=true])"))
      .toHaveCount(0);
    const disconnectedAt = frames.received.length;
    await scenario(state, "freeze");
    await expect.poll(
      () =>
        frames.received.slice(disconnectedAt).some((f) =>
          f.t === "harness" && f.state !== "connected"
        ),
      { timeout: 60_000 },
    ).toBe(true);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(rows).toHaveCount(2);
    await expect(
      activity.locator("[role=alert],[role=status]:not([aria-hidden=true])"),
    ).toHaveCount(0);
    const connectedAt = frames.received.length;
    await scenario(state, "thaw");
    await expect.poll(
      () =>
        frames.received.slice(connectedAt).some((f) =>
          f.t === "harness" && f.state === "connected"
        ),
      { timeout: 60_000 },
    ).toBe(true);
    await tool(state, "bash", {
      command: "printf manual-ui > manual-ui.txt; printf manual-ui",
      description: "Manual activity proof",
    });
    await state.queue(["Manual browser reply finished"]);
    await prompt(page, "Record a manual reply in the same activity view");
    await expect(page.locator(".otk-permission-dock .otk-permission-command"))
      .toContainText(
        "manual-ui",
      );
    await page.locator(".otk-permission-actions .otk-primary").click();
    await file(state, "manual-ui.txt", "manual-ui");
    await expect(page.locator("[data-role=assistant] .otk-text").last())
      .toHaveText("Manual browser reply finished");
    await expect.poll(async () =>
      !(await state.native<Record<string, unknown>>("/session/status"))[
        root.nativeID
      ]
    ).toBe(true);
    await expect(rows).toHaveCount(3);
    await expect(activity).toContainText("Manual");
    await scenario(state, "fail", root.nativeID);
    await page.reload();
    await expect(rows).toHaveCount(5);
    await expect(activity.locator(".otk-error")).toContainText(
      "The response could not be sent. Review this request before trying again",
    );
    await expect(activity.locator(".otk-error")).not.toContainText(
      "Stored failure fixture",
    );
    await expect(activity).toContainText(
      "Reply started; outcome not confirmed",
    );
    await expect(activity.locator("[role=status]:not([aria-hidden=true])"))
      .toHaveCount(0);
    expect(
      await activity.evaluate((e) => {
        const r = e.getBoundingClientRect(),
          p = document.querySelector(".otk-right-panel")!
            .getBoundingClientRect(),
          heading = document.querySelector(".otk-panel-content > h2")!
            .getBoundingClientRect(),
          row = e.querySelector("header")!.getBoundingClientRect();
        return e.scrollHeight > e.clientHeight &&
          getComputedStyle(e).overflowY === "auto" &&
          r.bottom <= p.bottom + .5 && p.width === 320 &&
          Math.abs(heading.left - row.left) < .5 &&
          document.scrollingElement!.scrollHeight === innerHeight &&
          document.scrollingElement!.scrollWidth === innerWidth;
      }),
    ).toBe(true);
    await activity.hover();
    await page.mouse.wheel(0, 350);
    await expect.poll(() =>
      activity.evaluate((e) =>
        e.scrollTop > 0 && document.scrollingElement!.scrollTop === 0
      )
    ).toBe(true);
  },
);
