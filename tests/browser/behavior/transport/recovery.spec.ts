// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { isolatedTest } from "../../fixtures/isolated.ts";
import { openSession, throughDuration, wire } from "../../fixtures/wire.ts";

test(
  "transport.live-reply",
  { tag: ["@transport", "@messages"] },
  async ({ state, page }) => {
    test.setTimeout(120_000);
    const a = await state.native<{ id: string }>("/session", "POST", {
      title: "Live reply A",
    });
    const b = await state.native<{ id: string }>("/session", "POST", {
      title: "Other session",
    });
    const c = await state.native<{ id: string }>("/session", "POST", {
      title: "Initially unwatched",
    });
    await openSession(state, page, a.id);
    const chunks = Array.from(
      { length: 32 },
      (_, i) => `chunk${String(i).padStart(2, "0")} `,
    );
    const gate = await state.controller.call<{ gate: string }>("queueScript", {
      lease: state.lease.lease,
      chunks,
      delay: 700,
      gate: "held",
    });
    await page.locator("textarea[name=prompt]").fill("Keep this live reply");
    await page.locator("textarea[name=prompt]").press("Enter");
    const text = page.locator("[data-role=assistant] .otk-text");
    await expect(text).toContainText("chunk03");
    const prefix = (await text.textContent())!.trim();
    await page.reload();
    await expect(text).toContainText(prefix);
    expect((await text.textContent())!.startsWith(prefix)).toBe(true);
    await expect(page.locator(`[data-session="${a.id}"]`)).toHaveAttribute(
      "data-status",
      "busy",
    );
    await openSession(state, page, b.id);
    await expect.poll(async () =>
      JSON.stringify(
        await state.product("session.messages", { sessionID: a.id }),
      )
    ).toContain("chunk08");
    expect(
      JSON.stringify(
        await state.product("session.messages", { sessionID: a.id }),
      ),
    ).toContain(prefix);
    await openSession(state, page, a.id);
    await expect(text).toContainText("chunk08");
    expect((await text.textContent())!.startsWith(prefix)).toBe(true);
    await state.release(gate.gate);
    await expect(text).toHaveText(chunks.join("").trim(), { timeout: 40_000 });
    await expect(page.locator(`[data-session="${a.id}"]`)).toHaveAttribute(
      "data-status",
      "idle",
    );
    await openSession(state, page, b.id);
    const unwatched = Array.from(
      { length: 12 },
      (_, i) => `unwatched${String(i).padStart(2, "0")} `,
    );
    await state.controller.call("queueScript", {
      lease: state.lease.lease,
      chunks: unwatched,
      delay: 700,
    });
    await state.native(`/session/${c.id}/prompt_async`, "POST", {
      parts: [{ type: "text", text: "Start without a viewer" }],
    });
    await expect.poll(async () =>
      JSON.stringify(
        await state.product("session.messages", { sessionID: c.id }),
      )
    ).toContain("unwatched03");
    await openSession(state, page, c.id);
    await expect(text).toContainText("unwatched03");
    await expect(text).toHaveText(unwatched.join("").trim(), {
      timeout: 30_000,
    });
    await expect(page.locator(`[data-session="${c.id}"]`)).toHaveAttribute(
      "data-status",
      "idle",
    );
  },
);

test(
  "transport.heartbeat-75-seconds",
  { tag: ["@transport", "@duration"] },
  async ({ state, page }, info) => {
    test.setTimeout(180_000);
    const frames = await wire(page);
    await page.goto(state.url);
    await expect(page.locator(".otk-server-status[data-connection=local]"))
      .toHaveAttribute("title", /: connected;/);
    const initial = frames.connections();
    const elapsed = await throughDuration(75_000, async () => {
      await expect(page.locator(".otk-server-status[data-connection=local]"))
        .toHaveAttribute("title", /: connected;/);
      expect(frames.connections()).toEqual(initial);
    });
    const pongs = frames.sent.filter(({ frame }) => frame.t === "pong");
    expect(pongs.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < pongs.length; i++) {
      expect(pongs[i].time - pongs[i - 1].time).toBeGreaterThan(19_000);
      expect(pongs[i].time - pongs[i - 1].time).toBeLessThan(21_000);
    }
    await info.attach("real-heartbeat", {
      body: JSON.stringify({
        elapsed,
        pongs,
        connections: frames.connections(),
      }),
      contentType: "application/json",
    });
  },
);

test(
  "transport.history-drafts",
  {
    tag: [
      "@transport",
      "@sessions",
      "@composer",
      "@smoke",
      "@smoke.navigation",
    ],
  },
  async ({ state, page }) => {
    const a = await state.native<{ id: string }>("/session", "POST", {
      title: "Draft A",
    });
    const b = await state.native<{ id: string }>("/session", "POST", {
      title: "Draft B",
    });
    await openSession(state, page, a.id);
    await openSession(state, page, b.id);
    const input = page.locator("textarea[name=prompt]");
    await input.fill("Unsent work");
    await expect(page.locator(".otk-prompt button[type=submit]")).toBeEnabled();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${a.id}$`));
    await expect(
      page.locator(".otk-session-crumb[aria-current] .otk-crumb-title"),
    ).toHaveText("Draft A");
    await expect(input).toHaveValue("");
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`${b.id}$`));
    await expect(
      page.locator(".otk-session-crumb[aria-current] .otk-crumb-title"),
    ).toHaveText("Draft B");
    await expect(input).toHaveValue("Unsent work");
    await page.getByRole("button", { name: "Edit prompt", exact: true })
      .click();
    const editor = page.locator("textarea[name=editor]");
    await editor.fill("Unsaved editor bytes");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${b.id}$`));
    await expect(editor).toHaveValue("Unsaved editor bytes");
    await page.locator(".otk-editor footer button").last().click();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${a.id}$`));
    await expect(input).toHaveValue("");
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`${b.id}$`));
    await expect(input).toHaveValue("Unsaved editor bytes");
  },
);

isolatedTest.describe("missed terminal recovery", () => {
  isolatedTest.use({ profile: "transport-restart" });
  isolatedTest("transport.sidecar-restart", {
    tag: ["@transport", "@isolated", "@messages"],
  }, async ({ isolatedState: state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Socket recovery",
    });
    const frames = await wire(page);
    let navigations = 0;
    page.on("framenavigated", () => navigations++);
    await openSession(state, page, session.id);
    const chunks = [
      "# Streaming\n\n",
      "An incremental reply.\n\n",
      "- first\n- second\n\n",
      "```ts\nconst otk = 1;\n```\n",
    ];
    const gate = await state.queue(chunks, "stepped");
    await page.locator("textarea[name=prompt]").fill(
      "Keep the session across reconnection",
    );
    await page.locator("textarea[name=prompt]").press("Enter");
    await state.release(gate.gate);
    await expect(page.locator("[data-role=assistant] .otk-text")).toContainText(
      "Streaming",
    );
    const before = navigations;
    await state.controller.call("restart", {
      lease: state.lease.lease,
      target: "sidecar",
    });
    await expect.poll(async () =>
      (await state.native<
        {
          info: { role: string; time: { completed?: number } };
          parts: unknown[];
        }[]
      >(`/session/${session.id}/message`)).some((row) =>
        row.info.role === "assistant" &&
        row.info.time.completed !== undefined &&
        JSON.stringify(row.parts).includes("const otk = 1;")
      )
    ).toBe(true);
    await expect(page.locator(".otk-server-status[data-connection=local]"))
      .toHaveAttribute("title", /: connected;/);
    await expect(page.locator(".otk-text pre")).toContainText("const otk = 1;");
    await expect(page.locator(`[data-session="${session.id}"]`))
      .toHaveAttribute(
        "data-status",
        "idle",
      );
    expect(
      frames.sent.filter(({ frame }) =>
        frame.t === "subscribe" && frame.sessionID === session.id
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(navigations).toBe(before);
  });
});
