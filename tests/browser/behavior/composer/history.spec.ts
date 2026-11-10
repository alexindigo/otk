// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { type Frame, openSession, wire } from "../../fixtures/wire.ts";
import { chips, prompt } from "../../pages/composer.ts";
import type { Json } from "../../../support/fixture-control.ts";
import type { Page } from "@playwright/test";

test.use({ profile: "composer-history" });
async function connect(page: Page, url: string) {
  await expect(page.locator(".otk-server-status[data-connection=local]"))
    .toHaveAttribute("title", /: connected;/);
  await page.locator(".otk-settings-entry").click();
  await page.locator("input[name=url]").fill(url);
  await page.locator("input[name=label]").fill("History remote sidecar");
  await page.locator(".otk-settings-content > .otk-form button[type=submit]")
    .click();
  await expect(page.locator(".otk-sidecar-card [data-connection]")).toHaveText([
    "connected",
    "connected",
  ]);
  await page.locator(".otk-settings .otk-view-header button").click();
}
test(
  "composer.project-scoped-time-ordered-recall-shell-dirty-guard-and-return",
  { tag: ["@composer", "@isolated"] },
  async ({ isolatedState: state, page }) => {
    const first = await state.native<{ id: string }>("/session", "POST", {
      title: "History local",
      messages: [{ parts: [{ type: "text", text: "local older prompt" }] }],
    });
    const blank = await state.native<{ id: string }>("/session", "POST", {
      title: "Blank",
    });
    await state.product("session.shell", {
      sessionID: first.id,
      command: "echo local-history-shell",
    });
    const remote = await state.controller.call<
      { url: string; session: { id: string } }
    >("auxiliary", { lease: state.lease.lease, kind: "remote-open" });
    const native = (path: string, body: Json) =>
      state.controller.call("nativeRequest", {
        lease: state.lease.lease,
        target: "remote",
        path,
        method: "POST",
        body,
      });
    await native(`/session/${remote.session.id}/shell`, {
      agent: "build",
      command: "echo remote-history-shell",
    });
    await native("/session", {
      title: "Remote newest history",
      messages: [{ parts: [{ type: "text", text: "remote newest prompt" }] }],
    });
    await page.goto(state.url);
    await connect(page, remote.url);
    await openSession(state, page, first.id);
    await prompt(page).press("ArrowUp");
    await expect(prompt(page)).toHaveValue("echo local-history-shell");
    await expect(page.locator(".otk-prompt > label")).toHaveText("Shell");
    await prompt(page).press("ArrowUp");
    await expect(prompt(page)).toHaveValue("local older prompt");
    await expect(page.locator(".otk-prompt > label")).toHaveText("Prompt");
    await prompt(page).pressSequentially("edited ");
    const edited = await prompt(page).inputValue();
    await prompt(page).press("Control+Home");
    await prompt(page).press("ArrowUp");
    await expect(prompt(page)).toHaveValue(edited);
    await prompt(page).fill("");
    await openSession(state, page, blank.id);
    await prompt(page).press("ArrowUp");
    await expect(prompt(page)).toHaveValue("echo local-history-shell");
    await prompt(page).press("Control+End");
    await prompt(page).press("ArrowDown");
    await expect(prompt(page)).toHaveValue("");
  },
);
test("composer.remote-image-recall-resolves-origin-bytes-only-on-send", {
  tag: ["@composer", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const bytes =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
  await state.native<{ id: string }>("/session", "POST", {
    title: "Recall image here",
  });
  const remote = await state.controller.call<
    { url: string; session: { id: string } }
  >("auxiliary", { lease: state.lease.lease, kind: "remote-open" });
  await state.controller.call("nativeRequest", {
    lease: state.lease.lease,
    target: "remote",
    path: "/session",
    method: "POST",
    body: {
      title: "Remote image source",
      messages: [{
        parts: [{ type: "text", text: "inspect [Image 1]" }, {
          type: "file",
          filename: "pixel.png",
          mime: "image/png",
          url: `data:image/png;base64,${bytes}`,
        }],
      }],
    },
  });
  const frames = await wire(page);
  await page.goto(state.url);
  await connect(page, remote.url);
  await page.locator("[data-server]:not([data-server=local]) .otk-project-open")
    .click();
  await page.getByRole("button", { name: "Open right panel", exact: true })
    .click();
  await page.locator(`[data-session="${remote.session.id}"]`).click();
  await expect(page.getByRole("region", { name: "Transcript", exact: true }))
    .toHaveAttribute("aria-busy", "false");
  await prompt(page).press("ArrowUp");
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page).locator("button").first()).toHaveText("[Image 1]");
  await expect(chips(page).locator("button").first()).toHaveAttribute(
    "title",
    "pixel.png",
  );
  expect(
    frames.sent.filter(({ frame }) => frame.method === "history.attachments"),
  ).toHaveLength(0);
  const historyKeys = new Set(
    frames.sent.filter(({ frame }) => frame.method === "history.list").map((
      { frame },
    ) => frame.ref!.key),
  );
  const histories = frames.received.filter((frame) =>
    frame.t === "request.result" && historyKeys.has(frame.ref?.key ?? "") &&
    (frame.outcome as { ok: boolean; value?: unknown } | undefined)?.ok
  );
  expect(histories.length).toBeGreaterThan(0);
  // The browser received only lazy metadata before the explicit send.
  expect(JSON.stringify(histories)).not.toContain(bytes);
  expect(JSON.stringify(histories)).not.toContain("dataBase64");
  await state.controller.call("queueScript", {
    lease: state.lease.lease,
    target: "remote",
    chunks: ["Remote image received."],
  });
  await prompt(page).press("Enter");
  await expect.poll(async () =>
    (await state.controller.call<
      { parts: { filename?: string; url?: string }[] }[]
    >("nativeRequest", {
      lease: state.lease.lease,
      target: "remote",
      path: `/session/${remote.session.id}/message`,
      method: "GET",
    })).flatMap((row) => row.parts).find((p) => p.filename === "pixel.png")?.url
  ).toBe(`data:image/png;base64,${bytes}`);
  await expect(page.getByText("Remote image received.", { exact: true }))
    .toBeVisible();
  const requests = frames.sent.filter(({ frame }) =>
    frame.method === "history.attachments"
  );
  expect(requests).toHaveLength(1);
  expect(typeof requests[0].frame.params).toBe("object");
  await expect(prompt(page)).toHaveValue("");
  await expect(chips(page)).toHaveCount(0);
});
test(
  "composer.local-recall-never-reads-an-unleased-connected-sibling",
  { tag: ["@composer", "@isolated"] },
  async ({ isolatedState: state, page }) => {
    await state.native<{ id: string }>("/session", "POST", {
      title: "History source",
      messages: [{ parts: [{ type: "text", text: "valid local history" }] }],
    });
    const blank = await state.native<{ id: string }>("/session", "POST", {
      title: "Recall here",
    });
    const remote = await state.controller.call<{ url: string }>("auxiliary", {
      lease: state.lease.lease,
      kind: "history-sibling",
    });
    await wire(page);
    await page.goto(state.url);
    await connect(page, remote.url);
    await page.locator(
      `[data-server=local][data-project=${JSON.stringify(state.directory)}]`,
    ).getByRole(
      "button",
      { name: / on This server$/ },
    ).click();
    await openSession(state, page, blank.id);
    const siblingSent: Frame[] = [];
    await page.routeWebSocket(
      remote.url.replace("http:", "ws:") + "/api/ws*",
      (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((message) => {
          const frame = JSON.parse(message.toString()) as Frame;
          siblingSent.push(frame);
          server.send(JSON.stringify(frame));
        });
        server.onMessage((message) => {
          socket.send(message);
        });
      },
    );
    // Routing precedes socket creation; reload observes the real sibling socket.
    await page.reload();
    await expect(prompt(page)).toBeVisible();
    await expect(page.getByRole("region", { name: "Transcript", exact: true }))
      .toHaveAttribute("aria-busy", "false");
    await prompt(page).press("ArrowUp");
    await expect(prompt(page)).toHaveValue("valid local history");
    expect(siblingSent.filter((frame) => frame.method === "history.list"))
      .toHaveLength(0);
  },
);
