// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { notificationTest as test } from "../../fixtures/notifications.ts";
import { openSession } from "../../fixtures/wire.ts";
import { returnAndClick } from "../../pages/window-focus.ts";
import { prompt } from "../../pages/transcript.ts";

const pointerWon = { presses: 1, focusedBeforePress: false };

for (const action of ["Attach files", "Edit prompt"] as const) {
  test(
    `composer.return-click-${action === "Attach files" ? "attach" : "edit"}`,
    {
      tag: "@composer",
    },
    async ({ isolatedState: state, page }) => {
      const { id } = await state.native<{ id: string }>("/session", "POST", {
        title: "Return to the composer",
      });
      await openSession(state, page, id);
      const button = page.getByRole("button", { name: action, exact: true });
      await expect(button).toBeEnabled();
      if (action === "Attach files") {
        const [chooser, input] = await Promise.all([
          page.waitForEvent("filechooser"),
          returnAndClick(button),
        ]);
        await chooser.setFiles({
          name: "return.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("Attached on the first click"),
        });
        await expect(page.getByTitle("return.txt", { exact: true }))
          .toBeVisible();
        expect(input).toEqual(pointerWon);
      } else {
        const input = await returnAndClick(button);
        await expect(page.getByRole("dialog", { name: action })).toBeVisible();
        expect(input).toEqual(pointerWon);
      }
    },
  );
}

test("messages.return-click-session-pill", {
  tag: ["@composer", "@messages"],
}, async ({ isolatedState: state, page }) => {
  const parent = await state.native<{ id: string }>("/session", "POST", {
    title: "Parent conversation",
  });
  const title = "Follow-up conversation";
  const child = await state.native<{ id: string }>("/session", "POST", {
    parentID: parent.id,
    title,
  });
  const raw = child.id.slice(child.id.indexOf("-") + 1);
  await openSession(state, page, parent.id);
  await state.queue([`Follow up in \`${raw}\`.`]);
  await prompt(page, "Which conversation should I open?");
  await expect(page.locator(".otk-turn-time")).toHaveText(/^Worked for /);
  const pill = page.locator('[data-role="assistant"]').getByRole("link", {
    name: title,
  });
  const input = await returnAndClick(pill);
  await expect(page).toHaveURL(new RegExp(`/${child.id}$`));
  expect(input).toEqual(pointerWon);
});

test.describe("project catalog", () => {
  test.use({ profile: "contract-sessions-catalog" });
  test("sessions.return-click-project", { tag: "@sessions" }, async ({
    isolatedState: state,
    page,
  }) => {
    const session = "tstv1-atmosphera";
    const { directory } = await state.product("session.get", {
      sessionID: session,
    });
    await openSession(state, page, "tstv1-otk");
    const project = page.locator(
      `[data-project=${JSON.stringify(directory)}] .otk-project-open`,
    );
    const input = await returnAndClick(project);
    await expect(page).toHaveURL(new RegExp(`/${session}$`));
    expect(input).toEqual(pointerWon);
  });
});
