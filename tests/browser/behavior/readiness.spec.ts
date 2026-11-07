// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../fixtures/evidence.ts";
import { receivedPrompt } from "../fixtures/provider.ts";
import type { Page } from "@playwright/test";

/** Delay actual wire frames, never manufacture product outcomes. */
async function holdReadiness(page: Page, sessionID?: string) {
  let pages = true, inbox = true, catalog = true;
  const held: { kind: string; deliver(): void }[] = [];
  const reads = new Map<string, { method: string; sessionID?: string }>();
  await page.routeWebSocket("**/ws", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const frame = JSON.parse(message.toString());
      if (frame.t === "request") {
        reads.set(frame.ref.key, {
          method: frame.method,
          sessionID: frame.params?.sessionID,
        });
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const frame = JSON.parse(message.toString());
      // Q5 can deliver the atomic page before its terminal request result.
      const read = reads.get(frame.ref?.key ?? frame.request?.key);
      const kind = frame.t.startsWith("inbox.")
        ? "inbox"
        : frame.t.startsWith("catalog.") || read?.method === "catalogs.watch"
        ? "catalog"
        : read?.method === "session.messages" && read.sessionID === sessionID
        ? "page"
        : undefined;
      if (
        kind &&
        ((kind === "inbox" && inbox) || (kind === "catalog" && catalog) ||
          (kind === "page" && pages))
      ) {
        held.push({ kind, deliver: () => socket.send(message) });
      } else socket.send(message);
    });
  });
  return {
    held: (kind: string) => held.filter((frame) => frame.kind === kind).length,
    release(kind: string) {
      if (kind === "page") pages = false;
      if (kind === "inbox") inbox = false;
      if (kind === "catalog") catalog = false;
      for (let i = 0; i < held.length;) {
        if (held[i].kind === kind) held.splice(i, 1)[0].deliver();
        else i++;
      }
    },
  };
}

test("readiness.transcript-route", {
  tag: ["@readiness", "@transport", "@messages", "@sessions"],
}, async ({ state, page }, info) => {
  const a = await state.native<{ id: string }>("/session", "POST", {
    title: "Held transcript A",
  });
  const b = await state.native<{ id: string }>("/session", "POST", {
    title: "Independent transcript B",
  });
  await state.product("layout.patch", {
    rightCollapsed: false,
    rightView: "sessions",
  });
  const gate = await holdReadiness(page, a.id);
  gate.release("catalog");
  await page.goto(`${state.url}/#/local/${a.id}`);
  const session = page.getByRole("region", { name: "Session", exact: true });
  const transcript = page.getByRole("region", {
    name: "Transcript",
    exact: true,
  });
  await expect.poll(() => gate.held("page")).toBeGreaterThan(0);
  await expect(session).toHaveAttribute("aria-busy", "true");
  await expect(transcript).toHaveAttribute("aria-busy", "true");
  const sessions = page.getByRole("navigation", { name: "Project sessions" });
  await expect(sessions).toHaveAttribute("aria-busy", "true");
  await expect(sessions.getByRole("status")).toHaveText("Loading sessions...");
  await expect(sessions.getByText("No matching sessions")).toHaveCount(0);
  gate.release("inbox");
  await expect(
    sessions.getByRole("button", {
      name: /^Independent transcript B(?:,|$)/,
    }),
  ).toBeVisible();
  await page.locator("textarea[name=prompt]").fill("Retained A draft");
  await page.screenshot({
    path: info.outputPath("held-busy.png"),
    fullPage: true,
  });
  await sessions.getByRole("button", {
    name: /^Independent transcript B(?:,|$)/,
  }).click();
  await expect(page).toHaveURL(new RegExp(`${b.id}$`));
  await expect(transcript).toHaveAttribute("aria-busy", "false");
  await state.queue(["The independent route is current."]);
  const input = page.locator("textarea[name=prompt]");
  const prompt = "Trusted action while A initial page is held";
  await input.fill(prompt);
  await input.press("Enter");
  await expect.poll(async () =>
    receivedPrompt(
      (await state.observe<{ requests: unknown[] }>()).requests,
      prompt,
    )
  ).toBe(true);
  await expect(page.locator("[data-role=assistant] .otk-text")).toHaveText(
    "The independent route is current.",
  );
  await expect(session).toHaveAttribute("aria-busy", "false");
  await expect(page).toHaveURL(new RegExp(`${b.id}$`));
  gate.release("page");
  await page.screenshot({
    path: info.outputPath("settled-session.png"),
    fullPage: true,
  });
  await sessions.getByRole("button", { name: /^Held transcript A(?:,|$)/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`${a.id}$`));
  await expect(input).toHaveValue("Retained A draft");
  await expect(transcript).toHaveAttribute("aria-busy", "false");
});

test("readiness.catalog-input", {
  tag: ["@readiness", "@composer", "@transport"],
}, async ({ state, page }, info) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Catalog readiness",
  });
  const gate = await holdReadiness(page);
  gate.release("inbox");
  gate.release("page");
  await page.goto(`${state.url}/#/local/${session.id}`);
  await expect.poll(() => gate.held("catalog")).toBeGreaterThan(0);
  const composer = page.getByRole("form", { name: "Composer" });
  await expect(composer).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("region", { name: "Transcript", exact: true }))
    .toHaveAttribute("aria-busy", "false");
  const input = page.locator("textarea[name=prompt]");
  await input.fill("Editable while choices load");
  await expect(input).toHaveValue("Editable while choices load");
  await page.getByRole("button", { name: "Display options", exact: true })
    .click();
  await expect(page.locator(":popover-open")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(composer).toHaveAttribute("aria-busy", "true");
  await page.screenshot({
    path: info.outputPath("held-catalog.png"),
    fullPage: true,
  });
  gate.release("catalog");
  await expect(composer).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("button", { name: /^Model:/ })).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(page.getByRole("img", { name: /^Connected\./ })).toBeVisible();
  await state.queue(["Catalog choices settled for this session."]);
  await input.press("Enter");
  await expect.poll(async () =>
    receivedPrompt(
      (await state.observe<{ requests: unknown[] }>()).requests,
      "Editable while choices load",
    )
  ).toBe(true);
  await expect(page.locator("[data-role=assistant] .otk-text")).toHaveText(
    "Catalog choices settled for this session.",
  );
  await expect(composer).toHaveAttribute("aria-busy", "false");
});
