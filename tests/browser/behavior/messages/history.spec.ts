// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession } from "../../fixtures/wire.ts";
import { randomUUID } from "node:crypto";
import type { Json } from "../../../support/fixture-control.ts";
import { readFile } from "node:fs/promises";
import { wire } from "../../fixtures/wire.ts";
import { openWorkLogs, prompt, toolScript } from "../../pages/transcript.ts";
import { isolatedTest } from "../../fixtures/isolated.ts";

test(
  "messages.history-chips-compaction",
  { tag: ["@messages"] },
  async ({ state, page }) => {
    const v2 = state.controller.info!.version.startsWith("2.");
    const session = await state.native<{ id: string; nativeID: string }>(
      "/session",
      "POST",
      {
        title: "History details",
        ...(v2
          ? {
            messages: [{
              type: "user",
              text: "Historical parts",
              files: [{
                name: "fixture.txt",
                mime: "text/plain",
                data: "Zml4dHVyZQ==",
                source: { type: "uri", uri: "file:///fixture.txt" },
              }],
              agents: [{ name: "general" }],
            }, {
              type: "compaction",
              status: "completed",
              reason: "manual",
              summary: "",
            }],
          }
          : {}),
      },
    );
    if (!v2) {
      const message = await state.native<{ info: { id: string } }>(
        `/session/${session.id}/message`,
        "POST",
        {
          noReply: true,
          parts: [{ type: "text", text: "Historical parts" }],
        },
      );
      const parts: Record<string, Json>[] = [
        {
          type: "file",
          mime: "text/plain",
          filename: "fixture.txt",
          url: "file:///fixture.txt",
        },
        { type: "agent", name: "general" },
        { type: "compaction", auto: false },
      ];
      for (const value of parts) {
        const id = "prt_" + randomUUID().replaceAll("-", "");
        await state.native(
          `/session/${session.id}/message/${message.info.id}/part/${id}`,
          "PATCH",
          {
            id,
            sessionID: session.nativeID,
            messageID: message.info.id,
            ...value,
          },
        );
      }
    }
    await openSession(state, page, session.id);
    const transcript = page.getByRole("region", {
      name: "Transcript",
      exact: true,
    });
    await expect(transcript).toContainText("File: fixture.txt");
    await expect(transcript).toContainText("Agent: general");
    // V1 owns its compaction marker as a boundary record (NT4); V2 keeps the
    // typed divider. Either way it is visible and never inside the prompt bubble.
    const compaction = v2
      ? ".otk-compaction-divider"
      : '[data-native-record="opencode-v1/compaction"]';
    await expect(transcript.locator(compaction)).toBeVisible();
    await expect(transcript.locator(compaction)).toContainText(
      v2 ? /compact/i : "Session compaction",
    );
    await expect(transcript.locator(`.otk-user-bubble ${compaction}`))
      .toHaveCount(0);
    // Native PATCH part IDs are random. A marker may split this one message into
    // several bubbles; select the owner of the original bytes, never the first.
    await expect(
      transcript.locator(".otk-user-bubble").filter({
        hasText: "Historical parts",
      }),
    ).toHaveCount(1);
  },
);

test("messages.revert-files-counted-strip-reload", {
  tag: ["@messages", "@revert"],
}, async ({ state, page }) => {
  await state.controller.call("writeProjectFiles", {
    lease: state.lease.lease,
    files: { "revert.txt": "before\n" },
  });
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Revert rendering",
  });
  const frames = await wire(page);
  await openSession(state, page, session.id);
  await toolScript(state, "edit", {
    filePath: state.directory + "/revert.txt",
    oldString: "before",
    newString: "after",
  }, "Finished edit.");
  await prompt(page, "Run edit");
  await openWorkLogs(page);
  await expect(page.locator("[data-tool=edit][data-tool-status=completed]"))
    .toHaveCount(1);
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  expect(await readFile(state.directory + "/revert.txt", "utf8")).toBe(
    "after\n",
  );
  const raw = await state.native<{ info: { id: string; role: string } }[]>(
    `/session/${session.id}/message`,
  );
  const user = raw.find((message) => message.info.role === "user")!.info.id;
  await state.product(
    state.controller.info!.version.startsWith("2.")
      ? "session.revertCode"
      : "session.revert",
    {
      sessionID: session.id,
      messageID: user,
    },
  );
  await expect.poll(() =>
    frames.received.some((frame) => {
      const event = frame.event as
        | { op?: string; messageCount?: number }
        | undefined;
      const page = frame.outcome as {
        ok?: boolean;
        result?: { session?: { revert?: { messageCount: number } } };
      } | undefined;
      return frame.t === "content" && event?.op === "session.revert" &&
          event.messageCount === 1 ||
        page?.ok === true && page.result?.session?.revert?.messageCount === 1;
    })
  ).toBe(true);
  await expect(page.locator(".otk-rolled-back-strip")).toContainText(
    "1 prompt rolled back",
  );
  await expect(page.locator("[data-message]")).toHaveCount(0);
  await page.locator(".otk-rollback-disclosure").click();
  await expect(page.locator(".otk-rollback-details")).toContainText(
    "revert.txt",
  );
  expect(await readFile(state.directory + "/revert.txt", "utf8")).toBe(
    "before\n",
  );
  await page.reload();
  await expect(page.locator(".otk-rolled-back-strip")).toContainText(
    "1 prompt rolled back",
  );
  await expect(page.locator("[data-message]")).toHaveCount(0);
});

isolatedTest.describe("configured message details", () => {
  isolatedTest.use({ profile: "messages-native" });
  isolatedTest("messages.queued-answered-agent-details", {
    tag: ["@messages", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Message details",
    });
    await openSession(state, page, session.id);
    const reply = await state.controller.call<{ gate: string }>("queueScript", {
      lease: state.lease.lease,
      chunks: Array(20).fill("First reply continues. "),
      delay: 100,
      gate: "held",
    });
    await state.queue(["Queued prompt answered."]);
    await prompt(page, "First prompt");
    await expect(page.locator(`[data-session="${session.id}"]`))
      .toHaveAttribute("data-status", "busy");
    await expect(page.locator("[data-role=assistant] .otk-text"))
      .toBeAttached();
    await prompt(page, "Queued prompt");
    await expect(page.locator(".otk-queued")).toBeVisible();
    const agent = page.locator(".otk-message-agent");
    // Streaming can move the footer away from a stationary pointer. Keyboard
    // focus retains the same reveal state independently of that layout change.
    await agent.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(agent).toBeFocused();
    await expect(agent).toHaveCSS(
      "color",
      "rgb(107, 172, 255)",
    );
    await expect(page.locator("[data-role=user]").first()).toHaveCSS(
      "border-left-width",
      "0px",
    );
    await state.release(reply.gate);
    await expect(page.locator(`[data-session="${session.id}"]`))
      .toHaveAttribute("data-status", "idle", { timeout: 60_000 });
    await expect(page.locator(".otk-messages")).toContainText(
      "Queued prompt answered.",
    );
    await expect(page.locator(".otk-queued")).toHaveCount(0);
    await expect.poll(() =>
      page.locator(".otk-message-footer").evaluateAll((footers) =>
        footers.length > 0 &&
        footers.every((footer) =>
          footer.textContent!.includes("build") &&
          /\ds/.test(footer.textContent!)
        )
      )
    ).toBe(true);
    const footers = await page.locator(".otk-message-footer").allTextContents();
    expect(
      footers.every((footer) => footer.includes("build") && /\ds/.test(footer)),
    ).toBe(true);
    await expect(
      page.locator(".otk-messages p").filter({ hasText: /^(step|unknown)$/ }),
    ).toHaveCount(0);
    await expect(page.locator(".otk-message-footer .otk-copy-message svg"))
      .toHaveCount(footers.length);
  });
});
