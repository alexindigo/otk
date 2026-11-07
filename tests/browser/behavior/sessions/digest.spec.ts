// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { isolatedTest } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { hoverCompletedUsage, prompt } from "../../pages/transcript.ts";
import { contextMenu, sessionContext } from "../../pages/sessions.ts";

test(
  "sessions.native-summaries-lazy-detail-tombstone-retained-task-metadata-only",
  { tag: ["@sessions"] },
  async ({ state, page }) => {
    const s = await state.native<{ id: string; nativeID: string }>(
      "/session",
      "POST",
      { title: "Digest supervision" },
    );
    await state.product("tasks.create", {
      directory: state.directory,
      name: "Retained work",
      sessions: [s.id],
    });
    const frames = await wire(page);
    await openSession(state, page, s.id);
    await state.queue(["A digested reply."]);
    await prompt(page, "Keep this reply visible");
    await expect(page.locator(".otk-messages")).toContainText(
      "A digested reply.",
    );
    await expect(page.locator(`[data-session="${s.id}"]`)).toHaveAttribute(
      "data-status",
      "idle",
    );
    await expect(page.locator(`[data-session="${s.id}"] .otk-session-cost`))
      .toBeVisible();
    await expect(page.locator(".otk-turn-usage-trigger")).toContainText(
      "model call",
    );
    expect(frames.sent.filter(({ frame }) => frame.method === "usage.get"))
      .toHaveLength(0);
    await hoverCompletedUsage(page);
    await expect(page.locator(".otk-usage-breakdown tbody tr").first())
      .toBeVisible();
    expect(frames.sent.filter(({ frame }) => frame.method === "usage.get"))
      .toHaveLength(1);
    await page.keyboard.press("Escape");
    await page.locator("textarea[name=prompt]").fill(
      "Unsent draft survives deletion",
    );
    await state.product("permission.auto", { sessionID: s.id, enabled: true });
    await state.native(`/session/${s.id}`, "DELETE");
    await expect(page.locator(".otk-deleted-session")).toBeVisible();
    await expect(page.locator(".otk-prompt")).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`#\/local/${s.id}$`));
    expect(
      (await state.product("tasks.list", { directory: state.directory })).some((
        task,
      ) => task.sessions.includes(s.id)),
    ).toBe(true);
    await expect.poll(async () => {
      const o = await state.observe<
        { frames: { t: string; approvals?: { enabled: string[] } }[] }
      >();
      return o.frames.filter((f) => f.t === "approvals").at(-1)?.approvals
        ?.enabled
        .includes(s.id);
    }).toBe(false);
    await sessionContext(page, `[data-session="${s.id}"]`);
    const commands = await page.locator(`${contextMenu} [data-context-command]`)
      .evaluateAll((es) =>
        es.map((e) => (e as HTMLElement).dataset.contextCommand!)
      );
    expect(commands.filter((id) =>
      [
        "session.rename",
        "session.fork",
        "session.delete",
        "permission.auto",
        "task.add",
        "session.pin",
        "session.preview",
      ].includes(id)
    )).toEqual([]);
    expect(commands).toContain("session.task.remove");
    expect(commands).toContain("session.title.copy");
    await page.keyboard.press("Escape");
    const start = frames.sent.length;
    await page.reload();
    await expect(page.locator(".otk-deleted-session")).toBeVisible();
    await expect(page.locator("[data-role=assistant]")).toHaveCount(0);
    expect(
      frames.sent.slice(start).filter(({ frame }) =>
        frame.params?.sessionID === s.id &&
        [
          "session.get",
          "session.messages",
          "models.list",
          "usage.get",
          "permission.list",
          "question.list",
        ].includes(String(frame.method))
      ),
    ).toEqual([]);
    const removal = frames.sent.length;
    await page.locator(".otk-deleted-session").getByRole("button", {
      name: "Remove from task",
      exact: true,
    })
      .click();
    await expect(
      page.locator(`.otk-tab[data-preview="true"] [data-tab="${s.id}"]`),
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${s.id}$`));
    expect(
      frames.sent.slice(removal).filter(({ frame }) =>
        ["session.get", "session.messages", "usage.get"].includes(
          String(frame.method),
        )
      ),
    ).toEqual([]);
    await page.locator(".otk-deleted-session .otk-control-row button").last()
      .click();
    await expect(page.locator(".otk-deleted-session")).toHaveCount(0);
  },
);

isolatedTest.describe("dirty permission deletion", () => {
  isolatedTest.use({ profile: "sessions-tasks" });
  isolatedTest(
    "sessions.external-deletion-keeps-dirty-permission-normal-release-guard",
    { tag: ["@sessions", "@isolated"] },
    async ({ isolatedState: state, page }) => {
      const s = await state.native<{ id: string }>("/session", "POST", {
        title: "Unsent permission input",
      });
      await openSession(state, page, s.id);
      await state.controller.call("queueScript", {
        lease: state.lease.lease,
        chunks: [],
        tool: {
          name: "bash",
          input: { command: "pwd", description: "Read the project directory" },
        },
      });
      await prompt(page, "Ask before running pwd");
      await page.locator(".otk-rejection-reason").fill(
        "Keep my unsent permission feedback",
      );
      await state.native(`/session/${s.id}`, "DELETE");
      const details = page.locator(".otk-deleted-session");
      await expect(details).toContainText("Keep my unsent permission feedback");
      await expect(page.locator(".otk-permission-dock")).toHaveCount(0);
      page.once("dialog", (d) => d.dismiss());
      await details.locator(".otk-control-row button").last().click();
      await expect(page).toHaveURL(new RegExp(`${s.id}$`));
      await expect(details).toContainText("Keep my unsent permission feedback");
      page.once("dialog", (d) => d.accept());
      await details.locator(".otk-control-row button").last().click();
      await expect(details).toHaveCount(0);
    },
  );
});
