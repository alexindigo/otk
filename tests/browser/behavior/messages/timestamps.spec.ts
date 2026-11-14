// SPDX-License-Identifier: LGPL-3.0-only
import { DatabaseSync } from "node:sqlite";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";
test("messages.native-final-clock-hover-ax-preference-restart", {
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
  const time = page.locator(".otk-last-output-time"),
    date = page.locator(".otk-last-output-date");
  await expect(time).toBeAttached();
  await expect(page.locator("[data-role=assistant] .otk-text")).toContainText(
    "first output",
  );
  const first = await time.getAttribute("datetime");
  await expect(time).not.toHaveAttribute("datetime", first!);
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
    expected = ends.length
      ? Math.max(...ends)
      : reply.info.time.completed || reply.info.time.created;
  await expect.poll(() =>
    time.getAttribute("datetime").then((s) => Date.parse(s!))
  ).toBe(expected);
  await expect(date).toHaveCSS("visibility", "hidden");
  const before = await time.boundingBox();
  await time.hover();
  await expect(date).toHaveCSS("visibility", "visible");
  const geometry = await page.evaluate(() => {
    const date = document.querySelector(".otk-last-output-date")!,
      time = document.querySelector<HTMLTimeElement>(".otk-last-output-time")!,
      d = date.getBoundingClientRect(),
      t = time.getBoundingClientRect();
    return {
      dateRight: d.right,
      timeLeft: t.left,
      timeRight: t.right,
      dateCenter: d.y + d.height / 2,
      timeCenter: t.y + t.height / 2,
      date: date.textContent!.trim(),
      expected: new Date(time.dateTime).toLocaleDateString(),
    };
  });
  expect(geometry.date).toBe(geometry.expected);
  expect(geometry.dateRight).toBeLessThan(geometry.timeLeft);
  expect(Math.abs(geometry.dateCenter - geometry.timeCenter)).toBeLessThan(.5);
  expect(Math.abs(geometry.timeLeft - before!.x)).toBeLessThan(.5);
  expect(Math.abs(geometry.timeRight - before!.x - before!.width)).toBeLessThan(
    .5,
  );
  await page.mouse.move(10, 10);
  await expect(date).toHaveCSS("visibility", "hidden");
  for (const role of ["user", "assistant"]) {
    const created = page.locator(`[data-role=${role}] .otk-created-time`);
    await expect(created).toHaveCSS("visibility", "hidden");
    await page.locator(`[data-role=${role}] .otk-created-trigger`).hover();
    await expect(created).toHaveCSS("visibility", "visible");
    await page.mouse.move(10, 10);
    await expect(created).toHaveCSS("visibility", "hidden");
  }
  const style = await page.evaluate(() => {
    const footer = document.querySelector(".otk-message-footer")!,
      t = footer.querySelector(".otk-last-output-time")!,
      d = footer.querySelector(".otk-message-details")!;
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
      footerRight: footer.getBoundingClientRect().right,
      timeRight: t.getBoundingClientRect().right,
      detailsRight: d.getBoundingClientRect().right,
      timeLeft: t.getBoundingClientRect().left,
      footerColor: getComputedStyle(footer).color,
      timeColor: getComputedStyle(t).color,
      roleInk: color(document.querySelector(".otk-created-trigger")!),
      createdInk: color(document.querySelector(".otk-created-time")!),
    };
  });
  expect(Math.abs(style.footerRight - style.timeRight)).toBeLessThan(.5);
  expect(style.detailsRight).toBeLessThan(style.timeLeft);
  expect(style.footerColor).toBe(style.timeColor);
  expect(style.createdInk).toBeLessThan(style.roleInk);
  await page.locator("[data-role=assistant] .otk-created-trigger").click();
  await page.keyboard.press("Tab");
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
      ".otk-last-output-time",
    ]
  ) {
    await page.keyboard.press("Tab");
    await expect(page.locator(selector)).toBeFocused();
  }
  await expect(date).toHaveCSS("visibility", "visible");
  for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+Tab");
  await expect(page.locator("[data-role=assistant] .otk-created-trigger"))
    .toBeFocused();
  await expect(page.locator("[data-role=assistant] .otk-created-time"))
    .toHaveCSS("visibility", "visible");
  await page.locator(".otk-display-menu > button").click();
  await expect(page.locator(".otk-display-menu")).toContainText(
    "Always show timestamps",
  );
  await page.locator("input[name=timestamps]").click();
  await page.mouse.move(10, 10);
  await expect.poll(() =>
    page.locator(".otk-created-time").evaluateAll((rows) =>
      rows.length === 2 &&
      rows.every((e) => getComputedStyle(e).visibility === "visible")
    )
  ).toBe(true);
  const completed = await time.getAttribute("datetime");
  await page.reload();
  await expect(time).toHaveAttribute("datetime", completed!);
  await expect.poll(() =>
    page.locator(".otk-created-time").evaluateAll((rows) =>
      rows.length === 2 &&
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
