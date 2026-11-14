// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession, throughDuration, wire } from "../../fixtures/wire.ts";

test(
  "messages.jump-to-latest-reaches-native-tail-and-resumes-follow-on-every-surface",
  {
    tag: ["@messages", "@contracts", "@load"],
  },
  async ({ state, page }, info) => {
    const frames = await wire(page);
    frames.hold((frame, request) =>
      request?.method === "sessions.seen" && frame.t === "request.result"
    );
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Jump to latest",
    });
    for (let n = 0; n < 6; n++) {
      await state.queue([
        Array.from({ length: 45 }, (_, i) =>
          `Source ${n}-${i}: ` +
          "Keep the reader's place until they choose to follow the latest output. "
            .repeat(3)).join("\n\n"),
      ]);
      await state.native(`/session/${session.id}/prompt_async`, "POST", {
        parts: [{ type: "text", text: `Request ${n}` }],
      });
      await expect.poll(async () => {
        const messages = await state.native<
          { info: { role: string; time: { completed?: number } } }[]
        >(`/session/${session.id}/message`);
        return messages.filter((message) =>
          message.info.role === "assistant" && message.info.time.completed
        ).length;
      }).toBe(n + 1);
    }
    await openSession(state, page, session.id);
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(() =>
      frames.held.some(({ frame, request }) =>
        request?.method === "sessions.seen" && frame.t === "request.result"
      )
    ).toBe(true);
    await expect(page.locator(".otk-composer-notice")).toContainText(
      "Saving viewed conversation",
    );
    // Opening a session also saves its viewed terminal. A held receipt keeps
    // that real notice in the composer even after transcript readiness. Compare
    // jump visibility only after that operation and the composer have settled.
    frames.release();
    await expect(page.locator(".otk-composer-notice")).toBeHidden();
    await expect(page.getByRole("form", { name: "Composer", exact: true }))
      .toHaveAttribute("aria-busy", "false");
    const pane = page.getByRole("region", { name: "Transcript", exact: true });
    const jump = page.locator(".otk-jump-slot").getByRole("button", {
      name: "Jump to latest",
      exact: true,
    });
    const gap = () =>
      pane.evaluate((p) =>
        Math.max(0, p.scrollHeight - p.clientHeight - p.scrollTop)
      );
    const bottom = async () => {
      await expect.poll(gap).toBeLessThanOrEqual(1);
      await expect(jump).toBeHidden();
    };
    const up = async () => {
      const rect = await pane.boundingBox();
      await page.mouse.move(rect!.x + 8, rect!.y + rect!.height / 2);
      for (let i = 0; i < 4; i++) {
        await page.mouse.wheel(0, -rect!.height / 2);
        await page.waitForTimeout(100);
      }
      await expect.poll(gap).toBeGreaterThan(rect!.height);
      await expect(jump).toBeVisible();
    };
    await bottom();
    const layout = () =>
      page.evaluate(() => ({
        transcript: document.querySelector(".otk-messages")!
          .getBoundingClientRect().toJSON(),
        composer: document.querySelector(".otk-composer-dock")!
          .getBoundingClientRect().toJSON(),
      }));
    const hiddenLayout = await layout();
    // The hidden control reserves no band: this is the unchanged-base edge.
    expect(
      Math.abs(hiddenLayout.transcript.bottom - hiddenLayout.composer.top),
    ).toBeLessThanOrEqual(.5);
    const beforeSlot = await pane.boundingBox();
    await up();
    expect(await pane.boundingBox()).toEqual(beforeSlot);
    expect(await layout()).toEqual(hiddenLayout);
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      const geometry = await jump.evaluate((button) => {
        const control = button.getBoundingClientRect();
        const icon = button.querySelector("svg")!.getBoundingClientRect();
        const footer = button.parentElement!.getBoundingClientRect();
        const composer = document.querySelector(".otk-composer-dock")!
          .getBoundingClientRect();
        const viewport = document.querySelector(".otk-messages")!
          .getBoundingClientRect();
        const inset = parseFloat(
          getComputedStyle(button.parentElement!)
            .getPropertyValue("--jump-bottom-inset"),
        );
        const reference = document.createElement("span");
        Object.assign(reference.style, {
          position: "fixed",
          visibility: "hidden",
          background: "var(--overlay-bg)",
          color: "var(--otk-fg)",
          border: "1px solid var(--overlay-border)",
          boxShadow: "var(--overlay-shadow)",
        });
        document.body.append(reference);
        const paint = (element: Element) => {
          const style = getComputedStyle(element);
          return {
            background: style.backgroundColor,
            color: style.color,
            borderColor: style.borderTopColor,
            borderWidth: style.borderTopWidth,
            borderStyle: style.borderTopStyle,
            shadow: style.boxShadow,
          };
        };
        const actualPaint = paint(button), expectedPaint = paint(reference);
        reference.remove();
        return {
          control,
          icon,
          footer,
          composer,
          viewport,
          inset,
          actualPaint,
          expectedPaint,
        };
      });
      expect(geometry.actualPaint).toEqual(geometry.expectedPaint);
      expect(geometry.actualPaint.background).not.toBe("rgba(0, 0, 0, 0)");
      expect(geometry.actualPaint.shadow).not.toBe("none");
      expect(await layout()).toEqual(hiddenLayout);
      expect(geometry.footer.bottom).toBeLessThanOrEqual(geometry.composer.top);
      expect(geometry.control.top).toBeGreaterThanOrEqual(
        geometry.viewport.top,
      );
      expect(
        Math.abs(
          geometry.footer.bottom - geometry.viewport.bottom + geometry.inset,
        ),
      ).toBeLessThanOrEqual(.5);
      expect(
        Math.abs(
          (geometry.control.x + geometry.control.width / 2) -
            (geometry.footer.x + geometry.footer.width / 2),
        ),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(
          (geometry.icon.x - geometry.control.x) -
            (geometry.control.right - geometry.icon.right),
        ),
      ).toBeLessThanOrEqual(1);
      await page.screenshot({ path: info.outputPath(`${theme}-jump.png`) });
      await jump.hover();
      await expect(jump).toHaveCSS(
        "background-color",
        geometry.expectedPaint.background,
      );
      await page.mouse.move(1, 1);
    }
    const reads =
      frames.sent.filter(({ frame }) => frame.method === "session.messages")
        .length;
    await jump.click();
    await bottom();
    expect(
      frames.sent.filter(({ frame }) => frame.method === "session.messages"),
    ).toHaveLength(reads);
    await state.queue([
      "New authoritative tail.\n\n".repeat(55) + "FOLLOW WITNESS",
    ]);
    await state.native(`/session/${session.id}/prompt_async`, "POST", {
      parts: [{ type: "text", text: "Continue at the latest output" }],
    });
    await expect(pane.getByText("FOLLOW WITNESS", { exact: true }))
      .toBeVisible();
    await bottom();
    await up();
    // Native reverse/forward Tab travel reaches the visible named control.
    await jump.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(jump).not.toBeFocused();
    await page.keyboard.press("Tab");
    await expect(jump).toBeFocused();
    await page.keyboard.press("Enter");
    await bottom();
    await up();
    await page.keyboard.press("Control+k");
    await page.getByRole("textbox", { name: "Find a command" }).fill(
      "Jump to latest",
    );
    await page.locator('[data-command="transcript.latest"]').click();
    await bottom();
    await up();
    const prompt = page.locator("textarea[name=prompt]");
    await prompt.fill("/latest");
    await expect(page.locator(".otk-autocomplete")).toContainText("/latest");
    await prompt.press("Enter");
    await bottom();

    // Hold real newest-page recovery, not a product test hook. Pending repeated
    // activation joins the canonical read and upward input supersedes follow.
    await up();
    let waitingWelcome = true;
    frames.hold((frame, request) =>
      waitingWelcome || request?.method === "session.messages" ||
      frame.t === "load.chunk"
    );
    const welcomes =
      frames.received.filter((frame) => frame.t === "welcome").length;
    frames.close();
    await expect.poll(() =>
      frames.received.filter((frame) => frame.t === "welcome").length
    ).toBeGreaterThan(welcomes);
    await expect.poll(() => frames.held.length).toBeGreaterThan(0);
    const source = await pane.evaluate((p) => {
      const bounds = p.getBoundingClientRect();
      const node = Array.from(p.querySelectorAll(".otk-text p")).find((e) => {
        const r = e.getBoundingClientRect();
        return r.top >= bounds.top && r.bottom <= bounds.bottom;
      })!;
      return {
        message: node.closest("[data-message]")!.getAttribute("data-message"),
        key: node.closest("[data-virtual-key]")!.getAttribute(
          "data-virtual-key",
        ),
        top: node.getBoundingClientRect().top - bounds.top,
      };
    });
    const sourceTop = () =>
      pane.evaluate((p, source) => {
        const node = Array.from(p.querySelectorAll(".otk-text p")).find((e) =>
          e.closest("[data-message]")?.getAttribute("data-message") ===
            source.message &&
          e.closest("[data-virtual-key]")?.getAttribute("data-virtual-key") ===
            source.key
        );
        return node
          ? node.getBoundingClientRect().top - p.getBoundingClientRect().top
          : -Infinity;
      }, source);
    const requests =
      frames.sent.filter(({ frame }) => frame.method === "session.messages")
        .length;
    await jump.click();
    await jump.click();
    await throughDuration(300, async () => {
      expect(await sourceTop()).toBeCloseTo(source.top, 0);
    });
    expect(
      frames.sent.filter(({ frame }) => frame.method === "session.messages"),
    ).toHaveLength(requests);
    waitingWelcome = false;
    // Preserve protocol ordering: welcome precedes index and other frames too.
    // Only newest-page delivery remains held after the welcome is accepted.
    for (const held of frames.held.splice(0)) {
      if (
        held.frame.t === "load.chunk" ||
        held.request?.method === "session.messages"
      ) frames.held.push(held);
      else held.deliver();
    }
    await expect.poll(() =>
      frames.held.some(({ frame }) => frame.t === "load.chunk")
    ).toBe(true);
    await throughDuration(300, async () => {
      expect(await sourceTop()).toBeCloseTo(source.top, 0);
    });
    const rect = await pane.boundingBox();
    await page.mouse.move(rect!.x + 8, rect!.y + rect!.height / 2);
    await page.mouse.wheel(0, -48);
    frames.release();
    await expect(pane).toHaveAttribute("aria-busy", "false");
    await throughDuration(400, async () => {
      expect(await gap()).toBeGreaterThan(rect!.height);
      await expect(jump).toBeVisible();
    });
    await jump.click();
    await bottom();
  },
);

test("messages.jump-overlay-remains-at-bottom-without-a-composer", {
  tag: ["@messages", "@contracts"],
}, async ({ state, page }, info) => {
  const root = await state.native<{ id: string }>("/session", "POST", {
    title: "Parent",
  });
  const child = await state.native<{ id: string }>("/session", "POST", {
    title: "Read-only child",
    parentID: root.id,
  });
  await state.queue(["Child source.\n\n".repeat(180)]);
  await state.native(`/session/${child.id}/prompt_async`, "POST", {
    parts: [{ type: "text", text: "Inspect the child" }],
  });
  // The common opener explicitly waits for an editable root composer.
  await page.goto(`${state.url}/#/local/${child.id}`);
  await expect(page.locator("textarea[name=prompt]")).toHaveCount(0);
  const pane = page.getByRole("region", { name: "Transcript", exact: true });
  await expect(pane).toHaveAttribute("aria-busy", "false");
  await expect(pane).toContainText("Child source.");
  const rect = await pane.boundingBox();
  const session = await page.locator(".otk-session-view").boundingBox();
  expect(Math.abs(rect!.y + rect!.height - session!.y - session!.height))
    .toBeLessThanOrEqual(.5);
  await page.mouse.move(rect!.x + 8, rect!.y + rect!.height / 2);
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, -rect!.height / 2);
    await page.waitForTimeout(100);
  }
  const jump = page.locator(".otk-jump-slot").getByRole("button", {
    name: "Jump to latest",
    exact: true,
  });
  await expect(jump).toBeVisible();
  expect(await pane.boundingBox()).toEqual(rect);
  const geometry = await jump.evaluate((button) => ({
    footer: button.parentElement!.getBoundingClientRect().bottom,
    session:
      button.closest(".otk-session-view")!.getBoundingClientRect().bottom,
    inset: parseFloat(
      getComputedStyle(button.parentElement!)
        .getPropertyValue("--jump-bottom-inset"),
    ),
  }));
  expect(Math.abs(geometry.footer - geometry.session + geometry.inset))
    .toBeLessThanOrEqual(.5);
  await page.screenshot({ path: info.outputPath("child-jump.png") });
  await jump.click();
  await expect.poll(() =>
    pane.evaluate((p) => p.scrollHeight - p.clientHeight - p.scrollTop)
  ).toBeLessThanOrEqual(1);
});
