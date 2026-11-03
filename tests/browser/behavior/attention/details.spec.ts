// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { file, seed, tool } from "../../pages/attention.ts";
import { focusNotifications, toast } from "../../pages/notifications.ts";

test.use({ profile: "contract-attention-native" });
test(
  "attention.permission-toast-and-takeover-share-exact-summary-before-native-approval",
  { tag: ["@attention", "@isolated"] },
  async ({ isolatedState: state, page }) => {
    const a = await seed(state, "Current conversation"),
      b = await seed(state, "Review exact permission targets");
    await openSession(state, page, a.id);
    await focusNotifications(page);
    await page.locator("textarea[name=prompt]").fill("Keep this unsent draft");
    const compare = async (kind: string, target: string) => {
      const note = page.locator(toast(b.id));
      await expect(note).toContainText("Allow once");
      const summary = note.locator(".otk-permission-summary");
      await expect(summary).toContainText(kind);
      await expect(summary).toContainText(target);
      const text = await summary.textContent();
      expect(
        await summary.evaluate((s) => {
          const r = s.getBoundingClientRect(),
            p = s.closest(".otk-surface")!.getBoundingClientRect();
          return r.width > 0 && r.left >= p.left && r.right <= p.right &&
            getComputedStyle(s).position === "static";
        }),
      ).toBe(true);
      await note.locator(".otk-toast-actions button").first().click();
      await expect(page).toHaveURL(new RegExp(`${b.id}$`));
      await expect(page.locator(".otk-permission-dock .otk-permission-summary"))
        .toHaveText(text!);
      await openSession(state, page, a.id);
      await expect(page.locator("textarea[name=prompt]")).toHaveValue(
        "Keep this unsent draft",
      );
    };
    const answer = async (value: "once" | "reject") => {
      const [pending] = await state.product("permission.list", {
        sessionID: b.id,
      });
      await state.product("permission.reply", {
        sessionID: b.id,
        requestID: pending.id,
        reply: value,
      });
    };
    const command = "printf permission-details-result > permission-details.txt";
    await tool(state, "bash", { command, description: "Exact command" });
    await state.queue(["Command finished"]);
    await state.product("session.prompt", {
      sessionID: b.id,
      mode: "normal",
      parts: [{ kind: "text", text: "Run the exact command" }],
    });
    await compare("bash", command);
    await answer("once");
    await file(state, "permission-details.txt", "permission-details-result");
    await expect.poll(async () =>
      !(await state.native<Record<string, unknown>>("/session/status"))[
        b.nativeID
      ]
    ).toBe(true);
    const path = `${state.directory}/README.md`;
    await tool(state, "read", { filePath: path });
    await tool(state, "edit", {
      filePath: path,
      oldString: "# OTK fixture",
      newString: "# Changed fixture",
    });
    await state.product("session.prompt", {
      sessionID: b.id,
      mode: "normal",
      parts: [{ kind: "text", text: "Read then propose an edit" }],
    });
    await compare("read", "README.md");
    await answer("once");
    await compare("edit", path);
    await answer("reject");
    await expect.poll(async () =>
      !(await state.native<Record<string, unknown>>("/session/status"))[
        b.nativeID
      ]
    ).toBe(true);
    await file(state, "README.md", "# OTK fixture\n");
  },
);
