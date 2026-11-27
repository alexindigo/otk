// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { send } from "../../pages/primary-action.ts";
import { revealTool, shellRun } from "../../pages/transcript.ts";

test.use({ profile: "messages-tools" });

test("composer.shells.terminate-one-native-job", {
  tag: ["@composer", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const v2 = state.controller.info!.version.startsWith("2.");
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Shell job owner",
  });
  const frames = await wire(page);
  await openSession(state, page, session.id);
  const command = "printf 'shell-job-started\\n'; exec sleep 90";
  await state.controller.call("queueScript", {
    lease: state.lease.lease,
    chunks: [],
    tool: {
      name: "bash",
      input: {
        command,
        description: "Run the long shell job",
        ...(v2 ? { background: true } : {}),
      },
    },
  });
  if (v2) {
    await state.queue(["The agent can continue."]);
    await state.queue(["Shell result received."]);
  }
  await state.native(`/session/${session.id}/prompt_async`, "POST", {
    parts: [{ type: "text", text: "Start a shell job" }],
  });

  const pill = page.getByRole("button", { name: "Running work: 1 shell" });
  const list = page.getByRole("list", { name: "Running shells" });
  if (!v2) {
    // V1's agent shell is a tool inside the turn, not a separately managed job.
    await revealTool(page, shellRun(state, "running"));
    await expect(page.locator(shellRun(state, "running"))).toBeVisible();
    await expect(pill).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Terminate / }))
      .toHaveCount(0);
    await expect(send(page)).toHaveAccessibleName("Stop");
    await send(page).click();
    await expect(send(page)).toHaveAccessibleName("Send");
    return;
  }

  await expect(page.getByText("The agent can continue.", { exact: true }))
    .toBeVisible();
  await expect(send(page)).toHaveAccessibleName("Send");
  await pill.click();
  const row = list.getByRole("listitem");
  await expect(row).toHaveCount(1);
  const terminate = row.getByRole("button", { name: `Terminate ${command}` });
  await expect(terminate).toBeVisible();
  await expect(terminate).toHaveAttribute("title", `Terminate ${command}`);
  const shellID = (await row.getAttribute("data-running-work"))!.slice(
    "shell/".length,
  );
  await terminate.focus();
  await terminate.press("Enter");
  await expect.poll(() =>
    frames.sent.filter(({ frame }) => frame.method === "shell.terminate").map(
      ({ frame }) => frame.params,
    )
  ).toEqual([{ sessionID: session.id, shellID }]);
  await expect(row).toHaveCount(0);
  await expect(list).toHaveCount(0);
  await expect(pill).toHaveCount(0);
  await expect(page.locator(".otk-composer-activity")).toBeFocused();
  await expect(page.getByText("Shell result received.", { exact: true }))
    .toBeVisible();
  expect(frames.sent.some(({ frame }) => frame.method === "session.abort"))
    .toBe(false);
});
