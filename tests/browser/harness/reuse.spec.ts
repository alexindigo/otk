// SPDX-License-Identifier: LGPL-3.0-only
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "../fixtures/evidence.ts";
import type { TestState } from "../fixtures/test-state.ts";
import type { Page } from "@playwright/test";
import type { Preferences } from "@otk/protocol";
import { receivedPrompt } from "../fixtures/provider.ts";

async function observer(state: TestState, page: Page) {
  expect(await state.product("prefs.get", {})).toEqual(state.lease.baseline);
  expect(await state.product("tasks.list", { directory: state.directory }))
    .toEqual([]);
  expect(
    await state.observe<
      { pending: number; active: number; requests: unknown[] }
    >(),
  ).toMatchObject({ pending: 0, active: 0, requests: [] });
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Observer",
  });
  await page.goto(
    `${state.url}/#/local/${session.id}`,
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-otk-theme",
    "otk-dark",
  );
  await state.queue(["Pristine observer reply"]);
  await page.locator("textarea[name=prompt]").fill("Observer trusted prompt");
  await page.locator("textarea[name=prompt]").press("Enter");
  await expect(page.locator("[data-role=assistant] .otk-text")).toHaveText(
    "Pristine observer reply",
  );
  await expect.poll(async () =>
    receivedPrompt(
      (await state.observe<{ requests: unknown[] }>()).requests,
      "Observer trusted prompt",
    )
  ).toBe(true);
}

for (const order of ["forward", "reverse"]) {
  test.describe(`fixture reuse ${order}`, {
    tag: ["@fixture-acceptance", "@harness"],
  }, () => {
    test.describe.configure({ mode: "default" });
    for (
      const role of order === "forward"
        ? ["contaminator", "observer"]
        : ["observer", "contaminator", "observer-after"]
    ) {
      test(role, async ({ state, page, browser }, info) => {
        const ownership = join(
          process.env.OTK_TEST_RUN_ROOT!,
          `pair-${order}.json`,
        );
        if (role === (order === "forward" ? "contaminator" : "observer")) {
          await writeFile(
            ownership + ".staging",
            JSON.stringify({
              unit: state.controller.unit,
              directory: state.directory,
            }),
          );
          await rename(ownership + ".staging", ownership);
          const other = join(
            process.env.OTK_TEST_RUN_ROOT!,
            `pair-${order === "forward" ? "reverse" : "forward"}.json`,
          );
          await expect.poll(async () => {
            try {
              const peer = JSON.parse(await readFile(other, "utf8"));
              return peer.unit !== state.controller.unit &&
                peer.directory !== state.directory;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return false;
              }
              throw error;
            }
          }, {
            timeout: 30_000,
            message:
              "Two distinct worker namespaces must overlap before either pair proceeds",
          }).toBe(true);
        } else {
          const prior = JSON.parse(await readFile(ownership, "utf8"));
          expect(state.controller.unit).toBe(prior.unit);
          expect(state.directory).not.toBe(prior.directory);
        }
        if (role !== "contaminator") {
          await observer(state, page);
          return;
        }
        // Change every registered family through the normal product RPC owner.
        for (const [key, value] of Object.entries(state.lease.baseline)) {
          let changed = value;
          if (typeof value === "boolean") changed = !value;
          if (key === "theme") changed = "otk-light";
          if (key === "models.recent" || key === "models.favourite") {
            changed = [{ provider: "fake", model: "scripted" }];
          }
          if (key === "keymap") changed = { "session.new": "Ctrl+Alt+N" };
          if (key === "projectAgeing") changed = [1000, 2000, 3000];
          if (key === "shellLayout") {
            changed = {
              ...value as object,
              leftCollapsed: true,
              rightCollapsed: false,
            };
          }
          await state.product("prefs.set", {
            key: key as keyof Preferences,
            value: changed,
          });
        }
        const session = await state.native<{ id: string }>("/session", "POST", {
          title: "Contaminator",
        });
        const task = await state.product("tasks.create", {
          directory: state.directory,
          name: "Temporary",
          sessions: [session.id],
        });
        await state.product("tasks.rename", {
          id: task.id,
          name: "Renamed contamination",
        });
        await state.product("tasks.close", { id: task.id });
        await state.product("permission.auto", {
          sessionID: session.id,
          enabled: true,
        });
        // A context and a live held provider stream are deliberately left for owners.
        const context = await state.newContext(browser);
        {
          const second = await context.newPage();
          await second.goto(
            `${state.url}/#/local/${session.id}`,
          );
          await state.queue(["Held contaminator"], "held");
          await second.locator("textarea[name=prompt]").fill(
            "Held contamination prompt",
          );
          await second.locator("textarea[name=prompt]").press("Enter");
          await expect(second.locator("[data-role=assistant] .otk-text"))
            .toHaveText("Held contaminator");
          await expect.poll(() =>
            state.product("tasks.list", { directory: state.directory })
          ).toHaveLength(1);
          await info.attach("worker-reuse", {
            body: JSON.stringify({
              unit: state.controller.unit,
              directory: state.directory,
            }),
            contentType: "application/json",
          });
        }
      });
    }
  });
}
