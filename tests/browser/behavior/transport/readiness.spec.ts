// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { receivedPrompt } from "../../fixtures/provider.ts";

test("transport.created-before-index", {
  tag: ["@transport", "@readiness"],
}, async ({ state, page }) => {
  const seed = await state.native<{ id: string }>("/session", "POST", {
    title: "Existing project",
  });
  const frames = await wire(page);
  await openSession(state, page, seed.id);
  frames.hold((frame) =>
    frame.t === "index.patch" || frame.t === "index.snapshot"
  );
  await page.locator(".otk-project-tabs .otk-new-session").click();
  await expect(page).not.toHaveURL(new RegExp(`${seed.id}$`));
  const id = new URL(page.url()).hash.split("/").at(-1)!;
  const prompt = "Show the scripted markdown before index delivery";
  await state.queue([
    "# Streaming\n\n",
    "An incremental reply.\n\n",
    "- first\n- second\n\n",
    "```ts\nconst otk = 1;\n```\n",
  ]);
  await page.locator("textarea[name=prompt]").fill(prompt);
  await page.locator("textarea[name=prompt]").press("Enter");
  await expect(page.locator(".otk-text pre")).toHaveText("const otk = 1;\n");
  await expect.poll(async () =>
    receivedPrompt(
      (await state.observe<{ requests: unknown[] }>()).requests,
      prompt,
    )
  ).toBe(true);
  expect(frames.held.length).toBeGreaterThan(0);
  await expect(page.locator(`[data-session="${id}"]`)).toHaveCount(0);
  await expect(page.locator(".otk-prompt [role=alert]")).toHaveCount(0);
  expect(frames.sent.map(({ frame }) => frame.method)).toEqual(
    expect.arrayContaining(["tasks.create", "session.prompt"]),
  );
  frames.release();
  await expect(page.locator(`[data-session="${id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await expect(page.locator(`[data-crumb="${id}"]`)).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.locator(".otk-text pre")).toContainText("const otk = 1;");
});

test("transport.new-session-held-loads", {
  tag: ["@transport", "@readiness", "@menus", "@composer"],
}, async ({ state, page }) => {
  const seed = await state.native<{ id: string }>("/session", "POST", {
    title: "New-session readiness",
  });
  const frames = await wire(page);
  await openSession(state, page, seed.id);
  let directory = false;
  const hold = () =>
    frames.hold((frame, request) =>
      frame.t === "index.patch" || frame.t === "index.snapshot" ||
      // Q5 publishes the coordinated page before its terminal result; both
      // deliveries must be held to preserve this missing-metadata setup.
      frame.t === "load.chunk" &&
        (frame.data as { kind?: string } | undefined)?.kind ===
          "message-page" ||
      frame.t === "request.result" &&
        (request?.method === "question.list" ||
          request?.method === "session.messages" ||
          directory && request?.method === "session.get")
    );
  for (const mode of ["slash", "palette pointer", "palette keyboard"]) {
    const before = frames.sent.filter(({ frame }) =>
      frame.method === "session.create"
    ).length;
    const previous = page.url();
    hold();
    await page.locator(".otk-project-tabs .otk-new-session").click();
    await expect(page).not.toHaveURL(previous);
    const pending = page.url(),
      pendingID = new URL(pending).hash.split("/").at(-1)!;
    await expect.poll(() =>
      frames.held.some(({ request }) =>
        request?.method === "session.messages" &&
        request.params?.sessionID === pendingID
      )
    ).toBe(true);
    const input = page.locator("textarea[name=prompt]");
    if (mode === "slash") {
      await input.fill("/new");
      await expect(page.locator(".otk-autocomplete")).toContainText("/new");
      await input.press("Enter");
    } else {
      await page.keyboard.press("Control+k");
      await expect(page.getByRole("dialog", { name: "Commands", exact: true }))
        .toBeVisible();
      await page.locator("input[name=command-search]").fill("New session");
      if (mode === "palette pointer") {
        await page.locator('[data-command="session.new"]').click();
      } else await page.keyboard.press("Enter");
    }
    await expect(page).not.toHaveURL(pending);
    const creates = frames.sent.filter(({ frame }) =>
      frame.method === "session.create"
    );
    expect(creates).toHaveLength(before + 2);
    expect(creates.at(-1)!.frame.params).toEqual({
      directory: state.directory,
    });
    expect(
      frames.sent.filter(({ frame }) =>
        frame.method === "session.get" && frame.params?.sessionID === pendingID
      ),
    ).toHaveLength(1);
    expect(frames.held.length).toBeGreaterThanOrEqual(2);
    await expect(page.locator(".otk-prompt [role=alert]")).toHaveCount(0);
    frames.release();
    await expect(page.getByRole("region", { name: "Transcript", exact: true }))
      .toHaveAttribute("aria-busy", "false");
  }
  expect(await state.native<unknown[]>("/session")).toHaveLength(7);
  const before = frames.sent.filter(({ frame }) =>
    frame.method === "session.create"
  ).length;
  const previous = page.url();
  hold();
  await page.locator(".otk-project-tabs .otk-new-session").click();
  await expect(page).not.toHaveURL(previous);
  await expect.poll(() => frames.held.length).toBeGreaterThanOrEqual(2);
  await page.locator("textarea[name=prompt]").fill("/new");
  await expect(page.locator(".otk-autocomplete")).toContainText("/new");
  directory = true;
  const gets =
    frames.sent.filter(({ frame }) => frame.method === "session.get").length;
  await page.locator("textarea[name=prompt]").press("Enter");
  await expect.poll(() =>
    frames.sent.filter(({ frame }) => frame.method === "session.get").length
  ).toBeGreaterThan(gets);
  // The later route belongs to a fresh document; replaying the old socket cannot steal it.
  await page.goto(`${state.url}/#/local/${seed.id}`);
  await expect(page.locator("textarea[name=prompt]")).toBeAttached();
  await page.locator("textarea[name=prompt]").fill(
    "Keep the newer session draft",
  );
  directory = false;
  frames.release();
  await expect(page).toHaveURL(new RegExp(`${seed.id}$`));
  await expect(page.locator("textarea[name=prompt]")).toHaveValue(
    "Keep the newer session draft",
  );
  expect(frames.sent.filter(({ frame }) => frame.method === "session.create"))
    .toHaveLength(before + 1);
  expect(await state.native<unknown[]>("/session")).toHaveLength(8);
});
