// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { chips, prompt, reply, sendPrompt } from "../../pages/composer.ts";

test.use({ profile: "composer-mentions" });
test("composer.empty-completion-preserves-enter-native-up-and-escape", {
  tag: ["@composer", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Empty completions",
  });
  const frames = await wire(page);
  await openSession(state, page, session.id);
  const query = "@otk_no_matching_file_927431";
  const ready = async () => {
    await expect.poll(() =>
      frames.received.some((frame) =>
        frame.t === "catalog.chunk" && frame.kind === "files" && frame.last
      )
    ).toBe(true);
    await expect(page.locator(".otk-autocomplete")).toHaveCount(0);
    expect(frames.sent.filter(({ frame }) => frame.method === "find.files"))
      .toHaveLength(0);
  };
  const held = await state.queue(["No-match prompt submitted."], "held");
  await prompt(page).fill(query);
  await ready();
  await prompt(page).press("Enter");
  await expect(page.locator("[data-role=user] .otk-text")).toContainText(query);
  await expect(prompt(page)).toHaveValue("");
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "busy",
  );
  await prompt(page).fill(query);
  await ready();
  await prompt(page).evaluate((element) => {
    Object.assign(globalThis, { emptyArrowPrevented: null });
    element.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "ArrowUp") {
        queueMicrotask(() =>
          Object.assign(globalThis, {
            emptyArrowPrevented: event.defaultPrevented,
          })
        );
      }
    }, { once: true });
  });
  await prompt(page).press("ArrowUp");
  await expect.poll(() =>
    page.evaluate(() =>
      (globalThis as unknown as { emptyArrowPrevented: boolean | null })
        .emptyArrowPrevented
    )
  ).toBe(false);
  await prompt(page).fill(query);
  await ready();
  await prompt(page).press("Escape");
  await expect(page.locator(".otk-prompt button[type=submit]")).toHaveAttribute(
    "title",
    "Esc again to interrupt",
  );
  await state.release(held.gate);
  await reply(state, page, session.id, "No-match prompt submitted.");
});
test("composer.native-file-range-agent-mcp-directory-frecency", {
  tag: ["@composer", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  test.setTimeout(120_000);
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Mentions",
  });
  const other = await state.native<{ id: string }>("/session", "POST", {
    title: "Frecency",
  });
  await openSession(state, page, session.id);
  await prompt(page).pressSequentially("@READ");
  await expect(page.locator(".otk-autocomplete")).toContainText("README.md");
  await prompt(page).press("Enter");
  await expect(chips(page)).toContainText("@README.md");
  await state.queue(["README received."]);
  await sendPrompt(page);
  await expect(page.locator("[data-role=user] .otk-chip")).toContainText(
    "README.md",
  );
  await expect(prompt(page)).toHaveValue("");
  await reply(state, page, session.id, "README received.");
  await openSession(state, page, other.id);
  await prompt(page).fill("@");
  await expect(page.locator(".otk-autocomplete button").first()).toContainText(
    "README.md",
  );
  await prompt(page).fill("@README.md#10-20");
  await expect(page.locator(".otk-autocomplete")).toContainText("#10-20");
  await prompt(page).press("Enter");
  await expect(chips(page)).toContainText("#10-20");
  await state.queue(["Range received."]);
  await sendPrompt(page);
  await expect(page.locator("[data-role=user] .otk-chip")).toContainText(
    "#10-20",
  );
  await expect(prompt(page)).toHaveValue("");
  await reply(state, page, other.id, "Range received.");
  await prompt(page).fill("@docs");
  await expect(page.locator(".otk-autocomplete")).toContainText("docs/");
  await prompt(page).press("Tab");
  await expect(prompt(page)).toHaveValue("@docs/");
  await expect(page.locator(".otk-autocomplete")).toContainText("guide.md");
  await prompt(page).press("Escape");
  await prompt(page).fill("@explore");
  const v2 = state.controller.info!.version.startsWith("2.");
  await expect(page.locator(".otk-autocomplete")).toContainText(
    v2 ? "Explore" : "explore",
  );
  await prompt(page).press("Enter");
  await expect(chips(page)).toContainText(v2 ? "@Explore" : "@explore");
  await state.queue(["Agent mention received."]);
  await sendPrompt(page);
  await expect(
    page.locator("[data-role=user] .otk-chip").filter({
      hasText: "Agent: explore",
    }),
  ).toBeVisible();
  await reply(state, page, other.id, "Agent mention received.");
  await prompt(page).fill("@specification");
  if (v2) {
    // Addendum-1 #4: stock V2 has no MCP-resource attachment route.
    await expect(page.locator(".otk-autocomplete")).toHaveCount(0);
    await expect(chips(page)).toHaveCount(0);
    expect(
      (await state.observe<{ mcpRequests: { method: string }[] }>()).mcpRequests
        .filter((request) => request.method === "resources/read"),
    ).toHaveLength(0);
  } else {
    await expect(page.locator(".otk-autocomplete")).toContainText(
      "specification",
    );
    await prompt(page).press("Enter");
    await expect(chips(page)).toContainText("@specification");
    await state.queue(["MCP resource received."]);
    await sendPrompt(page);
    await expect(
      page.locator("[data-role=user] .otk-text").filter({
        hasText: "@specification",
      }),
    ).toBeVisible();
    await expect(prompt(page)).toHaveValue("");
    await reply(state, page, other.id, "MCP resource received.");
    const observation = await state.observe<
      { requests: { messages: unknown }[]; mcpRequests: { method: string }[] }
    >();
    expect(
      observation.requests.some((request) =>
        JSON.stringify(request.messages).includes(
          "MCP fixture specification bytes",
        )
      ),
    ).toBe(true);
    expect(
      observation.mcpRequests.some((request) =>
        request.method === "resources/read"
      ),
    ).toBe(true);
  }
  await page.reload();
  await prompt(page).fill("@");
  await expect(page.locator(".otk-autocomplete button").first()).toContainText(
    "README.md",
  );
});
