// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";
test("messages.native-final-clock-persistent-footer-ax-preference-restart", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Message timestamps",
  });
  await openSession(state, page, session.id);
  const readSchema = () => {
    const port = new URL(state.url).port,
      db = new DatabaseSync(
        state.controller.info!.root + `/otk-${port}/otk.db`,
        {
          readOnly: true,
        },
      );
    try {
      expect(
        db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='output_times'",
        ).all(),
      ).toEqual([]);
      return {
        tables: db.prepare(
          "SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name",
        ).all(),
        migrations: db.prepare(
          "SELECT feature,version FROM otk_migrations ORDER BY feature,version",
        ).all(),
      };
    } finally {
      db.close();
    }
  };
  // Timestamp rendering must not add storage. Unrelated feature migrations
  // belong to application composition, not a copied inventory in this test.
  const schema = readSchema();
  await state.controller.call("queueScript", {
    lease: state.lease.lease,
    chunks: ["first output", " then more", " and more", " final output"],
    delay: 1000,
  });
  await prompt(page, "Show timestamp behavior");
  // The agent band never owns a second clock, including while streaming.
  const time = page.locator("[data-role=assistant] .otk-message-footer time");
  await expect.soft(page.locator(".otk-reply-start time")).toHaveCount(0);
  await expect(page.locator("[data-role=assistant] .otk-text")).toContainText(
    "first output",
  );
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await expect(page.locator("[data-role=assistant] .otk-text")).toContainText(
    "final output",
  );
  const raw = await state.native<
      {
        info: { role: string; time: { completed?: number; created: number } };
        parts: {
          type: string;
          time?: { end?: number };
          state?: { time?: { end?: number } };
        }[];
      }[]
    >(`/session/${session.id}/message`),
    reply = raw.find((r) =>
      r.info.role === "assistant" && r.info.time.completed
    )!;
  const ends = reply.parts.flatMap((p) =>
      p.type === "text" || p.type === "reasoning"
        ? [p.time?.end || 0]
        : p.type === "tool"
        ? [p.state?.time?.end || 0]
        : []
    ).filter((n) => n > 0),
    expected = reply.info.time.completed ?? Math.max(...ends);
  await expect.poll(() =>
    time.getAttribute("datetime").then((s) => Date.parse(s!))
  ).toBe(expected);
  const before = await time.locator("..").boundingBox();
  await time.hover();
  const geometry = await page.evaluate(() => {
    const footer = document.querySelector(
        "[data-role=assistant] .otk-message-footer",
      )!,
      time = footer.querySelector<HTMLTimeElement>(
        "time",
      )!,
      action = footer.querySelector("[data-message-command]")!,
      f = footer.getBoundingClientRect(),
      a = action.getBoundingClientRect(),
      t = time.closest(".otk-chrome-meta")!.getBoundingClientRect();
    return {
      timeLeft: t.left,
      timeRight: t.right,
      footerLeft: f.left,
      actionLeft: a.left,
      actionCenter: a.y + a.height / 2,
      timeCenter: t.y + t.height / 2,
      title: time.title,
      expected: new Date(time.dateTime).toLocaleString(undefined, {
        timeZoneName: "short",
      }),
      color: getComputedStyle(time).color,
      footerColor: getComputedStyle(time.closest(".otk-chrome-meta")!).color,
    };
  });
  expect(geometry.title).toBe(geometry.expected);
  expect(geometry.timeRight).toBeLessThan(geometry.actionLeft);
  expect(Math.abs(geometry.actionCenter - geometry.timeCenter)).toBeLessThan(
    .5,
  );
  expect(Math.abs(geometry.footerLeft - geometry.timeLeft)).toBeLessThan(.5);
  expect(geometry.color).toBe(geometry.footerColor);
  expect(Math.abs(geometry.timeLeft - before!.x)).toBeLessThan(.5);
  expect(Math.abs(geometry.timeRight - before!.x - before!.width)).toBeLessThan(
    .5,
  );
  await page.mouse.move(10, 10);
  for (const role of ["user"]) {
    const created = page.locator(
      `[data-role=${role}] .otk-message-footer time`,
    );
    await expect(created).toHaveCSS("visibility", "visible");
    await page.locator(`[data-role=${role}] .otk-user-bubble`).hover();
    await expect(created).toHaveCSS("visibility", "visible");
    await page.mouse.move(10, 10);
    await expect(created).toHaveCSS("visibility", "visible");
  }
  const style = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d")!;
    const color = (element: Element) => {
      ctx.clearRect(0, 0, 1, 1);
      const layers: Element[] = [];
      for (let n: Element | null = element; n; n = n.parentElement) {
        layers.unshift(n);
      }
      for (const n of layers) {
        ctx.fillStyle = getComputedStyle(n).backgroundColor;
        ctx.fillRect(0, 0, 1, 1);
      }
      ctx.fillStyle = getComputedStyle(element).color;
      ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3).reduce(
        (a, b) => a + b,
        0,
      );
    };
    return {
      roleInk: color(document.querySelector(".otk-user-bubble")!),
      createdInk: color(document.querySelector(".otk-user-meta time")!),
    };
  });
  expect(style.createdInk).toBeLessThan(style.roleInk);
  const agent = page.locator(".otk-reply-start .otk-entity-pill");
  await agent.focus();
  await expect(page.locator(".otk-entity :popover-open")).toContainText(
    "This reply",
  );
  await expect(page.locator(".otk-entity :popover-open")).toContainText(
    "Completed",
  );
  await page.keyboard.press("Escape");
  await expect(agent).toBeFocused();
  await page.locator(".otk-turn-usage > button").focus();
  await expect(page.locator(".otk-turn-usage > button")).toBeFocused();
  await expect(page.locator(".otk-turn-usage :popover-open")).toBeAttached();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("region", { name: "Model calls", exact: true }))
    .toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".otk-turn-usage :popover-open")).toHaveCount(0);
  await expect(page.locator(".otk-turn-usage > button")).toBeFocused();
  for (
    const selector of [
      '[data-message-command="reply.fork"]',
      ".otk-copy-message",
    ]
  ) {
    await page.keyboard.press("Tab");
    await expect(page.locator(selector)).toBeFocused();
  }
  await page.locator(".otk-user-bubble").focus();
  await expect(page.locator("[data-role=user] .otk-message-footer time"))
    .toHaveCSS("visibility", "visible");
  await page.locator(".otk-display-menu > button").click();
  await expect(page.locator("input[name=timestamps]")).toHaveCount(0);
  // Older saved/API values remain readable, but can no longer hide metadata.
  await state.product("prefs.set", { key: "timestamps", value: true });
  await page.mouse.move(10, 10);
  await expect.poll(() =>
    page.locator(".otk-user-meta time").evaluateAll((rows) =>
      rows.length === 1 &&
      rows.every((e) => getComputedStyle(e).visibility === "visible")
    )
  ).toBe(true);
  const completed = await time.getAttribute("datetime");
  await page.reload();
  await expect(time).toHaveAttribute("datetime", completed!);
  await expect.poll(() =>
    page.locator(".otk-user-meta time").evaluateAll((rows) =>
      rows.length === 1 &&
      rows.every((e) => getComputedStyle(e).visibility === "visible")
    )
  ).toBe(true);
  expect(readSchema()).toEqual(schema);
  await state.controller.call("restart", {
    lease: state.lease.lease,
    target: "sidecar",
  });
  await expect(page.locator(".otk-server-status[data-connection=local]"))
    .toHaveAttribute("title", /: connected;/, { timeout: 60000 });
  await expect(time).toHaveAttribute("datetime", completed!);
  expect(readSchema()).toEqual(schema);
});
