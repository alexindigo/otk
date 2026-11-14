// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { seed, tool } from "../../pages/attention.ts";
import { badge, focusNotifications, toast } from "../../pages/notifications.ts";

test.use({ profile: "contract-attention-native" });
test("attention.notification-stack-dismissal-age-and-viewport", {
  tag: ["@attention", "@visual", "@menus", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  const current = await seed(state, "Current conversation");
  const frames = await wire(page);
  await openSession(state, page, current.id);
  await focusNotifications(page);
  await page.clock.setFixedTime(Date.now() + 12 * 86400_000 + 60_000);
  const sessions: { id: string; nativeID: string }[] = [];
  const longCommand = `cat ${state.directory}/${
    "long-path/".repeat(12)
  }README.md`;
  const ask = async (n: number) => {
    const session = await seed(state, `Paused review ${n}`);
    sessions.push(session);
    if (n === 8) {
      await tool(state, "bash", {
        command: longCommand,
        description: "Inspect a long path",
      });
    } else {await tool(state, "read", {
        filePath: `${state.directory}/README.md`,
      });}
    await state.product("session.prompt", {
      sessionID: session.id,
      mode: "normal",
      parts: [{ kind: "text", text: `Inspect file ${n}` }],
    });
    await expect.poll(async () =>
      (await state.product("permission.list", { sessionID: session.id })).length
    ).toBe(1);
    await expect(page.locator(toast(session.id))).toBeVisible();
    return session;
  };
  const themes = ["otk-dark", "otk-light", "otk-light-stone"];
  const capture = async (count: string) => {
    for (const theme of themes) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await page.screenshot({
        path: info.outputPath(`notif-${count}-${theme}.png`),
      });
      if (count === "eight") {
        for (const selector of [".otk-toast-close", ".otk-toast-dismiss"]) {
          const card = page.locator(".otk-toast").first();
          const control = card.locator(selector);
          await control.hover();
          await card.screenshot({
            path: info.outputPath(
              `notif-${theme}-${selector.slice(1)}-hover.png`,
            ),
          });
          await control.focus();
          await card.screenshot({
            path: info.outputPath(
              `notif-${theme}-${selector.slice(1)}-focus.png`,
            ),
          });
          await control.blur();
          await page.mouse.move(400, 400);
        }
      }
    }
  };
  const first = await ask(1);
  const note = page.locator(toast(first.id));
  await expect(
    note.getByRole("button", { name: "Close notification", exact: true }),
  ).toBeVisible();
  await expect(note.locator(".otk-toast-age")).toHaveText(
    "Session idle 12 days",
  );
  await expect(note.getByRole("button", { name: "Allow once", exact: true }))
    .toHaveAttribute("title", "Resumes work paused 12 days ago");
  await expect(note.getByRole("button", { name: "Allow once", exact: true }))
    .toHaveAccessibleDescription("Resumes work paused 12 days ago");
  await capture("one");
  for (let n = 2; n <= 8; n++) await ask(n);
  await expect(page.locator(".otk-toast")).toHaveCount(3);
  await expect(
    page.getByRole("button", { name: "5 more need you", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".otk-toast").first()).toContainText(
    "Paused review 8",
  );
  const path = page.locator(
    `${toast(sessions[7].id)} .otk-permission-compact .otk-path`,
  );
  await expect(path).toHaveAttribute("title", longCommand);
  expect(await path.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
    true,
  );
  const measurements = [];
  for (const width of [600, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(page.locator(".otk-toast")).toHaveCount(3);
    const geometry = await page.locator(".otk-toasts").evaluate((stack) => {
      const box = stack.getBoundingClientRect();
      const close = stack.querySelector(".otk-toast-close")!;
      const icon = close.firstElementChild!.getBoundingClientRect();
      const c = close.getBoundingClientRect();
      const dismiss = stack.querySelector(".otk-toast-dismiss")!
        .getBoundingClientRect();
      const label = document.createRange();
      label.selectNodeContents(stack.querySelector(".otk-toast-dismiss")!);
      const text = label.getBoundingClientRect();
      const actions = stack.querySelector(".otk-toast-actions")!
        .getBoundingClientRect();
      return {
        contained: box.left >= 0 && box.top >= 0 && box.right <= innerWidth &&
          box.bottom <= innerHeight,
        scrollports:
          [...Array.from(stack.querySelectorAll("*")), stack].filter((e) =>
            /auto|scroll/.test(getComputedStyle(e).overflowY) &&
            e.scrollHeight > e.clientHeight + 1
          ).length,
        cards: stack.querySelectorAll(".otk-toast").length,
        gaps: [
          icon.left - c.left,
          c.right - icon.right,
          icon.top - c.top,
          c.bottom - icon.bottom,
        ],
        dismissRight: actions.right - dismiss.right,
        dismissCenters: [
          Math.abs(
            text.left + text.width / 2 - dismiss.left - dismiss.width / 2,
          ),
          Math.abs(
            text.top + text.height / 2 - dismiss.top - dismiss.height / 2,
          ),
        ],
      };
    });
    expect(geometry.contained).toBe(true);
    expect(geometry.scrollports).toBe(0);
    expect(geometry.cards).toBe(3);
    expect(Math.max(...geometry.gaps) - Math.min(...geometry.gaps))
      .toBeLessThanOrEqual(1);
    expect(geometry.dismissRight).toBeLessThanOrEqual(1);
    for (const delta of geometry.dismissCenters) {
      expect(delta).toBeLessThanOrEqual(1);
    }
    measurements.push({ width, ...geometry });
  }
  await capture("eight");
  const newest = page.locator(toast(sessions[7].id));
  const replies = () =>
    frames.sent.filter(({ frame }) =>
      frame.method === "permission.reply" ||
      frame.method === "question.reply" || frame.method === "question.reject"
    ).length;
  const before = replies();
  await newest.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(newest).toHaveCount(0);
  await expect(page.locator(toast(sessions[6].id))).toBeVisible();
  await page.locator(toast(sessions[6].id)).getByRole("button", {
    name: "Close notification",
    exact: true,
  }).click();
  await expect(page.locator(toast(sessions[6].id))).toHaveCount(0);
  expect(replies()).toBe(before);
  const pending = await state.native<{ id: string; sessionID: string }[]>(
    "/permission",
  );
  expect(pending).toHaveLength(8);
  await badge(page, 8);
  const firstPage = await page.locator(".otk-toast").evaluateAll((cards) =>
    cards.map((card) => card.getAttribute("data-note"))
  );
  await page.getByRole("button", { name: "3 more need you", exact: true })
    .click();
  await expect(page.locator(".otk-toast")).toHaveCount(3);
  await expect.poll(() =>
    page.locator(".otk-toast").evaluateAll((cards) =>
      cards.map((card) => card.getAttribute("data-note"))
    )
  ).not.toEqual(firstPage);
  expect(replies()).toBe(before);
  await badge(page, 8);
  // Overflow pages retained evidence; only explicit dismissal retires a note.
  for (let remaining = 6; remaining > 0; remaining--) {
    await page.locator(".otk-toast").first().getByRole("button", {
      name: "Dismiss",
      exact: true,
    }).click();
    await expect(page.locator(".otk-toast")).toHaveCount(
      Math.min(3, remaining - 1),
    );
  }
  await expect(page.locator(".otk-toast")).toHaveCount(0);
  for (const session of sessions) {
    await expect(
      page.locator(
        `[data-session="${session.id}"] .otk-status-light[data-state=blocked]`,
      ),
    ).toBeVisible();
  }
  await state.product("prefs.set", { key: "notify.sound", value: false });
  expect(await state.native<unknown[]>("/permission")).toHaveLength(8);
  expect(replies()).toBe(before);
  await badge(page, 8);
  await expect(newest).toHaveCount(0);
  await info.attach("notification-geometry", {
    body: JSON.stringify(measurements),
    contentType: "application/json",
  });
});

test(
  "attention.dismissed-permission-and-question-notify-only-for-a-new-native-request",
  {
    tag: ["@attention", "@isolated"],
  },
  async ({ isolatedState: state, page }) => {
    const current = await seed(state, "Current conversation");
    await openSession(state, page, current.id);
    await focusNotifications(page);
    await page.clock.setFixedTime(Date.now() + 12 * 86400_000 + 60_000);
    for (const kind of ["permission", "question"] as const) {
      const session = await seed(state, `Paused ${kind}`);
      const ask = async () => {
        await tool(
          state,
          kind === "permission" ? "read" : "question",
          kind === "permission"
            ? { filePath: `${state.directory}/README.md` }
            : {
              questions: [{
                header: "Output",
                question: "Choose output",
                options: [{ label: "Typed", description: "OTK shapes" }],
              }],
            },
        );
        await state.queue(["Resolved"]);
        await state.product("session.prompt", {
          sessionID: session.id,
          mode: "normal",
          parts: [{ kind: "text", text: "Ask for input" }],
        });
        await expect(page.locator(toast(session.id))).toBeVisible();
        await expect(page.locator(`${toast(session.id)} .otk-toast-age`))
          .toHaveText("Session idle 12 days");
        return (await state.product(`${kind}.list`, { sessionID: session.id }))[
          0
        ];
      };
      const first = await ask();
      await page.locator(toast(session.id)).getByRole("button", {
        name: "Dismiss",
        exact: true,
      }).click();
      await state.product("prefs.set", { key: "notify.toast", value: false });
      await state.product("prefs.set", { key: "notify.toast", value: true });
      await focusNotifications(page);
      await expect(page.locator(toast(session.id))).toHaveCount(0);
      expect(
        (await state.product(`${kind}.list`, { sessionID: session.id })).map((
          r,
        ) => r.id),
      ).toEqual([first.id]);
      const native = await state.native<{ id: string }[]>(
        kind === "permission" ? "/permission" : "/question",
      );
      expect(native).toHaveLength(1);
      await expect(
        page.locator(
          `[data-session="${session.id}"] .otk-status-light[data-state=blocked]`,
        ),
      ).toBeVisible();
      if (kind === "permission") {
        await state.product("permission.reply", {
          sessionID: session.id,
          requestID: first.id,
          reply: "once",
        });
      } else {await state.product("question.reply", {
          requestID: first.id,
          answers: [["Typed"]],
        });}
      await expect.poll(async () =>
        !(await state.native<Record<string, unknown>>("/session/status"))[
          session.nativeID
        ]
      ).toBe(true);
      const second = await ask();
      expect(second.id).not.toBe(first.id);
      await page.locator(toast(session.id)).getByRole("button", {
        name: "Close notification",
        exact: true,
      }).click();
      expect(
        (await state.product(`${kind}.list`, { sessionID: session.id })).map((
          r,
        ) => r.id),
      ).toEqual([second.id]);
      if (kind === "permission") {
        await state.product("permission.reply", {
          sessionID: session.id,
          requestID: second.id,
          reply: "once",
        });
      } else {
        await state.product("question.reply", {
          requestID: second.id,
          answers: [["Typed"]],
        });
      }
      await expect.poll(async () =>
        !(await state.native<Record<string, unknown>>("/session/status"))[
          session.nativeID
        ]
      ).toBe(true);
      await expect.poll(async () =>
        (await state.product(`${kind}.list`, { sessionID: session.id })).length
      ).toBe(0);
    }
  },
);
