// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";

test(
  "sessions.native-qualified-identities-helper-cold-reload-and-canonical-route",
  { tag: ["@sessions"] },
  async ({ state, page }) => {
    const root = await state.product("session.create", {
      directory: state.directory,
      title: "Qualified identity smoke",
    });
    expect(root.id).toMatch(/^opcv1-ses_[A-Za-z0-9_-]+$/);
    const native =
      (await state.native<{ id: string; title: string }[]>("/session")).find(
        (s) => s.title === root.title,
      )!;
    expect(root.id).toBe(`opcv1-${native.id}`);
    const beforeBare =
      (await state.observe<{ frames: unknown[] }>()).frames.length;
    await expect(state.product("session.get", { sessionID: native.id })).rejects
      .toThrow();
    expect(
      (await state.observe<
        {
          frames: {
            t: string;
            error?: { code: string };
            outcome?: { ok: boolean; error?: { code: string } };
          }[];
        }
      >()).frames.slice(beforeBare).some((f) =>
        (f.t === "request.rejected" && f.error?.code === "request.params") ||
        (f.t === "request.result" && f.outcome?.ok === false &&
          f.outcome.error?.code === "request.params")
      ),
    ).toBe(true);
    const frames = await wire(page);
    await openSession(state, page, root.id);
    await state.queue(["Qualified session reply."]);
    await prompt(page, "Prove qualified native prompt delivery");
    await expect(page.locator(".otk-messages")).toContainText(
      "Qualified session reply.",
    );
    await expect(page.locator(`[data-session="${root.id}"]`)).toHaveAttribute(
      "data-status",
      "idle",
    );
    const helper = await state.native<{ id: string; nativeID: string }>(
      "/session",
      "POST",
      { parentID: native.id, title: "Helper created outside OTK" },
    );
    await state.native(`/session/${helper.id}/message`, "POST", {
      noReply: true,
      parts: [{ type: "text", text: "External helper transcript." }],
    });
    await page.locator(`[data-session="${helper.id}"]`).click();
    await expect(page.locator(".otk-messages")).toContainText(
      "External helper transcript.",
    );
    await expect(page).toHaveURL(
      new RegExp(`#/local/${root.id}/${helper.id}$`),
    );
    await page.reload();
    await expect(page.locator(".otk-subagent-bar")).toBeVisible();
    await expect(page.locator(".otk-messages")).toContainText(
      "External helper transcript.",
    );
    await expect(page).toHaveURL(
      new RegExp(`#/local/${root.id}/${helper.id}$`),
    );
    expect(
      (await state.product("session.get", { sessionID: helper.id })).parentID,
    ).toBe(root.id);
    await page.goto(`${state.url}/#/local/${root.id}`);
    await expect(page.locator(".otk-messages")).toContainText(
      "Qualified session reply.",
    );
    await page.goto(`${state.url}/#/local/${native.id}`);
    await expect(page.locator(".otk-global-error")).toHaveText(
      "This session link is from an older version. Open Sessions to choose a session.",
    );
    expect(
      frames.sent.some(({ frame }) =>
        frame.params?.sessionID === native.id || frame.sessionID === native.id
      ),
    ).toBe(false);
    await page.goto(`${state.url}/#/local/${root.id}`);
    await expect(page.locator(".otk-messages")).toContainText(
      "Qualified session reply.",
    );
    const ids = frames.sent.flatMap(({ frame }) => {
      const id = frame.sessionID ?? frame.params?.sessionID;
      return typeof id === "string" ? [id] : [];
    });
    expect(ids.every((id) => /^opcv1-[A-Za-z0-9_-]+$/.test(id))).toBe(true);
    const messages = await page.evaluate(async (url) => {
      const socket = new WebSocket(url.replace(/^http/, "ws") + "/api/ws");
      const messages: { t: string; code?: string }[] = [];
      return await new Promise<typeof messages>((resolve, reject) => {
        socket.addEventListener(
          "open",
          () => socket.send(JSON.stringify({ t: "hello", protocol: 13 })),
        );
        socket.addEventListener(
          "error",
          () => reject(new Error("Old protocol socket failed")),
        );
        socket.addEventListener("message", (e) => {
          const frame = JSON.parse(String(e.data));
          messages.push(frame);
          if (frame.t === "error" && frame.code === "protocol") {
            socket.close();
            resolve(messages);
          }
        });
      });
    }, state.url);
    expect(messages.some((f) => f.t === "error" && f.code === "protocol")).toBe(
      true,
    );
    expect(messages.some((f) => f.t === "welcome")).toBe(false);
  },
);
