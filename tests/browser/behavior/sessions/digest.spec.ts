// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { isolatedTest } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { hoverCompletedUsage, prompt } from "../../pages/transcript.ts";
import { contextMenu, sessionContext } from "../../pages/sessions.ts";

test(
  "sessions.native-summaries-lazy-detail-tombstone-retained-task-metadata-only",
  { tag: ["@sessions"] },
  async ({ state, page }, info) => {
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
    await info.attach("usage-acquisition", {
      body: JSON.stringify(frames),
      contentType: "application/json",
    });
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
    async ({ isolatedState: state, page }, info) => {
      const s = await state.native<{ id: string }>("/session", "POST", {
        title: "Unsent permission input",
      });
      const frames = await wire(page);
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
      const reason = "Keep my unsent permission feedback";
      await page.locator(".otk-rejection-reason").fill(reason);
      await state.native(`/session/${s.id}`, "DELETE");
      const deletion = frames.sent.length;
      const details = page.locator(".otk-deleted-session");
      await expect(details).toContainText(reason);
      for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
        await state.product("prefs.set", { key: "theme", value: theme });
        await expect(page.locator("html")).toHaveAttribute(
          "data-otk-theme",
          theme,
        );
        await info.attach(`deleted-retained-input-${theme}`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      }
      await expect(page.locator(".otk-permission-dock")).toHaveCount(0);
      const cdp = await page.context().newCDPSession(page);
      const nativeDialogs: string[] = [];
      // Observe without accepting or dismissing a native regression.
      cdp.on("Page.javascriptDialogOpening", ({ message }) => {
        nativeDialogs.push(message);
      });
      await cdp.send("Page.enable");
      const otkDialogs = page.getByRole("dialog");
      const closeButton = details.getByRole("button", {
        name: "Close session",
        exact: true,
      });
      const close = async () => {
        await closeButton.click();
        await expect(otkDialogs).toHaveCount(0);
        expect(nativeDialogs).toEqual([]);
        await expect(page).toHaveURL(/#project\//);
        await expect(details).toHaveCount(0);
        await expect(otkDialogs).toHaveCount(0);
        expect(nativeDialogs).toEqual([]);
      };
      await close();

      const row = page.getByRole("tabpanel", { name: "Sessions", exact: true })
        .locator(`[data-session="${s.id}"]`);
      await expect(row).toHaveClass(/is-deleted/);
      await expect(row.locator(".otk-sidebar-title-text")).toHaveCSS(
        "text-decoration-line",
        /line-through/,
      );
      const action = row.getByRole("button");
      await expect(action).toHaveAccessibleName(/^Deleted session, /);
      await action.click();
      const url = new RegExp(`${s.id}$`);
      const recover = details.getByRole("button", {
        name: "Recover draft",
        exact: true,
      });
      const discard = details.getByRole("button", {
        name: "Discard draft",
        exact: true,
      });
      const recovered = details.getByRole("textbox", {
        name: "Unsent draft",
        exact: true,
      });
      await expect(page).toHaveURL(url);
      await expect(recover).toBeVisible();
      await expect(discard).toBeVisible();
      await info.attach("deleted-draft-recovery-offer", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await expect(details.getByRole("region", {
        name: "Unsent permissions input",
        exact: true,
      })).toHaveCount(0);
      await page.reload();
      await expect(page).toHaveURL(url);
      await recover.click();
      await expect(recovered).toHaveValue(reason);
      await expect(recovered).not.toBeEditable();
      await expect(recover).toHaveCount(0);
      await expect(page.locator(".otk-permission-dock, .otk-prompt"))
        .toHaveCount(0);
      await expect(state.native(`/session/${s.id}`)).rejects.toThrow("404");
      await close();
      await action.click();
      await expect(recover).toHaveCount(1);
      await discard.click();
      await expect(recover).toHaveCount(0);
      await expect(discard).toHaveCount(0);
      await expect(details).not.toContainText(reason);
      await page.reload();
      await expect(page).toHaveURL(url);
      await expect(details).toBeVisible();
      await expect(details).not.toContainText(reason);
      await expect(recover).toHaveCount(0);
      expect(
        frames.sent.slice(deletion).filter(({ frame }) =>
          ["session.create", "session.prompt", "permission.reply"].includes(
            String(frame.method),
          )
        ),
      ).toEqual([]);
    },
  );
  isolatedTest(
    "sessions.confirmed-permission-input-is-not-retained-as-unsent-after-deletion",
    {
      tag: ["@sessions", "@isolated"],
    },
    async ({ isolatedState: state, page }) => {
      const session = await state.native<{ id: string }>("/session", "POST", {
        title: "Confirmed permission input",
      });
      await openSession(state, page, session.id);
      await state.controller.call("queueScript", {
        lease: state.lease.lease,
        chunks: [],
        tool: {
          name: "bash",
          input: {
            command: "pwd",
            description: "Request a permission response",
          },
        },
      });
      await state.queue(["Permission response completed."]);
      await prompt(page, "Ask before running pwd");
      await page.locator(".otk-rejection-reason").fill(
        "Submitted local feedback",
      );
      await page.getByRole("button", { name: "Reject", exact: true }).click();
      await page.getByRole("button", { name: "Reject request", exact: true })
        .click();
      await expect(page.locator(".otk-permission-dock")).toHaveCount(0);
      await expect(page.locator(".otk-messages")).toContainText(
        "Permission response completed.",
      );
      await state.native(`/session/${session.id}`, "DELETE");
      const details = page.locator(".otk-deleted-session");
      await expect(details).toBeVisible();
      await expect(details).not.toContainText("Unsent permissions input");
      await expect(details).not.toContainText("Submitted local feedback");
    },
  );
});
