// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { sessionContext } from "../../pages/sessions.ts";
import { badge, focusNotifications } from "../../pages/notifications.ts";

test.use({ profile: "isolated" });
test(
  "attention.failure-burst-native-keeps-one-group-and-does-not-invent-input",
  {
    tag: ["@attention", "@sessions", "@transport"],
  },
  async ({ isolatedState: state, page }, info) => {
    const traffic = await wire(page);
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Failure owner fixture",
    });
    await openSession(state, page, session.id);
    await focusNotifications(page);
    await sessionContext(
      page,
      `[data-session="${session.id}"]`,
      "session.rename",
    );
    const editor = page.getByRole("textbox", {
      name: "Rename session",
      exact: true,
    });
    const errorID = await editor.getAttribute("aria-describedby");
    expect(errorID).toBeTruthy();
    const entry = page.locator(`[id=${JSON.stringify(errorID)}]`);
    // Delay real authoritative deletion publication, not requests or native results.
    // This reproduces acting from an older rendered view of a real native session.
    traffic.hold((frame) =>
      ![
        "request.accepted",
        "request.progress",
        "request.result",
        "request.rejected",
        "prefs",
        "ping",
      ].includes(frame.t)
    );
    try {
      await state.native(`/session/${session.id}`, "DELETE");
      for (let n = 1; n <= 22; n++) {
        await expect(editor).toBeEditable();
        await editor.fill(`Rejected rename ${n}`);
        await editor.press("Enter");
        await expect(entry).toContainText("Renaming session");
        if (n > 1) await expect(entry).toContainText(`${n} identical failures`);
        await expect(editor).toBeEditable();
      }
      await expect(entry.locator(".otk-failure-content")).toHaveCount(1);
      const geometry = await entry.evaluate((el) => {
        // Issue 2.96: the shared sidebar row owns both the content tracks
        // and its full-width feedback track below them.
        const row = el.closest(".otk-sidebar-row")!;
        const content = row.getBoundingClientRect();
        const action = row.querySelector(".otk-sidebar-row-main")!
          .getBoundingClientRect();
        const feedback = el.getBoundingClientRect();
        return {
          width: Math.abs(content.width - feedback.width),
          left: Math.abs(content.left - feedback.left),
          separate: !!el.closest(".otk-sidebar-row-feedback") &&
            feedback.top >= action.bottom - .5,
        };
      });
      expect(geometry.separate).toBe(true);
      expect(geometry.width).toBeLessThan(1);
      expect(geometry.left).toBeLessThan(1);
      await expect(entry).toContainText(/not found|no longer available/);
      // A missing session has no owner-supplied recovery; do not invent advice.
      await expect(entry.locator(".otk-failure-recovery")).toHaveCount(0);
      // WP5: the composer notice row is now inside FailureContent, while the
      // inline editor exposes that same presentation inside its alert frame.
      const notice = page.locator(".otk-operation-feedback");
      await expect(notice).toHaveCount(1);
      for (const surface of [notice, entry]) {
        await expect(surface.getByRole("link")).toHaveCount(0);
        await expect(surface).not.toContainText("Failure owner fixture");
        await expect(surface).not.toContainText(`Session ${session.id}`);
      }
      const failureContent = (element: Element) =>
        element.closest(".otk-control-label") === null;
      expect(
        await entry.locator(".otk-failure-content").evaluate(failureContent),
      )
        .toBe(true);
      expect(
        await notice.evaluate((element) => {
          const content = element.closest(".otk-failure-content");
          return !!content && content.closest(".otk-control-label") === null;
        }),
      ).toBe(true);
      // This selected target already owns inline feedback. Background-toast title
      // and link coverage belongs to failure-toast-native.spec.ts, not a duplicate.
      await expect(page.locator(".otk-toast")).toHaveCount(0);
      await expect(page.getByRole("img", { name: "Needs you", exact: true }))
        .toHaveCount(0);
      await badge(page, 0);
      await expect(page.locator(".otk-toasts-more")).toHaveCount(0);
      const keys = new Set(
        traffic.sent.filter((item) => item.frame.method === "session.rename")
          .map((item) => item.frame.ref!.key),
      );
      expect(keys.size).toBe(22);
      const failures = traffic.received.filter((frame) =>
        keys.has(frame.ref?.key ?? "") && frame.t === "request.result" &&
        !(frame.outcome as { ok: boolean }).ok
      );
      expect(new Set(failures.map((frame) => frame.ref!.key)).size).toBe(22);
      expect(
        new Set(
          failures.map((frame) =>
            (frame.outcome as { error: { diagnosticID: string } }).error
              .diagnosticID
          ),
        ).size,
      ).toBe(22);
      for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
        await state.product("prefs.set", { key: "theme", value: theme });
        await expect(page.locator("html")).toHaveAttribute(
          "data-otk-theme",
          theme,
        );
        await info.attach(`failure-group-${theme}`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png",
        });
      }
    } finally {
      traffic.release();
    }
  },
);
