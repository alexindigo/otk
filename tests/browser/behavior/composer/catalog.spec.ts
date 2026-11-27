// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { prompt, reply } from "../../pages/composer.ts";

test.use({ profile: "composer-catalog" });
test(
  "composer.cold-contexts-keyed-catalog-task-file-updates-without-rediscovery",
  { tag: ["@composer", "@isolated"] },
  async ({ isolatedState: state, page, browser }) => {
    test.setTimeout(120_000);
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Directory-owned choices",
    });
    const sibling = await state.native<{ id: string }>("/session", "POST", {
      title: "Shared directory",
    });
    const other = await state.newContext(browser), b = await other.newPage();
    const aFrames = await wire(page), bFrames = await wire(b);
    await openSession(state, page, session.id);
    await openSession(state, b, session.id);
    for (const target of [page, b]) {
      await prompt(target).fill("@candidate-229");
      await expect(target.locator(".otk-autocomplete")).toContainText(
        "candidate-229.txt",
      );
      await prompt(target).fill("");
      await expect(target.locator(".otk-autocomplete")).toHaveCount(0);
    }
    const choices = () =>
      aFrames.sent.filter(({ frame }) =>
        /^(?:catalogs\.|agents\.list|models\.list|commands\.list|resources\.list|find\.files|frecency\.list)/
          .test(String(frame.method))
      ).length;
    const fileWatches = () =>
      aFrames.sent.filter(({ frame }) =>
        frame.method === "catalogs.watch" && frame.params?.files === true
      ).map(({ frame }) => frame.ref!.key);
    const openMention = async (text: string) => {
      const count = fileWatches().length;
      await prompt(page).fill(text);
      await expect.poll(() => fileWatches().length).toBe(count + 1);
      return fileWatches().at(-1)!;
    };
    const released = (key: string) =>
      aFrames.sent.some(({ frame }) =>
        frame.t === "request.release" &&
        (frame.refs as { key: string }[]).some((ref) => ref.key === key)
      );
    // Issue 2.158: opening a mention acquires a file lease. Refine that
    // same token, rather than clearing/reopening it with Playwright fill().
    const editing = await openMention("@candidate-229");
    await expect(page.locator(".otk-autocomplete")).toContainText(
      "candidate-229.txt",
    );
    await expect.poll(() =>
      aFrames.sent.filter(({ frame }) =>
        frame.method === "catalogs.demand" &&
        (frame.params?.kinds as string[]).includes("files")
      ).length
    ).toBe(2);
    const before = choices();
    for (let i = 0; i < 100; i++) {
      await prompt(page).press("Backspace");
      await prompt(page).press(String(i % 10));
    }
    expect(choices()).toBe(before);
    expect(released(editing)).toBe(false);
    await prompt(page).fill("");
    await expect(page.locator(".otk-autocomplete")).toHaveCount(0);
    await expect.poll(() => released(editing)).toBe(true);
    await prompt(page).focus();
    for (let i = 0; i < 100; i++) await page.keyboard.press("Tab");
    expect(choices()).toBe(before);
    const selecting = await openMention("@candidate-229");
    await expect(page.locator(".otk-autocomplete")).toContainText(
      "candidate-229.txt",
    );
    for (const frames of [aFrames, bFrames]) {
      expect(frames.sent.filter(({ frame }) =>
        [
          "find.files",
          "agents.list",
          "models.list",
          "commands.list",
          "resources.list",
        ].includes(String(frame.method))
      )).toHaveLength(0);
    }
    await prompt(page).press("Enter");
    await expect(page.locator(".otk-prompt-chip")).toContainText(
      "candidate-229.txt",
    );
    await expect.poll(() => released(selecting)).toBe(true);
    await state.queue(["The complete catalog file reached the provider."]);
    await prompt(page).press("Enter");
    await reply(
      state,
      page,
      session.id,
      "The complete catalog file reached the provider.",
    );
    expect(
      JSON.stringify((await state.observe<{ requests: unknown[] }>()).requests),
    ).toContain("Candidate 229 provider content");
    const tasks = await state.product("tasks.list", {
      directory: state.directory,
    });
    const task = tasks.find((task) => task.sessions.includes(session.id))!;
    await state.product("tasks.rename", {
      id: task.id,
      name: "Shared keyed task",
    });
    await state.product("tasks.addSession", {
      id: task.id,
      sessionID: sibling.id,
    });
    for (const target of [page, b]) {
      await expect(target.locator(".otk-task-list")).toContainText(
        "Shared keyed task",
      );
    }
    const watchCount = fileWatches().length;
    for (const target of [page, b]) {
      await prompt(target).fill("@candidate-229");
      await expect(target.locator(".otk-autocomplete")).toContainText(
        "candidate-229.txt",
      );
    }
    expect(fileWatches()).toHaveLength(watchCount + 1);
    for (const frames of [aFrames, bFrames]) {
      await expect.poll(() => {
        const demand = frames.sent.filter(({ frame }) =>
          frame.method === "catalogs.demand" &&
          (frame.params?.kinds as string[]).includes("files")
        ).at(-1)?.frame;
        const observer = frames.sent.filter(({ frame }) =>
          frame.method === "catalogs.watch" && frame.params?.files === true
        ).at(-1)?.frame;
        return !!observer && !!demand &&
          frames.sent.findIndex(({ frame }) => frame === demand) >
            frames.sent.findIndex(({ frame }) => frame === observer) &&
          frames.received.some((frame) =>
            frame.t === "request.result" &&
            frame.ref?.key === demand.ref?.key &&
            (frame.outcome as { ok: boolean }).ok
          );
      }).toBe(true);
    }
    await state.controller.call("writeProjectFiles", {
      lease: state.lease.lease,
      files: { "catalog/after-watch.txt": "Watch update" },
    });
    for (const frames of [aFrames, bFrames]) {
      await expect.poll(() =>
        frames.received.some((frame) =>
          frame.t === "catalog.chunk" && frame.kind === "files" &&
          (frame.items as { path: string }[]).some(({ path }) =>
            path === "catalog/after-watch.txt"
          )
        )
      ).toBe(true);
    }
    for (const target of [page, b]) {
      // Keep the leading @ while changing the query. The observed update
      // must reach the picker's options without starting another file lease.
      const input = prompt(target);
      await input.press("End");
      for (const _ of "candidate-229") await input.press("Backspace");
      await target.keyboard.insertText("after-watch");
      await expect(target.locator(".otk-autocomplete")).toContainText(
        "after-watch.txt",
      );
    }
    // Only the four explicit mention lifetimes may acquire files again.
    expect(
      aFrames.sent.filter(({ frame }) => frame.method === "catalogs.watch")
        .map(({ frame }) => frame.params),
    ).toEqual([
      { directory: state.directory },
      ...Array.from(
        { length: 4 },
        () => ({ directory: state.directory, files: true }),
      ),
    ]);
    const afterMentions = choices();
    await prompt(page).fill("");
    await page.locator(".otk-agent-picker > button").click();
    await expect(page.locator(".otk-agent-picker .otk-picker-status button"))
      .toHaveText("Refresh");
    expect(choices()).toBe(afterMentions);
    await page.locator(".otk-agent-picker .otk-picker-status button").click();
    await expect.poll(() =>
      aFrames.sent.filter(({ frame }) => frame.method === "catalogs.refresh")
        .length
    ).toBe(1);
    await expect(page.locator(".otk-agent-picker [role=status]")).toHaveCount(
      0,
    );
    const baselines =
      (await state.observe<{ frames: { t: string; epoch?: number }[] }>())
        .frames.filter((frame) => frame.t === "inbox.snapshot");
    expect(baselines.length).toBeGreaterThan(0);
    expect(new Set(baselines.map((frame) => frame.epoch)).size).toBe(
      baselines.length,
    );
    await page.reload();
    await expect(page.locator(".otk-task-list")).toContainText(
      "Shared keyed task",
    );
    await expect(prompt(page)).toBeVisible();
  },
);
