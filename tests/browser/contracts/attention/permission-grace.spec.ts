// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { seed, tool } from "../../pages/attention.ts";

test.use({ profile: "isolated", timezoneId: "America/Los_Angeles" });
for (const motion of ["on", "system", "preference"] as const) {
  for (const settle of [false, true]) {
    test(
      `attention.permission-grace-${motion}-${
        settle ? "settled" : "persistent"
      }`,
      {
        tag: ["@attention", "@composer", "@sessions"],
      },
      async ({ isolatedState: state, page }, info) => {
        await page.emulateMedia({
          reducedMotion: motion === "system" ? "reduce" : "no-preference",
        });
        await state.product("prefs.set", {
          key: "animationsOff",
          value: motion === "preference",
        });
        const session = await seed(state, "Permission grace owner");
        const frames = await wire(page);
        await openSession(state, page, session.id);
        const metadata = await state.product("session.get", {
          sessionID: session.id,
        });
        const epoch = new Date("2000-01-01T00:00:00Z");
        await page.clock.install({ time: epoch });
        await page.clock.pauseAt(new Date(epoch.getTime() + 1000));
        // Hold genuine native publications, then deliver them at a controlled
        // browser instant. Provider/native clocks keep running independently.
        frames.hold(() => true);
        await tool(state, "bash", {
          command: "printf sv3-permission-grace",
          description: "Permission grace probe",
        });
        await state.queue(["Permission grace finished"]);
        await state.native(`/session/${session.id}/prompt_async`, "POST", {
          parts: [{ type: "text", text: "Run the permission grace probe" }],
        });
        await expect.poll(() =>
          frames.held.some(({ frame }) =>
            frame.t === "content" &&
            (frame.event as { op?: string })?.op === "permission.upsert"
          )
        ).toBe(true);
        const permissions = await state.product("permission.list", {
          sessionID: session.id,
        });
        expect(permissions).toHaveLength(1);
        const start = await page.evaluate(() => Date.now());
        frames.release();
        const row = page.locator(`[data-session="${session.id}"]`);
        await expect.poll(async () => {
          await page.clock.runFor(1);
          return await row.textContent();
        }).toContain("P 1");
        const elapsed = await page.evaluate(() => Date.now()) - start;
        expect(elapsed).toBeLessThan(400);
        await page.clock.runFor(400 - elapsed);
        await expect(page.locator(".otk-permission-dock")).toHaveCount(0);
        await expect(page.locator("textarea[name=prompt]")).toBeVisible();
        if (motion === "on" && !settle) {
          await page.screenshot({
            path: info.outputPath("sv3-during-grace.png"),
          });
        }
        const lamps = [
          row.locator(".otk-status-light"),
          page.locator(`[data-tab="${session.id}"] .otk-status-light`),
          page.locator(`[data-crumb="${session.id}"] .otk-status-light`),
          page.locator(
            `[data-server="local"][data-project=${
              JSON.stringify(metadata.directory)
            }] .otk-project-marker .otk-status-light`,
          ),
        ];
        for (const lamp of lamps) {
          if (motion === "on") {
            await expect(lamp).toHaveAttribute("data-state", "blocked");
          } else {await expect(lamp).not.toHaveAttribute(
              "data-state",
              "blocked",
            );}
        }
        // The routing owner reserves this request for the open composer even
        // during grace: no duplicate toast may escape through the delay.
        await expect(
          page.locator(".otk-toast").getByRole("button", {
            name: "Allow once",
            exact: true,
          }),
        ).toHaveCount(0);
        if (settle) {
          await state.product("permission.reply", {
            sessionID: session.id,
            requestID: permissions[0].id,
            reply: "once",
          });
          await expect.poll(() =>
            frames.received.some((frame) =>
              frame.t === "content" &&
              (frame.event as { op?: string })?.op === "permission.remove"
            )
          ).toBe(true);
          await page.clock.runFor(200);
          await expect(page.locator(".otk-permission-dock")).toHaveCount(0);
          for (const lamp of lamps) {
            await expect(lamp).not.toHaveAttribute("data-state", "blocked");
          }
        } else {
          await page.clock.runFor(120);
          await expect(page.locator(".otk-permission-dock")).toBeVisible();
          for (const lamp of lamps) {
            await expect(lamp).toHaveAttribute("data-state", "blocked");
          }
          await expect(page.locator("textarea[name=prompt]")).toBeHidden();
          if (motion === "on") {
            for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
              await state.product("prefs.set", { key: "theme", value: theme });
              await expect.poll(async () => {
                await page.clock.runFor(32);
                return await page.locator("html").getAttribute(
                  "data-otk-theme",
                );
              }).toBe(theme);
              await page.screenshot({
                path: info.outputPath(`sv3-${theme}.png`),
              });
            }
          }
          await state.product("permission.reply", {
            sessionID: session.id,
            requestID: permissions[0].id,
            reply: "once",
          });
        }
        await expect.poll(async () =>
          (await state.native<{ parts: { text?: string }[] }[]>(
            `/session/${session.id}/message`,
          ))
            .some((message) =>
              message.parts.some((part) =>
                part.text === "Permission grace finished"
              )
            )
        ).toBe(true);
      },
    );
  }
}
