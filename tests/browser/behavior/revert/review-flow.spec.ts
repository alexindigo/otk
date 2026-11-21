// SPDX-License-Identifier: LGPL-3.0-only
// Real-app coverage of the complete revert journey, with spatial evidence.
import { mkdirSync, writeFileSync } from "node:fs";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import {
  prompt,
  revealAcquired,
  scrollTranscript,
} from "../../pages/transcript.ts";
import { messages } from "../../pages/composer.ts";
import { pick, rightClick } from "../../pages/menus.ts";

const THEMES = [["dark", "otk-dark"], ["linen", "otk-light"], [
  "stone",
  "otk-light-stone",
]] as const;
const P1 = "First prompt kept live";
const P2 =
  "revert overlaps, looks out of place, doesn't put original text back into input box, get fresh senior with ui-design skill to review this";
const P3 =
  "Oof, looks like it reverted much more than I was trying to revert, and the panel still sits over the transcript";

test.use({
  profile: "revert-native",
  viewport: { width: 1280, height: 800 },
  timezoneId: "America/Los_Angeles",
});

test("revert.review-flow", {
  tag: ["@revert", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const OUT = test.info().outputPath("review");
  mkdirSync(OUT, { recursive: true });
  test.setTimeout(420_000);
  const frames = await wire(page);
  const source = await state.native<{ id: string }>("/session", "POST", {
    title: "Revert style review",
  });
  await state.product("prefs.set", { key: "animationsOff", value: true });
  await openSession(state, page, source.id);
  for (const text of [P1, P2, P3]) {
    await state.queue([
      "Full reply to " + text.slice(0, 30) +
      ".\n\nThe complete earlier record stays readable after reverting.",
    ]);
    await prompt(page, text);
    await expect(page.locator(".otk-messages")).toContainText(
      "Full reply to " + text.slice(0, 30),
    );
    await expect(page.locator(`[data-session="${source.id}"]`))
      .toHaveAttribute("data-status", "idle");
  }
  const original = await messages(state, source.id);
  const idOf = (start: string) =>
    original.find((m) =>
      m.info.role === "user" &&
      m.parts.some((p: { text?: string }) => p.text?.startsWith(start))
    )!.info.id;
  const input = page.locator("textarea[name=prompt]");
  const group = page.locator(".otk-revert-group");
  const confirmRegion = page.getByRole("region", {
    name: "Confirm revert",
    exact: true,
  });
  const request = async (messageID: string) => {
    const sel = `[data-message="${messageID}"] .otk-user-bubble`;
    await revealAcquired(page, sel);
    const bubble = page.locator(sel);
    await bubble.scrollIntoViewIfNeeded();
    await bubble.focus();
    await bubble.locator("..").locator(
      '[data-message-command="prompt.revert"]',
    ).click();
    await expect(confirmRegion).toBeVisible();
  };
  const facts = () =>
    page.evaluate(() => {
      const box = (el: Element | null | undefined) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          x: +r.x.toFixed(1),
          r: +r.right.toFixed(1),
          y: +r.y.toFixed(1),
          b: +r.bottom.toFixed(1),
          w: +r.width.toFixed(1),
          h: +r.height.toFixed(1),
        };
      };
      const describe = (el: Element) => {
        const cs = getComputedStyle(el);
        const html = el as HTMLElement;
        return {
          tag: el.tagName,
          cls: String(
            (el as unknown as { className: { baseVal?: string } }).className
              ?.baseVal ?? (el as HTMLElement).className,
          ),
          text: (el.textContent || "").trim().slice(0, 90),
          box: box(el),
          clipped: html.scrollWidth > html.clientWidth + 1,
          color: cs.color,
          weight: cs.fontWeight,
          size: cs.fontSize,
          wrap: cs.whiteSpace,
          opacity: cs.opacity,
        };
      };
      const g = document.querySelector(".otk-revert-group");
      const head = g?.querySelector(".otk-record-group-heading");
      const conf = document.querySelector(".otk-revert-confirmation");
      return {
        pane: box(document.querySelector(".otk-messages")),
        dock: box(document.querySelector(".otk-composer-dock")),
        group: box(g),
        phase: g?.getAttribute("data-phase"),
        dismissed: g?.getAttribute("data-dismissed"),
        head: head && {
          box: box(head),
          border: getComputedStyle(head).borderInlineStartWidth,
          padding: getComputedStyle(head).paddingInlineStart,
        },
        headItems: head
          ? Array.from(
            head.querySelectorAll(
              "svg, button, .otk-control-label, .otk-revert-preview, .otk-revert-reason, .otk-chrome-meta",
            ),
          ).map(describe)
          : [],
        records: box(document.querySelector(".otk-revert-records")),
        recordTexts: Array.from(
          document.querySelectorAll(".otk-revert-records [data-message]"),
        ).map((el) => (el.textContent || "").trim().slice(0, 60)),
        notices: Array.from(
          document.querySelectorAll(".otk-messages .otk-composer-notice-row"),
        ).map((el) => ({
          ...describe(el),
          icon: box(el.querySelector("svg")),
        })),
        confirmation: box(conf),
        confirmationItems: conf
          ? Array.from(
            conf.querySelectorAll("p, .otk-revert-preview-row, button"),
          )
            .map(describe)
          : [],
        choice: box(document.querySelector(".otk-permanence-choice")),
        choiceItems: Array.from(
          document.querySelectorAll(
            ".otk-permanence-choice button, .otk-permanence-choice strong, .otk-permanence-choice p",
          ),
        ).map(describe),
        input: (document.querySelector("textarea[name=prompt]") as
          | HTMLTextAreaElement
          | null)?.value,
      };
    });
  const capture = async (name: string) => {
    const all: Record<string, unknown> = {};
    for (const [theme, id] of THEMES) {
      await state.product("prefs.set", { key: "theme", value: id });
      await expect(page.locator("html")).toHaveAttribute("data-otk-theme", id);
      await page.evaluate(() => document.fonts.ready);
      await page.mouse.move(1270, 790);
      all[theme] = await facts();
      await page.screenshot({
        path: `${OUT}/style8-${name}-${theme}.png`,
        animations: "disabled",
      });
    }
    writeFileSync(`${OUT}/style8-${name}.json`, JSON.stringify(all, null, 1));
  };

  // Own revert of the long prompt: confirming -> staging -> saving -> saved.
  await input.fill("Prior unsent draft is preserved");
  await request(idOf("revert overlaps"));
  await confirmRegion.scrollIntoViewIfNeeded();
  await capture("confirming");
  frames.hold((frame, req) =>
    frame.t === "request.result" && req?.method === "session.revert"
  );
  await page.getByRole("button", { name: "Confirm revert", exact: true })
    .click();
  await expect(group).toContainText("Reverting");
  frames.release();
  frames.hold((frame, req) =>
    frame.t === "request.result" && req?.method === "history.messages"
  );
  await expect(group).toContainText("Saving copy");
  await capture("saving");
  frames.release();
  await expect(group).toContainText("Copy saved");
  await group.getByRole("button", { name: "Open copy", exact: true }).click();
  const saved = page.getByRole("region", {
    name: "Saved earlier branch",
    exact: true,
  });
  await expect(saved).toContainText(P2.slice(0, 30));
  await saved.getByRole("button", { name: "Delete saved branch", exact: true })
    .click();
  await expect(group).toHaveAttribute("data-phase", "staged");
  await expect(group.getByRole("button", { name: "Open copy", exact: true }))
    .toHaveCount(0);
  await capture("staged");
  await group.getByRole("button", { name: "Save copy", exact: true }).click();
  await expect(group).toHaveAttribute("data-phase", "saved");
  await capture("saved");
  await page.locator(".otk-revert-group .otk-record-group-toggle").click();
  await page.locator(".otk-revert-group .otk-record-group-heading")
    .scrollIntoViewIfNeeded();
  await capture("saved-expanded");
  await page.locator(".otk-revert-group .otk-record-group-toggle").click();

  // Restore from the header, without a reload.
  await group.getByRole("button", { name: "Restore conversation", exact: true })
    .click();
  await expect(group).toHaveCount(0);
  await scrollTranscript(page, true);
  await expect(page.locator(".otk-messages")).toContainText(P3.slice(0, 30), {
    timeout: 10_000,
  });
  await capture("restored");

  // Dismissed, then restore through the context menu.
  await request(idOf("revert overlaps"));
  await page.getByRole("button", { name: "Confirm revert", exact: true })
    .click();
  await expect(group).toContainText(/Copy saved|Saving copy/);
  await expect(group).toContainText("Copy saved");
  await page.getByRole("button", { name: "Dismiss revert", exact: true })
    .click();
  await expect(page.locator(".otk-revert-records")).toHaveCount(0);
  await scrollTranscript(page, true);
  await capture("dismissed");
  await rightClick(page, ".otk-revert-group");
  await pick(page, "Restore conversation");
  await expect(group).toHaveCount(0);

  // Failed capture and failed send, on the third (long) prompt.
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Reflect.set(globalThis, "restoreRevertStorage", () => {
      Storage.prototype.setItem = original;
    });
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("otk.branch-history")) {
        throw new DOMException("full", "QuotaExceededError");
      }
      original.call(this, key, value);
    };
  });
  await request(idOf("Oof, looks like"));
  await page.getByRole("button", { name: "Confirm revert", exact: true })
    .click();
  await expect(group.getByRole("button", { name: "Retry", exact: true }))
    .toBeInViewport();
  await capture("failed-after-confirm");
  await scrollTranscript(page, true);
  await expect(group).toContainText("Retry");
  await scrollTranscript(page, true);
  await capture("failed");
  await input.fill("Replacement after a failed copy");
  await input.press("Enter");
  const choice = page.locator(".otk-permanence-choice");
  await expect(choice).toContainText("Sending makes the revert permanent");
  await capture("failed-send");
  await choice.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(() => Reflect.get(globalThis, "restoreRevertStorage")());
  await group.getByRole("button", { name: "Restore conversation", exact: true })
    .click();
  await expect(group).toHaveCount(0);

  // A revert staged by another client (native API), on the first prompt.
  await expect(page.locator(".otk-global-error, .otk-toast[data-kind=error]"))
    .toHaveCount(0);
  await input.fill("");
  await state.native(`/session/${source.id}/revert`, "POST", {
    messageID: idOf("First prompt"),
    files: false,
  });
  await expect(group).toHaveAttribute("data-phase", "saved");
  await scrollTranscript(page, true);
  await expect(group).toContainText("First prompt kept live");
  await expect(group).toContainText(/Copy saved|Retry|Saving copy/);
  await scrollTranscript(page, true);
  await capture("other-client");
  await page.getByRole("button", { name: "Dismiss revert", exact: true })
    .click();
  await capture("other-client-dismissed");
});
