// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { isolatedTest } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import type { TestState } from "../../fixtures/test-state.ts";
import { messages, readyChips, upload } from "../../pages/composer.ts";

async function waitForProvider(state: TestState, prompt: string) {
  await expect.poll(async () => {
    const { requests } = await state.observe<{ requests: unknown[] }>();
    return requests.some((request) => {
      const body = JSON.stringify(request);
      return body.includes(prompt) &&
        !body.includes("Generate a title for this conversation:");
    });
  }).toBe(true);
}

for (const activation of ["button", "escape", "slash", "palette"] as const) {
  test(`composer.stop-running-${activation}`, {
    tag: ["@composer", "@messages"],
  }, async ({ state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Stop this response",
    });
    const frames = await wire(page);
    await openSession(state, page, session.id);
    const held = await state.queue(["A held reply"], "held");
    const input = page.locator("textarea[name=prompt]");
    await input.fill("Start a response");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    await expect(stop).toBeEnabled();
    await expect(page.locator(`[data-session="${session.id}"]`))
      .toHaveAttribute("data-status", "busy");
    await waitForProvider(state, "Start a response");
    await input.press("Enter");
    expect(frames.sent.filter(({ frame }) => frame.method === "session.prompt"))
      .toHaveLength(1);
    if (activation === "button") await stop.click();
    else if (activation === "escape") {
      await input.press("Escape");
      await input.press("Escape");
    } else if (activation === "slash") {
      await input.fill("/interrupt");
      await expect(page.getByText("/interrupt", { exact: true })).toBeVisible();
      await input.press("Enter");
    } else {
      await page.keyboard.press("Control+k");
      await page.getByText("Interrupt session", { exact: true }).click();
    }
    await expect.poll(() =>
      frames.sent.filter(({ frame }) => frame.method === "session.abort").length
    ).toBeGreaterThan(0);
    await expect.poll(async () =>
      JSON.stringify(await messages(state, session.id))
    )
      .toMatch(/Abort|interrupt/i);
    await state.release(held.gate);
    await expect(page.getByRole("button", { name: "Send", exact: true }))
      .toBeDisabled();
  });
}

for (const newer of [false, true]) {
  test(
    newer
      ? "composer.stop-keeps-newer-draft"
      : "composer.stop-queued-behind-running",
    {
      tag: ["@composer", "@messages"],
    },
    async ({ state, page }) => {
      const session = await state.native<{ id: string }>("/session", "POST", {
        title: "Queued draft custody",
      });
      const frames = await wire(page);
      await openSession(state, page, session.id);
      const held = await state.queue(["A held reply"], "held");
      const input = page.locator("textarea[name=prompt]");
      const send = page.getByRole("button", { name: "Send", exact: true });
      const stop = page.getByRole("button", { name: "Stop", exact: true });
      await input.fill("Start a response");
      await send.click();
      await expect(page.locator(`[data-session="${session.id}"]`))
        .toHaveAttribute(
          "data-status",
          "busy",
        );
      await waitForProvider(state, "Start a response");
      frames.hold((frame, request) =>
        frame.t === "request.result" && request?.method === "session.prompt"
      );
      await input.fill("Keep this draft after Stop");
      if (!newer) {
        const bytes = await page.evaluate(() => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 16;
          return canvas.toDataURL("image/png").split(",")[1];
        });
        await upload(page, [{
          name: "stop.png",
          mime: "image/png",
          bytes,
        }]);
        await expect(readyChips(page)).toHaveCount(1);
      }
      await send.click();
      await expect(input).toHaveValue("");
      await expect(stop).toBeFocused();
      // The V1 async receipt can arrive before persistence. Prove there is a
      // queued message to withdraw while the first request still owns the run.
      if (state.controller.info!.version === "1.19.3") {
        await expect.poll(async () =>
          JSON.stringify(await messages(state, session.id))
        )
          .toContain("Keep this draft after Stop");
      }
      await stop.click();
      if (newer) await input.fill("A newer draft");
      frames.release();
      if (newer) {
        await expect(input).toHaveValue("A newer draft");
        await expect(
          page.getByText(
            "Stopped before it started. Draft kept separately: Keep this draft after Stop",
            { exact: true },
          ),
        ).toBeVisible();
        await page.getByRole("button", { name: "Recover draft" }).click();
      }
      await expect(input).toHaveValue("Keep this draft after Stop");
      if (!newer) {
        await expect(readyChips(page)).toHaveCount(1);
        await expect(
          page.getByText(
            "Stopped before it started. Your message is back in the composer.",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(send).toBeFocused();
      }
      await expect.poll(async () =>
        JSON.stringify(await state.native(`/session/${session.id}/message`))
      ).not.toContain("Keep this draft after Stop");
      await expect.poll(async () =>
        JSON.stringify(await messages(state, session.id))
      )
        .toMatch(/Abort|interrupt/i);
      await state.release(held.gate);
    },
  );
}

test(
  "composer.stop-other-client-run",
  { tag: ["@composer", "@messages"] },
  async ({ state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Native sender",
    });
    await openSession(state, page, session.id);
    const held = await state.queue(["Other client response"], "held");
    await state.native(`/session/${session.id}/prompt_async`, "POST", {
      parts: [{ type: "text", text: "Prompt from another client" }],
    });
    await waitForProvider(state, "Prompt from another client");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect.poll(async () =>
      JSON.stringify(await state.native(`/session/${session.id}/message`))
    ).toMatch(/Abort|interrupt/i);
    await state.release(held.gate);
    await expect(page.getByRole("button", { name: "Send", exact: true }))
      .toBeDisabled();
  },
);

test("composer.stop-race-started-during-stop", {
  tag: ["@composer", "@messages"],
}, async ({ state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Stop during promotion",
  });
  const frames = await wire(page);
  await openSession(state, page, session.id);
  const held = await state.queue(["Held until interrupted"], "held");
  // Hide admission and execution evidence until Stop is waiting for the receipt.
  const input = page.locator("textarea[name=prompt]");
  const send = page.getByRole("button", { name: "Send", exact: true });
  frames.hold((frame, request) =>
    request?.method === "session.prompt" || frame.t === "content" ||
    frame.t.startsWith("inbox.")
  );
  await input.fill("Prompt that starts during Stop");
  await send.click();
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await stop.click();
  await expect(stop).toHaveAttribute("aria-busy", "true");
  await waitForProvider(state, "Prompt that starts during Stop");
  frames.release();
  await expect.poll(async () =>
    JSON.stringify(await messages(state, session.id))
  )
    .toMatch(/Abort|interrupt/i);
  await state.release(held.gate);
  await expect(send).toBeDisabled();
  await expect(input).toHaveValue("");
  await expect(page.getByRole("button", { name: "Recover draft" })).toHaveCount(
    0,
  );
  expect(
    (await messages(state, session.id)).filter(({ info }) =>
      info.role === "user"
    ),
  )
    .toHaveLength(1);
});

test(
  "composer.stop-reconnect",
  { tag: ["@composer", "@messages"] },
  async ({ state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Reconnect during Send",
    });
    const frames = await wire(page);
    await openSession(state, page, session.id);
    const held = await state.queue(["Finish once reconnected"], "held");
    frames.hold((frame, request) =>
      request?.method === "session.prompt" || frame.t === "content" ||
      frame.t.startsWith("inbox.")
    );
    await page.locator("textarea[name=prompt]").fill("Held across reconnect");
    const send = page.getByRole("button", { name: "Send", exact: true });
    await send.click();
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    await expect(stop).toBeEnabled();
    await waitForProvider(state, "Held across reconnect");
    await page.context().setOffline(true);
    frames.close();
    await expect(stop).toBeDisabled();
    await expect(stop).toHaveAccessibleDescription("Reconnect to stop");
    frames.held.splice(0); // Do not replay frames into the closed socket.
    frames.release();
    await page.context().setOffline(false);
    await expect(stop).toBeEnabled();
    await state.release(held.gate);
    await expect(send).toBeDisabled();
  },
);

isolatedTest.describe("native sends with held receipts", () => {
  isolatedTest.use({ profile: "composer-submission" });
  for (const mode of ["slash", "shell"] as const) {
    isolatedTest(`composer.stop-while-rpc-held-${mode}`, {
      tag: ["@composer", "@messages", "@isolated"],
    }, async ({ isolatedState: state, page }) => {
      const session = await state.native<{ id: string }>("/session", "POST", {
        title: `Held ${mode}`,
      });
      const frames = await wire(page);
      await openSession(state, page, session.id);
      const input = page.locator("textarea[name=prompt]");
      const send = page.getByRole("button", { name: "Send", exact: true });
      const stop = page.getByRole("button", { name: "Stop", exact: true });
      const method = mode === "shell" ? "session.shell" : "session.command";
      const v2 = state.controller.info!.version === "2.2.6";
      const held = mode === "slash"
        ? await state.queue(["Probe response"], "held")
        : undefined;
      const command = `sleep ${v2 ? 4 : 60}; printf 'STOP-SHELL-FINISHED'`;
      if (mode === "shell") await input.press("!");
      await input.fill(mode === "slash" ? "/probe stop" : command);
      const box = await send.boundingBox();
      frames.hold((frame, request) =>
        request?.method === method || frame.t === "content"
      );
      await send.click();
      await expect(stop).toBeFocused();
      expect(await stop.boundingBox()).toEqual(box);
      await expect.poll(() =>
        frames.sent.some(({ frame }) => frame.method === method)
      ).toBe(true);
      // Native command execution can finish before the command RPC returns.
      // Only release the provider, not the reply frame held by the browser.
      if (held) await state.release(held.gate);
      if (mode === "shell" && !v2) {
        // V1 returns the receipt when the process finishes, not on spawn.
        await expect.poll(async () =>
          (await messages(state, session.id)).flatMap(({ parts }) => parts)
            .some(({ tool, state }) =>
              tool === "bash" && state?.status === "running"
            )
        ).toBe(true);
      } else {
        await expect.poll(() =>
          frames.held.some(({ request, frame }) =>
            request?.method === method && frame.t === "request.result"
          )
        ).toBe(true);
      }
      await expect(stop).toBeFocused();
      if (mode === "shell") await stop.click();
      frames.release();
      if (!held) {
        await expect.poll(async () => {
          const rows = await messages(state, session.id);
          // V2 records the background process separately from V1's bash tool.
          if (v2) {
            return /"output":"STOP-SHELL-FINISHED/.test(JSON.stringify(rows));
          }
          const shell = rows.flatMap(({ parts }) => parts).find(({ tool }) =>
            tool === "bash"
          );
          return !!shell?.state &&
            ["completed", "error"].includes(shell.state.status) &&
            !/"output":"STOP-SHELL-FINISHED/.test(JSON.stringify(shell));
        }).toBe(true);
        expect(frames.sent.filter(({ frame }) => frame.method === method))
          .toHaveLength(1);
        await expect(page.locator(`[data-session="${session.id}"]`))
          .toHaveAttribute("data-status", "idle");
        await expect(input).toHaveValue("");
        await expect(send).toBeDisabled();
      }
    });
  }
});
