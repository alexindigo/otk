// SPDX-License-Identifier: LGPL-3.0-only
import type { AssistantMessage, Message } from "@otk/protocol";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { hoverCompletedUsage, prompt } from "../../pages/transcript.ts";
test.use({ profile: "messages-priced" });
test("messages.priced-native-multistep-usage-display-persistence", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Charged turn usage",
  });
  await openSession(state, page, session.id);
  await prompt(page, "Read the directory and report usage");
  await expect(page.locator(".otk-message-flow")).toContainText(
    "Turn usage includes both steps.",
  );
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  const stored: Message[] = [];
  let before: string | undefined;
  do {
    const part = await state.product("session.messages", {
      sessionID: session.id,
      ...(before ? { before } : {}),
    });
    stored.unshift(...part.items);
    before = part.older ?? undefined;
  } while (before);
  const steps = stored.filter((m): m is AssistantMessage =>
      m.role === "assistant"
    ),
    categories = (
      m: Pick<AssistantMessage, "tokens">,
    ) => [
      m.tokens.input!,
      m.tokens.output!,
      m.tokens.reasoning!,
      m.tokens.cache.read!,
      m.tokens.cache.write!,
    ];
  expect(steps).toHaveLength(3);
  const detail = await state.product("usage.get", {
    sessionID: session.id,
    turnID: steps[0].replyTo ?? steps[0].id,
  });
  const native = await state.native<
    {
      info: { role: string; tokens: AssistantMessage["tokens"]; cost: number };
    }[]
  >(`/session/${session.id}/message`);
  expect(
    native.filter((r) => r.info.role === "assistant").map((r) => ({
      counts: categories(r.info),
      cost: r.info.cost,
    })),
  ).toEqual(steps.map((m) => ({ counts: categories(m), cost: m.cost })));
  const sums = steps.reduce(
      (sum, m) => categories(m).map((n, i) => n + sum[i]),
      [0, 0, 0, 0, 0],
    ),
    total = sums.reduce((a, n) => a + n, 0),
    cost = steps.reduce((a, m) => a + m.cost!, 0);
  expect(total).toBeGreaterThan(300000);
  expect(cost).toBeGreaterThan(0);
  const text = `3 model calls · ${
      new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(total)
    } tokens · $${cost.toFixed(2)}`,
    trigger = page.locator(".otk-turn-usage > button");
  await expect(trigger).toHaveText(text);
  await expect(trigger).toHaveCount(1);
  const catalog = await state.product("models.list", { sessionID: session.id }),
    price = catalog.providers.find((p) => p.id === "priced")!.models[0].cost!;
  expect(price).toEqual({ input: 2, output: 4, cache: { read: .5, write: 3 } });
  await hoverCompletedUsage(page);
  await expect(page.locator(".otk-turn-usage :popover-open")).toBeAttached();
  const rows = page.locator(".otk-usage-breakdown tbody tr");
  await expect(rows).toHaveCount(3);
  expect(await page.locator(".otk-usage-breakdown thead th").allTextContents())
    .toEqual([
      "Call",
      "Activity",
      "Context",
      "New input",
      "Output",
      "Reasoning",
      "Cache read",
      "Cache write",
      "Cost",
      "Time",
    ]);
  const values = await rows.evaluateAll((rows) =>
    rows.map((row) => Array.from(row.children, (cell) => cell.textContent!))
  );
  expect(values.map((r) => r[0])).toEqual(["1", "2", "3"]);
  expect(values.map((r) => r[1])).toEqual([
    state.controller.info!.version.startsWith("2.")
      ? "shell: pwd"
      : "bash: pwd",
    state.controller.info!.version.startsWith("2.")
      ? "shell: ls -la"
      : "bash: ls -la",
    "answered",
  ]);
  for (const [i, m] of steps.entries()) {
    expect(values[i].slice(3, 8)).toEqual(
      categories(m).map((n) => n.toLocaleString("en-US")),
    );
    expect(values[i][2]).toBe(
      (m.tokens.input! + m.tokens.cache.read! + m.tokens.cache.write!)
        .toLocaleString("en-US"),
    );
    if (i) {
      expect(Number(values[i][2].replaceAll(",", ""))).toBeGreaterThanOrEqual(
        Number(values[i - 1][2].replaceAll(",", "")),
      );
    }
    expect(Math.abs(Number(values[i][8].replace(/[$,]/g, "")) - m.cost!))
      .toBeLessThanOrEqual(.005);
    expect(values[i][9]).toBe(
      `${
        ((detail.calls[i].timing?.state === "known"
          ? detail.calls[i].timing.workingMs
          : NaN) / 1000).toFixed(1)
      }s`,
    );
  }
  const totals = await page.locator(".otk-usage-breakdown tfoot tr").evaluate(
    (row) => Array.from(row.children, (cell) => cell.textContent),
  );
  expect(totals[0]).toBe("Total");
  expect(totals[1]).toBe((sums[0] + sums[3] + sums[4]).toLocaleString("en-US"));
  await expect(page.locator(".otk-usage-context-note")).toHaveText(
    "New input + Cache read + Cache write = Context.",
  );
  const costs = await page.locator(".otk-usage-category-cost .otk-usage-cost")
    .evaluateAll((elements) =>
      elements.map((e) =>
        Number(
          e.getAttribute("aria-description")!.split("$")[1].replaceAll(",", ""),
        )
      )
    );
  for (const [i, rate] of [2, 4, 4, .5, 3].entries()) {
    expect(Math.abs(costs[i] - sums[i] * rate / 1e6)).toBeLessThanOrEqual(1e-9);
  }
  const turnTime = `${
    ((detail.summary.timing?.state === "known"
      ? detail.summary.timing.workingMs
      : NaN) / 1000).toFixed(1)
  }s`;
  await expect(page.locator(".otk-turn-time")).toHaveText(
    `Worked for ${turnTime}`,
  );
  await expect(page.locator(".otk-work-fold span").first()).toHaveText(
    `Worked for ${turnTime}`,
  );
  expect(
    await page.locator(".otk-turn-usage").evaluate((u) => {
      const a = u.getBoundingClientRect(),
        r = u.previousElementSibling!.getBoundingClientRect();
      return r.right <= a.left &&
        Math.abs(r.y + r.height / 2 - a.y - a.height / 2) <= .5;
    }),
  ).toBe(true);
  expect(
    await page.locator(".otk-usage-breakdown").evaluate((table) => {
      const panel = table.closest(".otk-surface")!.getBoundingClientRect(),
        rows = Array.from(table.querySelectorAll("tbody tr"));
      return panel.width > 0 && panel.height > 0 && panel.left >= 0 &&
        panel.right <= innerWidth && rows.every((row) =>
          Array.from(row.children).slice(2).every((cell, i) =>
            Math.abs(
              cell.getBoundingClientRect().right -
                rows[0].children[i + 2].getBoundingClientRect().right,
            ) <= .5
          )
        );
    }),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator(".otk-turn-usage :popover-open")).toHaveCount(0);
  await expect(page.locator("textarea[name=prompt]")).toBeFocused();
  await page.mouse.move(1, 1);
  await hoverCompletedUsage(page);
  await expect(page.locator(".otk-turn-usage :popover-open")).toBeAttached();
  await page.mouse.move(1, 1);
  await expect(page.locator(".otk-turn-usage :popover-open")).toHaveCount(0);
  await trigger.focus();
  await expect(page.locator(".otk-turn-usage :popover-open")).toBeAttached();
  await page.keyboard.press("Escape");
  await expect(page.locator(".otk-turn-usage :popover-open")).toHaveCount(0);
  await page.keyboard.press("Tab");
  await page.getByRole("button", { name: "Display options", exact: true })
    .click();
  await expect(page.locator("input[name=showCost]")).toBeChecked();
  await page.locator("input[name=showCost]").click();
  const off = text.slice(0, text.lastIndexOf(" · "));
  await expect(trigger).toHaveText(off);
  await expect(page.locator(".otk-context-meter")).not.toContainText("$");
  expect((await state.product("prefs.get", {})).showCost).toBe(false);
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(trigger).toHaveText(off);
  await expect(page.locator(".otk-context-meter")).toHaveAttribute(
    "data-limit",
    "1000000",
  );
  await expect(page.locator(".otk-context-bar")).toHaveAttribute(
    "aria-valuenow",
    "33",
  );
  await hoverCompletedUsage(page);
  await expect(page.locator(".otk-turn-usage :popover-open")).toBeAttached();
  expect(
    await trigger.evaluate((button) =>
      !button.hasAttribute("title") &&
      document.getElementById(button.getAttribute("aria-describedby")!)?.id ===
        button.getAttribute("popovertarget")
    ),
  ).toBe(true);
  // The popover shell opens before its complete usage snapshot installs.
  await expect.poll(() =>
    rows.evaluateAll((rows) => rows.map((row) => row.children.length))
  ).toEqual([9, 9, 9]);
  await expect(page.locator(".otk-message-footer")).not.toContainText("$");
  await expect(page.locator(".otk-context-meter")).not.toHaveAttribute(
    "data-cost",
  );
  await expect(page.locator(".otk-context-meter")).not.toContainText("$");
  await page.mouse.move(1, 1);
  await state.product("prefs.set", { key: "showCost", value: true });
  await prompt(page, "Start a separate turn");
  await expect(page.locator(".otk-message-flow")).toContainText(
    "Another turn has its own usage.",
  );
  await expect(trigger).toHaveCount(2);
  await expect(trigger.first()).toHaveText(text);
});
